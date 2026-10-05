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
    this.loadWorkers();
    this.cleanup = setInterval(() => this.reapStale(), CLEANUP_MS);
    this.cleanup.unref?.();
  }

  loadWorkers() {
    const since = new Date(Date.now() - STALE_MS).toISOString();
    for (const row of this.store.listPublicWorkers(since)) {
      this.workers.set(row.token_hash, {
        hash: row.token_hash,
        token: null, // unknown because only the hash is stored
        name: row.name,
        createdAt: row.created_at,
        lastSeen: Date.parse(row.last_seen_at),
        positions: row.positions_done,
      });
    }
  }

  shutdown() {
    clearInterval(this.cleanup);
  }

  status() {
    const since = new Date(Date.now() - STALE_MS).toISOString();
    const active = this.store.listPublicWorkers(since).length;
    return {
      enabled: true,
      active,
      total: this.store.listPublicWorkers('1970-01-01T00:00:00Z').length,
      inflight: this.totalInflight,
      done: this.totalDone,
      apiUrl: null, // filled by app.js
    };
  }

  /** Register a new public worker and return its bearer token. */
  join({ name = null } = {}) {
    const token = randomBytes(32).toString('base64url');
    const hash = hashToken(token);
    const createdAt = new Date().toISOString();
    const worker = {
      hash,
      token,
      name: String(name || `worker-${hash.slice(0, 8)}`).slice(0, 50),
      createdAt,
      lastSeen: Date.now(),
      positions: 0,
    };
    this.store.createPublicWorker({ tokenHash: hash, name: worker.name, now: createdAt });
    this.workers.set(hash, worker);
    this.emit('join', worker);
    return { token, name: worker.name };
  }

  /** Find a worker by its bearer token. */
  workerForToken(token) {
    if (!token) return null;
    const hash = hashToken(token);
    const cached = this.workers.get(hash);
    if (cached) return cached;
    // Token may be from before a restart; load from DB if still fresh.
    const row = this.store.getPublicWorker(hash);
    if (!row) return null;
    if (Date.now() - Date.parse(row.last_seen_at) > STALE_MS) {
      this.store.removePublicWorker(hash);
      return null;
    }
    const worker = {
      hash,
      token,
      name: row.name,
      createdAt: row.created_at,
      lastSeen: Date.parse(row.last_seen_at),
      positions: row.positions_done,
    };
    this.workers.set(hash, worker);
    return worker;
  }

  touch(worker) {
    worker.lastSeen = Date.now();
    this.store.touchPublicWorker(worker.hash, { positionsDone: worker.positions });
  }

  /** Hand the next shallow position to a worker. */
  next(worker) {
    this.touch(worker);
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
    this.touch(worker);
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
    this.touch(worker);
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
    this.store.removePublicWorker(worker.hash);
    this.workers.delete(worker.hash);
    for (const [id, req] of this.requests) {
      if (req.workerHash === worker.hash) this.requests.delete(id);
    }
    return { ok: true };
  }

  reapStale() {
    const now = Date.now();
    const staleSince = new Date(now - STALE_MS).toISOString();
    for (const [hash, w] of this.workers) {
      if (now - w.lastSeen > STALE_MS) {
        this.store.removePublicWorker(hash);
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
    // Clean up any workers that disappeared without saying goodbye.
    for (const row of this.store.listPublicWorkers('1970-01-01T00:00:00Z')) {
      if (row.last_seen_at < staleSince && !this.workers.has(row.token_hash)) {
        this.store.removePublicWorker(row.token_hash);
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
