import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Chess } from 'chess.js';
import { openDb } from '../server/db.js';
import { loadOpenings } from '../server/openings.js';
import { Explorer, fitScore, cpFor, DEFAULTS } from '../server/explorer.js';
import { Importer } from '../server/games.js';
import { findNode } from '../shared/book.js';

let book;
before(() => { book = loadOpenings(); });

/**
 * A deterministic fake engine pool: the "best" move is the first legal move
 * in chess.js order, scores depend on the material count, so every position
 * gets a stable multipv answer without Stockfish.
 */
function fakePool(log = []) {
  return {
    running: false,
    size: 1,
    async start() { this.running = true; },
    async stop() { this.running = false; },
    async resize(n) { this.size = n; },
    status() { return { running: this.running, size: this.size, workers: this.size, busy: 0, queued: 0, completed: log.length, engine: 'fake' }; },
    async analyse(fen, { depth, multipv }) {
      log.push(fen);
      await new Promise((r) => setImmediate(r));
      const chess = new Chess(fen);
      const moves = chess.moves({ verbose: true });
      const lines = moves.slice(0, multipv).map((m, i) => ({
        multipv: i + 1,
        depth,
        score: { type: 'cp', value: 20 - 30 * i + (fen.split(' ')[1] === 'w' ? 5 : -5) },
        pv: [m.from + m.to + (m.promotion || '')],
      }));
      return { depth, lines, nodes: 100, engine: 'fake' };
    },
  };
}

test('cpFor converts scores to our point of view, mates included', () => {
  assert.equal(cpFor({ type: 'cp', value: 30 }, 'w', 'w'), 30);
  assert.equal(cpFor({ type: 'cp', value: 30 }, 'b', 'w'), -30);
  assert.equal(cpFor({ type: 'mate', value: 2 }, 'w', 'w'), 9998);
  assert.equal(cpFor({ type: 'mate', value: -1 }, 'w', 'b'), 9999);
  assert.equal(cpFor({ type: 'mate', value: 0 }, 'w', 'w'), -10000);
  assert.equal(cpFor(null, 'w', 'w'), 0);
});

test('fitScore rewards sound, short, forgiving, reachable openings', () => {
  const base = { eval: 20, worst: 0, decisions: 1, moves: 1, forgiveness: 0, reach: null };
  assert.equal(fitScore(base), 100);
  assert.ok(fitScore({ ...base, eval: -60 }) < fitScore(base));
  assert.ok(fitScore({ ...base, decisions: 10 }) < fitScore({ ...base, decisions: 3 }));
  assert.ok(fitScore({ ...base, forgiveness: 80 }) < fitScore({ ...base, forgiveness: 10 }));
  assert.ok(fitScore({ ...base, reach: 0.04 }) < fitScore({ ...base, reach: 0.5 }));
  assert.equal(fitScore({ ...base, eval: -1000, worst: -1000, decisions: 40, forgiveness: 500 }), 0);
});

test('jobs are validated, queued, run against the pool, resumed and removed', async () => {
  const store = openDb();
  const log = [];
  const explorer = new Explorer({ store, book, createPool: () => fakePool(log) });

  assert.throws(() => explorer.addJob({ color: 'green', scope: [] }), /color/);
  assert.throws(() => explorer.addJob({ color: 'white', scope: ['h4', 'h5', 'h6'] }), /scope/);
  assert.throws(() => explorer.addJob({ color: 'white', scope: [], depth: 99 }), /depth/);

  // Caro-Kann as Black: a handful of named lines under 1. e4 c6
  const job = explorer.addJob({ color: 'black', scope: ['e4', 'c6'], depth: 8, horizon: 4, replies: 2 });
  assert.equal(job.status, 'queued');
  assert.equal(job.color, 'black');
  assert.deepEqual(job.scope, ['e4', 'c6']);
  assert.equal(job.params.depth, 8);
  assert.equal(job.params.minGames, DEFAULTS.minGames);
  assert.match(job.name, /Caro-Kann Defense as black/);
  assert.ok(job.total > 10, `candidates: ${job.total}`);
  const s0 = explorer.status();
  assert.equal(s0.running, false);
  assert.equal(s0.jobs.length, 1);

  const idle = new Promise((resolve) => explorer.on('idle', resolve));
  const results = [];
  explorer.on('result', (r) => results.push(r));
  const started = await explorer.start({ workers: 3 });
  assert.equal(started.running, true);
  assert.equal(started.workers, 3);
  assert.equal(started.pool.engine, 'fake');
  await idle;
  await explorer.loop;
  const s1 = explorer.status();
  assert.equal(s1.running, false);
  assert.equal(s1.jobs[0].status, 'done');
  assert.equal(s1.jobs[0].done, s1.jobs[0].total);
  assert.equal(results.length, job.total);
  assert.deepEqual(store.getSetting('explorer'), { workers: 3, running: false });

  const rows = store.exploreResults({ jobId: job.id });
  assert.equal(rows.length, job.total);
  const ck = rows.find((r) => r.path.join(' ') === 'e4 c6');
  assert.ok(ck);
  assert.equal(ck.color, 'black');
  assert.equal(ck.eco, 'B10');
  assert.ok(ck.decisions >= 1 && ck.decisions <= 6, `White moves first here: Black decides after each of 2 replies, then after 2 more each (${ck.decisions})`);
  assert.ok(ck.moves >= 1);
  assert.ok(Number.isFinite(ck.eval));
  assert.ok(Number.isFinite(ck.worst));
  assert.ok(ck.theory > 10, 'named lines below the Caro-Kann');
  assert.equal(typeof ck.fit, 'number');
  assert.equal(ck.games, null, 'no games imported');
  assert.equal(ck.reach, null);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].fit >= r.fit), 'best fit first');
  // Analysis went through the store and is shared
  assert.ok(store.getAnalysis(findNode(book.root, ['e4', 'c6']).epd));
  assert.equal(store.getAnalysis(findNode(book.root, ['e4', 'c6']).epd).source, 'explorer');
  const analysedOnce = log.length;
  assert.ok(analysedOnce > 0);

  // A second job over the same scope reuses the stored analysis: no engine calls
  const again = explorer.addJob({ color: 'black', scope: ['e4', 'c6'], depth: 8, horizon: 4, replies: 2, name: 'again' });
  const idle2 = new Promise((resolve) => explorer.on('idle', resolve));
  await explorer.start();
  await idle2;
  await explorer.loop;
  assert.equal(log.length, analysedOnce, 'nothing analysed twice');
  assert.equal(store.exploreResults({ jobId: again.id }).length, job.total);
  assert.equal(store.exploreResults().length, 2 * job.total);

  // Remove a job: its results go with it
  assert.deepEqual(explorer.removeJob(again.id), { removed: true, results: job.total });
  assert.equal(store.exploreResults().length, job.total);
  assert.equal(explorer.removeJob(999).removed, false);
  store.close();
});

test('stop interrupts a job, which resumes where it was; min games uses the imported games', async () => {
  const store = openDb();
  const importer = new Importer({ store, book });
  const g = (w, b, r, moves, i) => `[White "${w}"]\n[Black "${b}"]\n[Result "${r}"]\n[Site "s${i}"]\n\n${moves} ${r}\n\n`;
  let pgn = '';
  for (let i = 0; i < 6; i++) pgn += g('me', 'x', '1-0', '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6', i);
  for (let i = 0; i < 3; i++) pgn += g('x', 'me', '0-1', '1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 g6', 10 + i);
  await importer.importStream(Readable.from([Buffer.from(pgn)]), { name: 't' });

  const log = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  // Like the real pool: requests wait for a worker and are rejected on stop()
  const inner = fakePool(log);
  const waiting = [];
  const slowPool = {
    ...inner,
    analyse(fen, o) {
      return new Promise((resolve, reject) => {
        waiting.push(reject);
        gate.then(() => inner.analyse(fen, o).then(resolve, reject));
      });
    },
    async stop() { inner.running = false; for (const rej of waiting.splice(0)) rej(new Error('engine pool stopped')); },
  };
  const explorer = new Explorer({ store, book, createPool: () => slowPool });
  const job = explorer.addJob({ color: 'white', scope: ['e4', 'c5'], minGames: 3, horizon: 2, replies: 1, depth: 6 });
  assert.ok(job.total >= 2 && job.total < 20, `only openings reached by at least 3 games: ${job.total}`);
  await explorer.start({ workers: 1 });
  assert.equal(explorer.status().running, true);
  assert.ok(explorer.status().current, 'working on the first candidate');
  const stopped = await explorer.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.jobs[0].status, 'queued', 'interrupted jobs go back to the queue');
  release();

  const idle = new Promise((resolve) => explorer.on('idle', resolve));
  await explorer.start();
  await idle;
  await explorer.loop;
  const done = explorer.status().jobs[0];
  assert.equal(done.status, 'done');
  assert.equal(done.done, job.total);
  const rows = store.exploreResults({ jobId: job.id });
  assert.equal(rows.length, job.total);
  const sicilian = rows.find((r) => r.path.join(' ') === 'e4 c5');
  assert.ok(sicilian);
  assert.equal(sicilian.games.games, 9);
  assert.equal(sicilian.reach, 1, 'Black played c5 in every game that reached 1. e4 (we are White, so e4 is our choice)');
  const najdorf = rows.find((r) => /Najdorf/.test(r.name));
  assert.ok(najdorf, 'reached by 6 games');
  assert.equal(najdorf.reach, 0.667, 'd6 was played in 6 of 9 games after 2. Nf3; every later Black move in all 6');
  assert.equal(najdorf.reachSamples, 6, 'the smallest sample along the way');
  store.close();
});
