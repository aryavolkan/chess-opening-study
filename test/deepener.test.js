import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { Deepener, withinScope } from '../server/deepener.js';

// A fake engine that "analyses" instantly, remembering what it was asked.
function fakeEngine(log) {
  return {
    name: 'fake',
    busy: false,
    async analyse(fen, { depth, multipv }) {
      log.push({ fen, depth, multipv });
      await new Promise((r) => setTimeout(r, 1));
      const lines = [];
      for (let i = 1; i <= multipv; i++) lines.push({ multipv: i, depth, score: { type: 'cp', value: 10 * i }, pv: ['e2e4'] });
      return { depth, lines, nodes: 1000, engine: 'fake' };
    },
    stop() {},
  };
}

const book = {
  positions: [
    { epd: 'start w - -', ply: 0, san: [] },
    { epd: 'e4 b - -', ply: 1, san: ['e4'] },
    { epd: 'e4 c5 w - -', ply: 2, san: ['e4', 'c5'] },
    { epd: 'e4 c5 w - -', ply: 2, san: ['e4', 'c5'] }, // transposition: same epd twice
    { epd: 'd4 b - -', ply: 1, san: ['d4'] },
  ],
};

test('withinScope', () => {
  assert.equal(withinScope(['e4', 'c5'], []), true);
  assert.equal(withinScope(['e4', 'c5'], ['e4']), true);
  assert.equal(withinScope(['e4'], ['e4', 'c5']), false);
  assert.equal(withinScope(['d4'], ['e4']), false);
});

test('deepens every unique position in scope to the target depth, shallowest first', async () => {
  const store = openDb();
  store.saveAnalysis({ epd: 'e4 b - -', depth: 30, lines: [{ multipv: 1, score: { type: 'cp', value: 0 }, pv: ['c7c5'] }] });
  store.saveAnalysis({ epd: 'd4 b - -', depth: 5, lines: [{ multipv: 1, score: { type: 'cp', value: 0 }, pv: ['d7d5'] }] });
  const log = [];
  const deepener = new Deepener({ store, book, loadEngine: async () => fakeEngine(log) });
  const idle = new Promise((resolve) => deepener.on('idle', resolve));
  const status = await deepener.start({ targetDepth: 12, multipv: 2 });
  assert.equal(status.running, true);
  assert.equal(status.total, 4, 'unique positions');
  await idle;
  const s = deepener.status();
  assert.equal(s.running, false);
  assert.equal(s.total, 4);
  assert.equal(s.done, 4, 'everything in scope now meets the target');
  assert.equal(s.remaining, 0);
  assert.equal(s.analysed, 3, 'the position already at depth 30 is skipped');
  assert.equal(s.improved, 3);
  assert.equal(log[0].fen.startsWith('start w - -'), true, 'depth 0 positions come before the depth 5 one, shallow ply first');
  assert.equal(log[2].fen.startsWith('d4 b - -'), true);
  assert.equal(store.getAnalysis('e4 c5 w - -').depth, 12);
  assert.equal(store.getAnalysis('e4 c5 w - -').multipv, 2);
  assert.equal(store.getAnalysis('e4 b - -').depth, 30);
  assert.deepEqual(store.getSetting('deepener'), { targetDepth: 12, multipv: 2, scope: [], running: false });
  store.close();
});

test('scope, prioritize, nextPositions and stop', async () => {
  const store = openDb();
  const log = [];
  const deepener = new Deepener({ store, book, loadEngine: async () => fakeEngine(log) });
  deepener.configure({ targetDepth: 10, scope: ['e4'] });
  const next = deepener.nextPositions(10);
  assert.deepEqual(next.map((p) => p.epd), ['e4 b - -', 'e4 c5 w - -']);
  deepener.buildQueue();
  assert.equal(deepener.prioritize(['e4 c5 w - -']), 1);
  assert.equal(deepener.queue[0].epd, 'e4 c5 w - -');
  // prioritising something outside the queue adds it when it is still shallow
  assert.equal(deepener.prioritize(['d4 b - -']), 1);
  assert.equal(deepener.queue[0].epd, 'd4 b - -');
  assert.throws(() => deepener.configure({ targetDepth: 0 }));
  assert.throws(() => deepener.configure({ multipv: 99 }));
  assert.throws(() => deepener.configure({ scope: 'e4' }));

  const idle = new Promise((resolve) => deepener.on('idle', resolve));
  await deepener.start();
  await idle;
  assert.equal(deepener.status().running, false);
  assert.ok(log.every((l) => l.depth === 10));
  assert.equal(store.getAnalysis('start w - -'), null, 'outside scope');
  store.close();
});
