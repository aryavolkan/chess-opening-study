// Public worker pool: anyone can run a worker process that connects to the
// app, pulls shallow positions from the deepener queue, and pushes deeper
// analysis back. No account needed; workers authenticate with a token they
// get from /api/public-workers/join.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fenFromEpd } from '../shared/fen.js';

const DEFAULT_TARGET_DEPTH = 20;
const DEFAULT_MULTIPV = 3;
const STALE_MS = 5 * 60 * 1000; // reassign a position if the worker goes silent
const CLEANUP_MS = 60 * 1000;

export class PublicWorkerPool extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./db.js').Store} o.store
   * @param {import('./deepener.js').Deepener} o.deepener
   */
  constructor({ store, deepener }) {
    super();
    this.store = store;
    this.deepener = deepener;
    this.workers = new Map(); // tokenHash -> { name, createdAt, lastSeen, positions, token }
    this.requests = new Map(); // requestId -> { epd, depth, multipv, workerHash, issuedAt, progress }
    this.nextId = 1;
    this.totalDone = 0;
    this.totalInflight = 0;
    this.cleanup = setInterval(() => this.reapStale(), CLEANUP_MS);
    this.cleanup.unref?.();
  }

  shutdown() {
    clearInterval(this.cleanup);
  }

  status() {
    const now = Date.now();
    const active = [...this.workers.values()].filter((w) => now - w.lastSeen < STALE_MS).length;
    return {
      enabled: true,
      active,
      total: this.workers.size,
      inflight: this.totalInflight,
      done: this.totalDone,
      apiUrl: null, // filled by app.js
    };
  }

  /** Register a new public worker and return its bearer token. */
  join({ name = null } = {}) {
    const token = randomBytes(32).toString('base64url');
    const hash = hashToken(token);
    const worker = {
      hash,
      token,
      name: String(name || `worker-${hash.slice(0, 8)}`).slice(0, 50),
      createdAt: new Date().toISOString(),
      lastSeen: Date.now(),
      positions: 0,
    };
    this.workers.set(hash, worker);
    this.emit('join', worker);
    return { token, name: worker.name };
  }

  /** Find a worker by its bearer token. */
  workerForToken(token) {
    if (!token) return null;
    return this.workers.get(hashToken(token)) || null;
  }

  /** Hand the next shallow position to a worker. */
  next(worker) {
    worker.lastSeen = Date.now();
    const target = this.deepener?.targetDepth || DEFAULT_TARGET_DEPTH;
    const multipv = this.deepener?.multipv || DEFAULT_MULTIPV;
    const positions = this.deepener?.nextPositions?.(1, target) || [];
    if (!positions.length) return { stop: true, reason: 'no shallow positions right now' };
    const pos = positions[0];
    const id = this.nextId++;
    const req = {
      id,
      epd: pos.epd,
      depth: target,
      multipv,
      workerHash: worker.hash,
      issuedAt: Date.now(),
      progress: 0,
    };
    this.requests.set(id, req);
    this.totalInflight++;
    return { request: { id, fen: fenFromEpd(pos.epd), depth: target, multipv } };
  }

  progress(worker, { id, depth, lines, nodes }) {
    worker.lastSeen = Date.now();
    const req = this.requests.get(Number(id));
    if (!req || req.workerHash !== worker.hash) return { ok: false };
    req.progress = depth || req.progress;
    req.lastSeen = Date.now();
    if (Number.isInteger(depth) && depth > 0 && lines?.length) {
      this.store.saveAnalysis({
        epd: req.epd,
        depth,
        lines,
        nodes: numberOrNull(nodes),
        engine: worker.name,
        source: 'public-worker',
      });
    }
    return { ok: true };
  }

  result(worker, { id, depth, lines, nodes, engine, error }) {
    worker.lastSeen = Date.now();
    const req = this.requests.get(Number(id));
    if (!req || req.workerHash !== worker.hash) return { ok: false };
    this.requests.delete(Number(id));
    this.totalInflight = Math.max(0, this.totalInflight - 1);
    if (error) {
      this.emit('error', { worker: worker.name, id, error });
      return { ok: true };
    }
    if (!lines?.length) return { ok: true };
    const saved = this.store.saveAnalysis({
      epd: req.epd,
      depth,
      lines,
      nodes: numberOrNull(nodes),
      engine: engine ? String(engine).slice(0, 100) : worker.name,
      source: 'public-worker',
    });
    worker.positions++;
    this.totalDone++;
    this.emit('result', { worker: worker.name, epd: req.epd, depth, stored: saved.stored });
    return { ok: true, stored: saved.stored };
  }

  bye(worker) {
    this.workers.delete(worker.hash);
    for (const [id, req] of this.requests) {
      if (req.workerHash === worker.hash) this.requests.delete(id);
    }
    return { ok: true };
  }

  reapStale() {
    const now = Date.now();
    for (const [hash, w] of this.workers) {
      if (now - w.lastSeen > STALE_MS) {
        this.workers.delete(hash);
        for (const [id, req] of this.requests) {
          if (req.workerHash === hash) {
            this.requests.delete(id);
            this.totalInflight = Math.max(0, this.totalInflight - 1);
          }
        }
      }
    }
    for (const [id, req] of this.requests) {
      if (now - (req.lastSeen || req.issuedAt) > STALE_MS) {
        this.requests.delete(id);
        this.totalInflight = Math.max(0, this.totalInflight - 1);
      }
    }
  }
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
