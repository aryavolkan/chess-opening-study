// Background analysis: walks the opening book and deepens every position to
// a target depth, shallowest positions first. Results are stored through the
// same store the browser writes to, so both sides only ever improve on what
// is already there. The target can be raised at any time; positions that
// already meet it are skipped.

import { EventEmitter } from 'node:events';
import { loadEngine as defaultLoadEngine } from './engine.js';
import { fenFromEpd } from '../shared/fen.js';

export const DEFAULT_TARGET_DEPTH = 20;
export const DEFAULT_MULTIPV = 3;

export class Deepener extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./db.js').Store} opts.store
   * @param {{positions: Array<{epd:string, ply:number, san:string[]}>}} opts.book
   * @param {() => Promise<any>} [opts.loadEngine]
   */
  constructor({ store, book, loadEngine = defaultLoadEngine }) {
    super();
    this.store = store;
    this.book = book;
    this.loadEngine = loadEngine;
    this.engine = null;
    this.running = false;
    this.stopping = false;
    this.targetDepth = DEFAULT_TARGET_DEPTH;
    this.multipv = DEFAULT_MULTIPV;
    this.scope = []; // SAN prefix; empty = whole book
    this.queue = [];
    this.priority = [];
    this.current = null;
    this.analysed = 0;
    this.improved = 0;
    this.startedAt = null;
    this.lastResult = null;
    this.lastError = null;
    this.loop = null;
    this.restoreSettings();
  }

  restoreSettings() {
    const saved = this.store.getSetting('deepener');
    if (saved) {
      this.targetDepth = saved.targetDepth ?? this.targetDepth;
      this.multipv = saved.multipv ?? this.multipv;
      this.scope = saved.scope ?? this.scope;
      this.autoResume = Boolean(saved.running);
    }
  }

  persistSettings() {
    this.store.setSetting('deepener', {
      targetDepth: this.targetDepth,
      multipv: this.multipv,
      scope: this.scope,
      running: this.running,
    });
  }

  /** Unique book positions inside the scope, deepest-need first. */
  buildQueue() {
    const depths = this.store.depthMap();
    const seen = new Set();
    const items = [];
    for (const pos of this.book.positions) {
      if (!withinScope(pos.san, this.scope)) continue;
      if (seen.has(pos.epd)) continue;
      seen.add(pos.epd);
      const depth = depths.get(pos.epd) ?? 0;
      if (depth >= this.targetDepth) continue;
      items.push({ epd: pos.epd, ply: pos.ply, depth });
    }
    items.sort((a, b) => a.depth - b.depth || a.ply - b.ply);
    this.queue = items;
    this.total = seen.size;
  }

  /** Unique in-scope positions and how many already meet the target. */
  coverage() {
    const depths = this.store.depthMap();
    const seen = new Set();
    let atTarget = 0;
    for (const pos of this.book.positions) {
      if (!withinScope(pos.san, this.scope) || seen.has(pos.epd)) continue;
      seen.add(pos.epd);
      if ((depths.get(pos.epd) ?? 0) >= this.targetDepth) atTarget++;
    }
    return { total: seen.size, atTarget };
  }

  status() {
    let total;
    let done;
    if (this.running) {
      total = this.total;
      done = this.total - this.queue.length - (this.current ? 1 : 0);
    } else {
      ({ total, atTarget: done } = this.coverage());
    }
    return {
      running: this.running,
      stopping: this.stopping,
      targetDepth: this.targetDepth,
      multipv: this.multipv,
      scope: this.scope,
      engine: this.engine?.name ?? null,
      total,
      remaining: this.running ? this.queue.length + (this.current ? 1 : 0) : total - done,
      done: Math.max(0, done),
      current: this.current,
      analysed: this.analysed,
      improved: this.improved,
      startedAt: this.startedAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
    };
  }

  configure({ targetDepth, multipv, scope } = {}) {
    if (targetDepth !== undefined) {
      const d = Number(targetDepth);
      if (!Number.isInteger(d) || d < 1 || d > 60) throw new Error('targetDepth must be an integer between 1 and 60');
      this.targetDepth = d;
    }
    if (multipv !== undefined) {
      const m = Number(multipv);
      if (!Number.isInteger(m) || m < 1 || m > 10) throw new Error('multipv must be an integer between 1 and 10');
      this.multipv = m;
    }
    if (scope !== undefined) {
      if (!Array.isArray(scope) || !scope.every((s) => typeof s === 'string')) throw new Error('scope must be a SAN move list');
      this.scope = scope;
    }
    this.persistSettings();
    if (this.running) this.buildQueue();
  }

  async start(opts = {}) {
    this.configure(opts);
    if (this.running) return this.status();
    if (!this.engine) this.engine = await this.loadEngine();
    this.running = true;
    this.stopping = false;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    this.buildQueue();
    this.persistSettings();
    this.loop = this.run().catch((err) => {
      this.lastError = String(err?.message || err);
      this.running = false;
      this.persistSettings();
      this.emit('error', err);
    });
    return this.status();
  }

  async stop() {
    if (!this.running) return this.status();
    this.stopping = true;
    this.running = false;
    this.persistSettings();
    if (this.engine?.busy) this.engine.stop();
    await this.loop;
    this.stopping = false;
    this.current = null;
    return this.status();
  }

  /** Put positions at the front of the queue (e.g. what the user is viewing). */
  prioritize(epds) {
    const wanted = new Set(epds);
    const front = [];
    const rest = [];
    for (const item of this.queue) (wanted.has(item.epd) ? front : rest).push(item);
    const queued = new Set(front.map((i) => i.epd));
    for (const epd of epds) {
      if (queued.has(epd) || this.current?.epd === epd) continue;
      const depth = this.store.getAnalysis(epd)?.depth ?? 0;
      if (depth < this.targetDepth) front.push({ epd, ply: 0, depth });
    }
    this.queue = [...front, ...rest];
    if (this.total !== undefined) this.total = Math.max(this.total, this.queue.length + (this.current ? 1 : 0));
    return front.length;
  }

  /**
   * Shallowest positions in scope that a helper (e.g. a browser tab) could
   * deepen, skipping whatever the server engine is working on.
   */
  nextPositions(count, targetDepth = this.targetDepth) {
    const depths = this.store.depthMap();
    const seen = new Set();
    const items = [];
    for (const pos of this.book.positions) {
      if (!withinScope(pos.san, this.scope)) continue;
      if (seen.has(pos.epd) || pos.epd === this.current?.epd) continue;
      seen.add(pos.epd);
      const depth = depths.get(pos.epd) ?? 0;
      if (depth >= targetDepth) continue;
      items.push({ epd: pos.epd, ply: pos.ply, depth });
    }
    items.sort((a, b) => a.depth - b.depth || a.ply - b.ply);
    return items.slice(0, count);
  }

  async run() {
    while (this.running) {
      const item = this.queue.shift();
      if (!item) {
        this.running = false;
        this.persistSettings();
        this.emit('idle');
        break;
      }
      // The browser may have deepened this one in the meantime.
      const existing = this.store.getAnalysis(item.epd);
      if (existing && existing.depth >= this.targetDepth && existing.multipv >= this.multipv) continue;
      this.current = { epd: item.epd, depth: existing?.depth ?? 0, startedAt: Date.now() };
      const result = await this.engine.analyse(fenFromEpd(item.epd), { depth: this.targetDepth, multipv: this.multipv });
      this.analysed++;
      if (result.lines.length) {
        const saved = this.store.saveAnalysis({
          epd: item.epd,
          depth: result.depth,
          lines: result.lines,
          nodes: result.nodes,
          engine: result.engine,
          source: 'server',
        });
        if (saved.stored) this.improved++;
        this.lastResult = { epd: item.epd, depth: result.depth, stored: saved.stored, ms: Date.now() - this.current.startedAt };
        this.emit('result', this.lastResult);
      }
      this.current = null;
    }
    this.current = null;
  }
}

export function withinScope(san, scope) {
  if (!scope || scope.length === 0) return true;
  if (san.length < scope.length) return false;
  for (let i = 0; i < scope.length; i++) if (san[i] !== scope[i]) return false;
  return true;
}
