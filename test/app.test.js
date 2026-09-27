import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { loadOpenings } from '../server/openings.js';
import { createApp } from '../server/app.js';

let server;
let base;
let store;
let deepenerCalls;

before(async () => {
  const book = loadOpenings();
  store = openDb();
  deepenerCalls = [];
  const deepener = {
    targetDepth: 20,
    status: () => ({ running: false, targetDepth: 20 }),
    start: async (o) => { deepenerCalls.push(['start', o]); return { running: true }; },
    stop: async () => ({ running: false }),
    configure: (o) => deepenerCalls.push(['configure', o]),
    prioritize: (epds) => epds.length,
    nextPositions: (n) => book.positions.slice(0, n).map((p) => ({ epd: p.epd, ply: p.ply, depth: 0 })),
  };
  server = createServer(createApp({ store, book, deepener }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health and openings', async () => {
  const h = await (await get('/api/health')).json();
  assert.equal(h.ok, true);
  assert.ok(h.openings > 3000);
  const res = await get('/api/openings');
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  const o = await res.json();
  assert.equal(o.openings.length, o.count);
  assert.deepEqual(o.openings[0].san, ['Nh3']);
});

test('analysis save, read, batch and validation', async () => {
  const epd = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
  let r = await post('/api/analysis', { fen: epd + ' 0 1', depth: 9, lines: [{ score: { type: 'cp', value: -20 }, pv: ['c7c5', 'g1f3'] }], engine: 'test', nodes: 5 });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.stored, true);
  assert.equal(body.analysis.source, 'browser');
  assert.equal(body.analysis.lines[0].multipv, 1);

  r = await get('/api/analysis?epd=' + encodeURIComponent(epd));
  body = await r.json();
  assert.equal(body.analysis.depth, 9);

  r = await post('/api/analysis/batch', { epds: [epd, 'nope'] });
  body = await r.json();
  assert.deepEqual(Object.keys(body.analysis), [epd]);

  r = await post('/api/analysis', { epd, depth: 9, lines: [{ score: { type: 'cp', value: 1 }, pv: ['zz'] }] });
  assert.equal(r.status, 400);
  r = await post('/api/analysis', { epd, depth: 'x', lines: [{ score: { type: 'cp', value: 1 }, pv: ['a2a3'] }] });
  assert.equal(r.status, 400);
  r = await post('/api/analysis', { epd, lines: [] });
  assert.equal(r.status, 400);
  r = await fetch(base + '/api/analysis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400);
  r = await get('/api/analysis');
  assert.equal(r.status, 400);

  const stats = await (await get('/api/analysis/stats')).json();
  assert.equal(stats.count, 1);
  assert.equal(stats.book.analysed, 1);
  assert.ok(stats.book.positions > 7000);
  const eco = await (await get('/api/eco')).json();
  assert.ok(eco.codes.B20.openings >= 1);
  assert.equal(typeof eco.codes.B20.avgDepth, 'number');
  const exp = await (await get('/api/analysis/export')).json();
  assert.equal(exp.analysis.length, 1);
});

test('deepen endpoints proxy to the deepener', async () => {
  let r = await post('/api/deepen/start', { targetDepth: 22 });
  assert.equal((await r.json()).running, true);
  assert.deepEqual(deepenerCalls.at(-1), ['start', { targetDepth: 22 }]);
  r = await get('/api/deepen/next?count=2&targetDepth=15');
  const body = await r.json();
  assert.equal(body.positions.length, 2);
  assert.equal(body.targetDepth, 15);
  r = await post('/api/deepen/prioritize', { epds: ['a', 'b'] });
  assert.equal((await r.json()).queued, 2);
  r = await post('/api/deepen/prioritize', { epds: 'a' });
  assert.equal(r.status, 400);
});

test('study endpoints', async () => {
  let r = await post('/api/study', { san: ['e4', 'c5'], color: 'black', name: 'Sicilian Defense', eco: 'B20' });
  const { line } = await r.json();
  assert.equal(line.color, 'black');
  r = await post(`/api/study/${line.id}/result`, { correct: true });
  assert.equal((await r.json()).line.box, 1);
  r = await post('/api/study/999/result', { correct: true });
  assert.equal(r.status, 404);
  const list = await (await get('/api/study')).json();
  assert.equal(list.lines.length, 1);
  r = await fetch(base + `/api/study/${line.id}`, { method: 'DELETE' });
  assert.equal((await r.json()).removed, true);
  r = await post('/api/study', { san: ['e4'], color: 'green' });
  assert.equal(r.status, 500);
});

test('static files and vendor paths, no traversal', async () => {
  let r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  r = await get('/shared/uci.js');
  assert.equal(r.status, 200);
  r = await get('/vendor/stockfish/stockfish-19-lite-single.wasm');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/wasm');
  r = await get('/vendor/chess.js/chess.js');
  assert.equal(r.status, 200);
  r = await get('/vendor/stockfish/../package.json');
  assert.equal(r.status, 404);
  r = await get('/..%2F..%2Fpackage.json');
  assert.equal(r.status, 404);
  r = await get('/api/nope');
  assert.equal(r.status, 404);
});
