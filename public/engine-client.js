// Stockfish in a Web Worker with a small analyse() API. One search at a
// time; a new request stops the running one first. Lines that belong to an
// older search are ignored, so callers never see stale output.

import { SearchAccumulator, parseBestMove } from '/shared/uci.js';

export const ENGINE_URL = '/vendor/stockfish/stockfish-19-lite-single.js';

export class EngineClient {
  constructor(url = ENGINE_URL) {
    this.url = url;
    this.worker = null;
    this.readyPromise = null;
    this.generation = 0;
    this.search = null; // { gen, acc, onUpdate, resolve }
    this.name = 'stockfish';
    this.onStatus = () => {};
  }

  load() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      this.worker = worker;
      const timer = setTimeout(() => reject(new Error('engine did not answer uci in time')), 30000);
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error('engine worker failed: ' + (e.message || 'unknown error')));
      };
      worker.onmessage = (e) => {
        const line = typeof e.data === 'string' ? e.data : '';
        if (line.startsWith('id name')) this.name = line.slice(8).trim();
        if (line === 'uciok') {
          clearTimeout(timer);
          worker.onmessage = (ev) => this.handle(typeof ev.data === 'string' ? ev.data : '');
          worker.postMessage('setoption name UCI_ShowWDL value false');
          resolve(this);
        }
      };
      worker.postMessage('uci');
    });
    return this.readyPromise;
  }

  post(cmd) {
    this.worker.postMessage(cmd);
  }

  handle(line) {
    const s = this.search;
    if (!s) return;
    if (line.startsWith('bestmove')) {
      const best = parseBestMove(line);
      const snap = s.acc.snapshot();
      this.search = null;
      s.resolve({ ...snap, bestmove: best?.bestmove ?? null, stopped: s.stopped, engine: this.name });
      this.onStatus({ searching: false });
      return;
    }
    if (s.acc.push(line)) {
      s.onUpdate?.(s.acc.snapshot());
    }
  }

  /**
   * Analyse `fen` to `depth` with `multipv` lines. Resolves when the search
   * ends (depth reached or stop() called) with the final snapshot.
   */
  async analyse(fen, { depth = 24, multipv = 3, onUpdate } = {}) {
    await this.load();
    // Starts are serialised: a new search may only be sent once the previous
    // one has acknowledged its stop with a bestmove, otherwise the engine
    // receives a new position mid-search.
    let result;
    const started = (this.starting || Promise.resolve()).then(async () => {
      await this.stop();
      const gen = ++this.generation;
      const acc = new SearchAccumulator();
      result = new Promise((resolve) => {
        this.search = { gen, acc, onUpdate, resolve, stopped: false };
      });
      this.post(`setoption name MultiPV value ${multipv}`);
      this.post(`position fen ${fen}`);
      this.post(`go depth ${depth}`);
      this.onStatus({ searching: true });
    });
    this.starting = started.catch(() => {});
    await started;
    return result;
  }

  /** Stop the running search (if any) and wait for its bestmove. */
  async stop() {
    const s = this.search;
    if (!s) return;
    s.stopped = true;
    // Detach the update callback so the caller stops receiving results
    s.onUpdate = null;
    const done = new Promise((resolve) => {
      const orig = s.resolve;
      s.resolve = (r) => { orig(r); resolve(); };
    });
    this.post('stop');
    await done;
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.readyPromise = null;
    this.search = null;
  }
}
