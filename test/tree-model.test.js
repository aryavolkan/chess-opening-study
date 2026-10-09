import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBook, findNode } from '../shared/book.js';
import { orderChildren, capChildren, moveQuality } from '../public/tree-model.js';

const W = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const cp = (value, depth = 20, bestMove = null) => ({ depth, score: { type: 'cp', value }, bestMove });

function book() {
  const root = buildBook([
    { eco: 'A', name: 'a', san: ['a3'] },
    { eco: 'B', name: 'b', san: ['e4'] },
    { eco: 'C', name: 'c', san: ['d4'] },
    { eco: 'D', name: 'd', san: ['h4'] },
  ]);
  // Give every node an epd whose side-to-move is right (only the side matters here).
  root.epd = W;
  for (const c of root.children.values()) c.epd = c.san + ' b';
  return root;
}

test('book order keeps the TSV order', () => {
  const root = book();
  const out = orderChildren(root, { analysis: new Map(), games: null, order: 'book' });
  assert.deepEqual(out.map((n) => n.san), ['a3', 'e4', 'd4', 'h4']);
});

test('eval order puts the best reply for the side to move first, unanalysed last', () => {
  const root = book();
  const analysis = new Map([
    ['e4 b', cp(-30)], // stored from Black's view: +0.30 for White
    ['d4 b', cp(-20)], // +0.20 for White
    ['h4 b', cp(80)],  // -0.80 for White
  ]);
  const out = orderChildren(root, { analysis, games: null, order: 'eval' });
  assert.deepEqual(out.map((n) => n.san), ['e4', 'd4', 'h4', 'a3']);
});

test('eval order flips when Black is to move', () => {
  const root = book();
  root.epd = W.replace(' w ', ' b ');
  for (const c of root.children.values()) c.epd = c.san + ' w';
  const analysis = new Map([
    ['e4 w', cp(30)],  // +0.30 for White: bad for Black
    ['d4 w', cp(-20)], // -0.20 for White: good for Black
  ]);
  const out = orderChildren(root, { analysis, games: null, order: 'eval' });
  assert.deepEqual(out.map((n) => n.san).slice(0, 2), ['d4', 'e4']);
});

test('games order sorts by games played, book order as the tie-break', () => {
  const root = book();
  const games = new Map([['h4 b', { games: 5 }], ['d4 b', { games: 9 }]]);
  const out = orderChildren(root, { analysis: new Map(), games, order: 'games' });
  assert.deepEqual(out.map((n) => n.san), ['d4', 'h4', 'a3', 'e4']);
});

test('capChildren keeps the first n plus anything that must stay visible', () => {
  const root = book();
  const kids = [...root.children.values()];
  const keep = new Set([findNode(root, ['h4'])]);
  const { shown, hidden } = capChildren(kids, 2, keep);
  assert.deepEqual(shown.map((n) => n.san), ['a3', 'e4', 'h4']);
  assert.equal(hidden, 1);
  assert.deepEqual(capChildren(kids, 0, keep).shown.map((n) => n.san), ['a3', 'e4', 'd4', 'h4']);
  assert.equal(capChildren(kids, 10, keep).hidden, 0);
});

test('moveQuality marks moves by the winning chances they give away', () => {
  const root = book();
  const e4 = findNode(root, ['e4']);
  const h4 = findNode(root, ['h4']);
  const analysis = new Map([
    [W, cp(30)],
    ['e4 b', cp(-30)],  // same eval as the parent: fine
    ['h4 b', cp(100)],  // from +0.30 to -1.00 for White: a mistake
  ]);
  assert.equal(moveQuality(e4, analysis), null);
  assert.equal(moveQuality(h4, analysis), '?');
  analysis.set('h4 b', cp(40)); // to -0.40: an inaccuracy
  assert.equal(moveQuality(h4, analysis), '?!');
  analysis.set('h4 b', cp(400));
  assert.equal(moveQuality(h4, analysis), '??');
});

test('moveQuality stays quiet without both evaluations or at shallow depth', () => {
  const root = book();
  const h4 = findNode(root, ['h4']);
  assert.equal(moveQuality(h4, new Map([['h4 b', cp(400)]])), null);
  assert.equal(moveQuality(h4, new Map([[W, cp(30, 5)], ['h4 b', cp(400)]])), null);
  assert.equal(moveQuality(h4, new Map([[W, cp(30)], ['h4 b', cp(400, 5)]])), null);
});
