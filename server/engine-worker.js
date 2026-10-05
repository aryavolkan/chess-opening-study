// Entry point of one engine worker process (see engine-pool.js): loads
// Stockfish, then answers { id, fen, depth, multipv } with { id, result }.
import { loadEngine } from './engine.js';

const engine = await loadEngine();
const queue = [];
let busy = false;

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const m = queue.shift();
    try {
      const r = await engine.analyse(m.fen, { depth: m.depth, multipv: m.multipv });
      process.send({ id: m.id, result: { depth: r.depth, lines: r.lines, nodes: r.nodes, engine: r.engine, terminal: Boolean(r.terminal) } });
    } catch (err) {
      process.send({ id: m.id, error: String(err?.message || err) });
    }
  }
  busy = false;
}

process.on('message', (m) => {
  if (m && m.fen) {
    queue.push(m);
    drain();
  }
});
process.on('disconnect', () => process.exit(0));
process.send({ ready: true, name: engine.name });
