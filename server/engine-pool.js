// A pool of engine workers. Each worker is a forked Node process running
// its own Stockfish (engine-worker.js); the Stockfish WASM build only
// initialises on a main thread, so processes stand in for threads. Requests
// are queued and handed to idle workers; a worker that dies is replaced.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpus } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, 'engine-worker.js');
export const MAX_WORKERS = Math.max(1, Math.min(16, cpus().length));

export class EnginePool {
  /**
   * @param {object} o
   * @param {number} o.size      number of workers
   * @param {string} [o.flavor]  engine build, see engine.js
   * @param {Function} [o.spawn] replacement for fork() in tests
   */
  constructor({ size = 1, flavor = process.env.STOCKFISH_FLAVOR, spawn = null } = {}) {
    this.size = clampWorkers(size);
    this.flavor = flavor;
    this.spawn = spawn || defaultSpawn;
    this.workers = [];
    this.queue = [];
    this.nextId = 1;
    this.running = false;
    this.name = null;
    this.restarts = 0;
    this.completed = 0;
  }

  /** Start the workers; resolves when every one has loaded its engine. */
  async start() {
    if (this.running) return;
    this.running = true;
    await Promise.all(Array.from({ length: this.size }, () => this.addWorker()));
  }

  /** Change the number of workers while running. */
  async resize(size) {
    this.size = clampWorkers(size);
    if (!this.running) return;
    while (this.workers.length > this.size) {
      const idle = this.workers.find((w) => !w.current) || this.workers[this.workers.length - 1];
      this.removeWorker(idle, new Error('pool resized'));
    }
    const adds = [];
    while (this.workers.length + adds.length < this.size) adds.push(this.addWorker());
    await Promise.all(adds);
  }

  addWorker() {
    const w = { child: null, current: null, ready: false };
    this.workers.push(w);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(WORKER, { flavor: this.flavor });
      } catch (err) {
        this.workers.splice(this.workers.indexOf(w), 1);
        reject(err);
        return;
      }
      w.child = child;
      const timer = setTimeout(() => {
        if (!w.ready) {
          this.removeWorker(w, new Error('engine worker did not start'));
          reject(new Error('engine worker did not start in time'));
        }
      }, 60000);
      child.on('message', (m) => {
        if (m.ready) {
          w.ready = true;
          this.name = m.name;
          clearTimeout(timer);
          resolve(w);
          this.pump();
          return;
        }
        if (w.current && m.id === w.current.id && m.progress) {
          w.current.onProgress?.(m.progress);
          return;
        }
        if (w.current && m.id === w.current.id) {
          const req = w.current;
          w.current = null;
          if (m.error) req.reject(new Error(m.error));
          else {
            this.completed++;
            req.resolve(m.result);
          }
          this.pump();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        if (!w.ready) reject(err);
        this.removeWorker(w, err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (!this.workers.includes(w)) return;
        const err = new Error(`engine worker exited (${code})`);
        if (!w.ready) reject(err);
        this.removeWorker(w, err);
        // Replace it, unless we are stopping or it keeps dying
        if (this.running && this.workers.length < this.size && this.restarts < 20) {
          this.restarts++;
          this.addWorker().catch(() => {});
        }
      });
    });
  }

  removeWorker(w, err) {
    const i = this.workers.indexOf(w);
    if (i >= 0) this.workers.splice(i, 1);
    if (w.current) {
      const req = w.current;
      w.current = null;
      req.reject(err || new Error('engine worker stopped'));
    }
    try { w.child?.kill(); } catch { /* already gone */ }
  }

  /** Hand queued requests to idle workers. */
  pump() {
    for (const w of this.workers) {
      if (!w.ready || w.current || !this.queue.length) continue;
      const req = this.queue.shift();
      w.current = req;
      w.child.send({ id: req.id, fen: req.fen, depth: req.depth, multipv: req.multipv, progress: Boolean(req.onProgress) });
    }
  }

  /** Analyse a position on the next free worker; onProgress(snapshot) is called as the depth grows. */
  analyse(fen, { depth = 14, multipv = 3, onProgress = null } = {}) {
    if (!this.running) return Promise.reject(new Error('engine pool is not running'));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, fen, depth, multipv, onProgress, resolve, reject });
      this.pump();
    });
  }

  /** Stop every worker; pending requests are rejected. */
  async stop() {
    this.running = false;
    const err = new Error('engine pool stopped');
    for (const req of this.queue.splice(0)) req.reject(err);
    for (const w of this.workers.slice()) this.removeWorker(w, err);
  }

  status() {
    return {
      running: this.running,
      size: this.size,
      workers: this.workers.length,
      busy: this.workers.filter((w) => w.current).length,
      queued: this.queue.length,
      completed: this.completed,
      engine: this.name,
    };
  }
}

export function clampWorkers(n) {
  const v = Number(n);
  if (!Number.isInteger(v)) return 1;
  return Math.max(1, Math.min(MAX_WORKERS, v));
}

function defaultSpawn(script, { flavor }) {
  return fork(script, [], {
    execArgv: ['--disable-warning=ExperimentalWarning'],
    env: { ...process.env, ...(flavor ? { STOCKFISH_FLAVOR: flavor } : {}) },
    serialization: 'json',
  });
}
