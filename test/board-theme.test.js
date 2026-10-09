import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitBoardSize, clampScale, SIZE_MIN } from '../public/board-theme.js';

test('three-column layout: the board fits the narrower of the width and height budgets', () => {
  // wide and tall: width budget is 1600 - 32 - 260 - 280 - 24 - 32 = 972
  assert.equal(fitBoardSize({ innerWidth: 1900, innerHeight: 1400, single: false, scale: 1 }).size, 972);
  // short window: height budget wins
  assert.equal(fitBoardSize({ innerWidth: 1900, innerHeight: 700, single: false, scale: 1 }).size, 700 - 230);
});

test('single-column layout uses the window width less the gutters and eval bar', () => {
  assert.equal(fitBoardSize({ innerWidth: 600, innerHeight: 1200, single: true, scale: 1 }).size, 600 - 32 - 32);
});

test('scale shrinks or grows the fitted size, within the minimum and the width budget', () => {
  const r = fitBoardSize({ innerWidth: 1900, innerHeight: 700, single: false, scale: 0.5 });
  assert.equal(r.fit, 470);
  assert.equal(r.size, 235 < SIZE_MIN ? SIZE_MIN : 235);
  assert.equal(fitBoardSize({ innerWidth: 1900, innerHeight: 700, single: false, scale: 2 }).size, 940);
  assert.equal(fitBoardSize({ innerWidth: 1900, innerHeight: 700, single: false, scale: 3 }).size, 940); // clamped to 2
  assert.equal(fitBoardSize({ innerWidth: 300, innerHeight: 300, single: true, scale: 0.5 }).size, SIZE_MIN);
});

test('clampScale keeps the scale between 0.5 and 2 and falls back to 1', () => {
  assert.equal(clampScale(0.1), 0.5);
  assert.equal(clampScale(5), 2);
  assert.equal(clampScale('1.25'), 1.25);
  assert.equal(clampScale('x'), 1);
  assert.equal(clampScale(undefined), 1);
});
