import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EnginePool, clampWorkers, MAX_WORKERS } from '../server/engine-pool.js';

/** A fake child process that answers like engine-worker.js, without an engine. */
function fakeChild({ failFirst = false, dieOn = null } = {}) {
  const child = new EventEmitter();
  child.sent = [];
  child.send = (m) => {
    child.sent.push(m);
    setImmediate(() => {
      if (m.fen === dieOn) return child.emit('exit', 1);
      child.emit('message', { id: m.id, result: { depth: m.depth, lines: [{ multipv: 1, score: { type: 'cp', value: 1 }, pv: ['e2e4'] }], nodes: 1, engine: 'fake' } });
    });
  };
  child.kill = () => { child.killed = true; };
  setImmediate(() => {
    if (failFirst) child.emit('exit', 1);
    else child.emit('message', { ready: true, name: 'fake' });
  });
  return child;
}

test('clampWorkers', () => {
  assert.equal(clampWorkers(0), 1);
  assert.equal(clampWorkers('x'), 1);
  assert.equal(clampWorkers(2), Math.min(2, MAX_WORKERS));
  assert.equal(clampWorkers(1000), MAX_WORKERS);
});

test('the pool queues requests over its workers, resizes, replaces a dead worker and stops', async () => {
  const children = [];
  const pool = new EnginePool({ size: 2, spawn: () => { const c = fakeChild({ dieOn: 'die' }); children.push(c); return c; } });
  await assert.rejects(pool.analyse('x'), /not running/);
  await pool.start();
  assert.equal(pool.status().workers, Math.min(2, MAX_WORKERS));
  assert.equal(pool.status().engine, 'fake');
  const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((fen) => pool.analyse(fen, { depth: 7, multipv: 2 })));
  assert.equal(results.length, 5);
  assert.equal(results[0].depth, 7);
  assert.equal(pool.status().completed, 5);
  const perChild = children.map((c) => c.sent.length);
  assert.equal(perChild.reduce((a, b) => a + b, 0), 5);
  if (MAX_WORKERS > 1) assert.ok(perChild.every((n) => n > 0), 'both workers were used');

  // a worker that dies mid-request: the request fails, a replacement is spawned
  const before = children.length;
  await assert.rejects(pool.analyse('die'), /exited/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(children.length, before + 1);
  assert.equal(pool.status().workers, pool.size);
  assert.equal((await pool.analyse('f')).depth, 14);

  await pool.resize(1);
  assert.equal(pool.status().workers, 1);
  await pool.stop();
  assert.equal(pool.status().running, false);
  assert.equal(pool.status().workers, 0);
  assert.ok(children.every((c) => c.killed));
});

test('a real worker process runs Stockfish', { timeout: 60000 }, async () => {
  const pool = new EnginePool({ size: 1 });
  await pool.start();
  try {
    assert.match(pool.status().engine, /stockfish/);
    const r = await pool.analyse('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { depth: 6, multipv: 2 });
    assert.ok(r.depth >= 6);
    assert.equal(r.lines.length, 2);
    assert.match(r.lines[0].pv[0], /^[a-h][1-8][a-h][1-8]$/);
    const mate = await pool.analyse('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', { depth: 6, multipv: 2 });
    assert.equal(mate.terminal, true);
    assert.equal(mate.lines.length, 0);
  } finally {
    await pool.stop();
  }
});
