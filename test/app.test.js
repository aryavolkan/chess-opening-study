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

test('games: import a PGN body, query positions and openings, fetch and delete', async () => {
  const pgn = `[Event "Test"]
[Site "https://example.org/1"]
[Date "2024.05.01"]
[White "me"]
[Black "them"]
[Result "1-0"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 1-0

[Event "Test"]
[Site "https://example.org/2"]
[White "them"]
[Black "me"]
[Result "1/2-1/2"]

1. e4 c5 2. Nf3 Nc6 3. d4 cxd4 4. Nxd4 g6 1/2-1/2
`;
  let r = await fetch(base + '/api/games/import?name=unit&player=me', { method: 'POST', headers: { 'Content-Type': 'application/x-chess-pgn' }, body: pgn });
  assert.equal(r.status, 200);
  const { import: imp } = await r.json();
  assert.equal(imp.games, 2);
  assert.equal(imp.name, 'unit');
  assert.equal(imp.player, 'me');

  // gzip body, declared with Content-Encoding
  const { gzipSync } = await import('node:zlib');
  r = await fetch(base + '/api/games/import?name=gz', { method: 'POST', headers: { 'Content-Encoding': 'gzip' }, body: gzipSync(pgn.replace(/example.org/g, 'example.net')) });
  assert.equal(r.status, 200);
  const gz = (await r.json()).import;
  assert.equal(gz.games, 2);

  // nothing in the body
  r = await fetch(base + '/api/games/import', { method: 'POST', body: 'just text, no moves' });
  assert.equal(r.status, 400);

  const list = await (await get('/api/games/imports')).json();
  assert.equal(list.imports.length, 2);
  assert.equal(list.total.games, 4);
  assert.equal(list.total.plies, 40);
  assert.equal(list.running, null);

  const sicilian = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -';
  r = await post('/api/games/positions', { epds: [sicilian, 'nope'], player: 'me' });
  let body = await r.json();
  assert.deepEqual(body.positions[sicilian], { games: 4, white: 2, draws: 2, black: 0, wins: 2, losses: 0 }, 'both imports have the same players');
  assert.equal(body.positions.nope, undefined);
  r = await post('/api/games/positions', { epds: 'x' });
  assert.equal(r.status, 400);

  r = await get('/api/games/position?epd=' + encodeURIComponent(sicilian));
  body = await r.json();
  assert.equal(body.stats.games, 4);
  assert.deepEqual(body.moves.map((m) => [m.san, m.games]), [['Nf3', 4]]);
  r = await get('/api/games/position');
  assert.equal(r.status, 400);

  r = await get('/api/games/openings?by=family&player=me&color=white');
  body = await r.json();
  assert.equal(body.total.games, 2);
  assert.equal(body.groups[0].name, 'Sicilian Defense');
  assert.equal(body.groups[0].wins, 2);
  r = await get('/api/games/openings?by=bogus');
  assert.equal(r.status, 400);

  r = await get('/api/games?epd=' + encodeURIComponent(sicilian) + '&limit=3');
  body = await r.json();
  assert.equal(body.total, 4);
  assert.equal(body.games.length, 3);
  assert.equal(body.games[0].atPly, 2);
  r = await get('/api/games?family=Sicilian%20Defense&player=me&color=black');
  body = await r.json();
  assert.equal(body.total, 2);
  const id = body.games[0].id;
  r = await get(`/api/games/${id}`);
  body = await r.json();
  assert.equal(body.game.moves.length, 8);
  assert.equal(body.game.black, 'me');
  r = await get('/api/games/99999');
  assert.equal(r.status, 404);

  r = await fetch(base + `/api/games/imports/${gz.id}`, { method: 'DELETE' });
  body = await r.json();
  assert.deepEqual(body, { removed: true, games: 2 });
  assert.equal((await (await get('/api/games/imports')).json()).total.games, 2);
});

test('explore endpoints proxy to the explorer', async () => {
  let r = await get('/api/explore');
  assert.equal(r.status, 503, 'no explorer wired in this test server');
});
