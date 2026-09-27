import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInfo, parseBestMove, SearchAccumulator, scoreForWhite, formatScore, winningChances } from '../shared/uci.js';

test('parseInfo reads depth, multipv, score and pv', () => {
  const info = parseInfo('info depth 12 seldepth 17 multipv 2 score cp 34 nodes 82620 nps 510000 hashfull 29 time 162 pv b1c3 b8c6 g1f3');
  assert.equal(info.depth, 12);
  assert.equal(info.multipv, 2);
  assert.deepEqual(info.score, { type: 'cp', value: 34 });
  assert.deepEqual(info.pv, ['b1c3', 'b8c6', 'g1f3']);
  assert.equal(info.nodes, 82620);
});

test('parseInfo handles mate scores and bounds', () => {
  assert.deepEqual(parseInfo('info depth 5 score mate -3 pv e1e2').score, { type: 'mate', value: -3 });
  assert.equal(parseInfo('info depth 5 score cp 10 lowerbound nodes 5 pv a2a3').score.bound, 'lowerbound');
  assert.equal(parseInfo('info string NNUE evaluation using nn.nnue').string, 'NNUE evaluation using nn.nnue');
  assert.equal(parseInfo('bestmove e2e4'), null);
});

test('parseBestMove', () => {
  assert.deepEqual(parseBestMove('bestmove e2e4 ponder e7e5'), { bestmove: 'e2e4', ponder: 'e7e5' });
  assert.deepEqual(parseBestMove('bestmove (none)'), { bestmove: null, ponder: null });
  assert.equal(parseBestMove('info depth 1'), null);
});

test('SearchAccumulator keeps the latest line per multipv and reports the shallowest depth', () => {
  const acc = new SearchAccumulator();
  assert.equal(acc.push('info depth 1 multipv 1 score cp 10 pv e2e4'), true);
  assert.equal(acc.push('info depth 1 multipv 2 score cp 5 pv d2d4'), true);
  assert.equal(acc.push('info depth 2 multipv 1 score cp 12 pv e2e4 e7e5'), true);
  assert.equal(acc.push('info depth 2 currmove e2e4 currmovenumber 1'), false);
  assert.equal(acc.push('info depth 2 multipv 1 score cp 12 lowerbound pv e2e4'), false);
  let snap = acc.snapshot();
  assert.equal(snap.depth, 1, 'multipv 2 has not reached depth 2 yet');
  assert.equal(snap.lines.length, 2);
  acc.push('info depth 2 multipv 2 score cp 6 pv d2d4 d7d5');
  snap = acc.snapshot();
  assert.equal(snap.depth, 2);
  assert.deepEqual(snap.lines.map((l) => l.pv[0]), ['e2e4', 'd2d4']);
  // an older depth arriving late is ignored
  assert.equal(acc.push('info depth 1 multipv 1 score cp 0 pv a2a3'), false);
});

test('score helpers', () => {
  assert.deepEqual(scoreForWhite({ type: 'cp', value: 30 }, 'b'), { type: 'cp', value: -30 });
  assert.deepEqual(scoreForWhite({ type: 'mate', value: 2 }, 'w'), { type: 'mate', value: 2 });
  assert.equal(formatScore({ type: 'cp', value: 125 }), '+1.25');
  assert.equal(formatScore({ type: 'cp', value: -5 }), '-0.05');
  assert.equal(formatScore({ type: 'mate', value: -4 }), '#-4');
  assert.equal(formatScore(null), '–');
  assert.equal(winningChances({ type: 'cp', value: 0 }), 0);
  assert.ok(winningChances({ type: 'cp', value: 300 }) > 0.5);
  assert.equal(winningChances({ type: 'mate', value: -1 }), -1);
});
