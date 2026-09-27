// Server-side Stockfish (WASM, via the `stockfish` npm package) with a small
// promise based API: analyse(fen, {depth, multipv}) -> analysis record.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { SearchAccumulator, parseBestMove } from '../shared/uci.js';

const require = createRequire(import.meta.url);

export const ENGINE_FLAVOR = process.env.STOCKFISH_FLAVOR || 'lite-single';

export async function loadEngine(flavor = ENGINE_FLAVOR) {
  const init = require('stockfish');
  const pkgDir = dirname(require.resolve('stockfish/package.json'));
  const version = require('stockfish/package.json').buildVersion;
  const file = join(pkgDir, 'bin', `stockfish-${version}-${flavor}.js`);
  const raw = await init(file);
  return new Engine(raw, `stockfish-${version}-${flavor}`);
}

export class Engine {
  constructor(raw, name) {
    this.raw = raw;
    this.name = name;
    this.listeners = new Set();
    this.busy = false;
    raw.listener = (line) => {
      for (const fn of this.listeners) fn(line);
    };
    this.send('uci');
    this.send('setoption name UCI_ShowWDL value false');
  }

  send(cmd) {
    this.raw.sendCommand(cmd);
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Wait until the engine answers `isready`. */
  ready() {
    return new Promise((resolve) => {
      const off = this.onLine((line) => {
        if (line === 'readyok') {
          off();
          resolve();
        }
      });
      this.send('isready');
    });
  }

  /**
   * Run a fixed-depth search. Resolves with an analysis record whose `lines`
   * are ordered by multipv. `onProgress(snapshot)` is called as depth grows.
   */
  async analyse(fen, { depth = 20, multipv = 3, onProgress, hashMb } = {}) {
    if (this.busy) throw new Error('engine busy');
    this.busy = true;
    try {
      const acc = new SearchAccumulator();
      this.send('ucinewgame');
      if (hashMb) this.send(`setoption name Hash value ${hashMb}`);
      this.send(`setoption name MultiPV value ${multipv}`);
      await this.ready();
      this.send(`position fen ${fen}`);
      const result = await new Promise((resolve) => {
        const off = this.onLine((line) => {
          if (acc.push(line)) {
            if (onProgress) onProgress(acc.snapshot());
          } else if (line.startsWith('bestmove')) {
            off();
            const best = parseBestMove(line);
            const snap = acc.snapshot();
            if (!snap.lines.length) {
              // e.g. checkmate or stalemate: no pv lines at all
              resolve({ ...snap, bestmove: best.bestmove, terminal: true });
            } else {
              resolve({ ...snap, bestmove: best.bestmove });
            }
          }
        });
        this.send(`go depth ${depth}`);
      });
      return { ...result, engine: this.name };
    } finally {
      this.busy = false;
    }
  }

  stop() {
    this.send('stop');
  }

  // Note: never send `quit`; the WASM build calls process.exit() on it.
}
