import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staticApi } from '../public/static-api.js';

const line = (value) => ({ multipv: 1, score: { type: 'cp', value }, pv: ['e2e4', 'e7e5'] });

test('browser-only API keeps only deeper analysis', async () => {
  const epd = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
  assert.equal((await staticApi.saveAnalysis({ epd, depth: 12, lines: [line(20)] })).stored, true);
  assert.equal((await staticApi.saveAnalysis({ epd, depth: 10, lines: [line(99)] })).stored, false);
  assert.equal((await staticApi.saveAnalysis({ epd, depth: 14, lines: [line(30)] })).stored, true);
  const { analysis } = await staticApi.analysis(epd);
  assert.equal(analysis.depth, 14);
  assert.equal(analysis.bestMove, 'e2e4');
});

test('browser-only study set schedules with Leitner boxes', async () => {
  const { line: l, created } = await staticApi.studyAdd({ san: ['e4', 'e5'], color: 'white', name: 'Open game' });
  assert.equal(created, true);
  assert.equal((await staticApi.studyAdd({ san: ['e4', 'e5'], color: 'white' })).created, false);
  const right = (await staticApi.studyResult(l.id, true)).line;
  assert.equal(right.box, 1);
  assert.ok(new Date(right.due) > new Date());
  assert.equal((await staticApi.studyResult(l.id, false)).line.box, 0);
  assert.equal((await staticApi.studyRemove(l.id)).removed, true);
});
