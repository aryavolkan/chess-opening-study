import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, BOX_INTERVAL_DAYS } from '../server/db.js';

const EPD = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
const line = (cp, pv) => ({ multipv: 1, score: { type: 'cp', value: cp }, pv });

test('saveAnalysis only keeps improvements', () => {
  const store = openDb();
  assert.equal(store.getAnalysis(EPD), null);
  let r = store.saveAnalysis({ epd: EPD, depth: 10, lines: [line(-30, ['c7c5'])], engine: 'x', source: 'browser' });
  assert.equal(r.stored, true);
  assert.equal(r.analysis.bestMove, 'c7c5');
  assert.deepEqual(r.analysis.score, { type: 'cp', value: -30 });
  // shallower: rejected
  r = store.saveAnalysis({ epd: EPD, depth: 8, lines: [line(0, ['e7e5'])] });
  assert.equal(r.stored, false);
  assert.equal(store.getAnalysis(EPD).depth, 10);
  // same depth, more lines: accepted
  r = store.saveAnalysis({ epd: EPD, depth: 10, lines: [line(-30, ['c7c5']), { ...line(-25, ['e7e5']), multipv: 2 }] });
  assert.equal(r.stored, true);
  assert.equal(store.getAnalysis(EPD).multipv, 2);
  // same depth, same lines: rejected
  r = store.saveAnalysis({ epd: EPD, depth: 10, lines: [line(-30, ['c7c5']), { ...line(-25, ['e7e5']), multipv: 2 }] });
  assert.equal(r.stored, false);
  // deeper: accepted, even with fewer lines
  r = store.saveAnalysis({ epd: EPD, depth: 20, lines: [line(-35, ['c7c5', 'g1f3'])], source: 'server' });
  assert.equal(r.stored, true);
  const a = store.getAnalysis(EPD);
  assert.equal(a.depth, 20);
  assert.equal(a.source, 'server');
  assert.deepEqual(a.lines[0].pv, ['c7c5', 'g1f3']);
  assert.throws(() => store.saveAnalysis({ epd: EPD, depth: 0, lines: [line(0, ['a2a3'])] }));
  assert.throws(() => store.saveAnalysis({ epd: EPD, depth: 5, lines: [] }));
  store.close();
});

test('stats, depth map and export', () => {
  const store = openDb();
  store.saveAnalysis({ epd: 'a w - -', depth: 12, lines: [line(0, ['a2a3'])] });
  store.saveAnalysis({ epd: 'b w - -', depth: 18, lines: [line(0, ['a2a3'])] });
  store.saveAnalysis({ epd: 'c w - -', depth: 18, lines: [line(0, ['a2a3'])] });
  const s = store.analysisStats();
  assert.equal(s.count, 3);
  assert.equal(s.minDepth, 12);
  assert.equal(s.maxDepth, 18);
  assert.equal(s.avgDepth, 16);
  assert.deepEqual(s.histogram, [{ depth: 12, count: 1 }, { depth: 18, count: 2 }]);
  assert.equal(store.depthMap().get('b w - -'), 18);
  assert.equal(store.exportAnalysis().length, 3);
  assert.deepEqual(Object.keys(store.getAnalysisMany(['a w - -', 'zzz'])), ['a w - -']);
  store.close();
});

test('study lines: add, dedupe, schedule with Leitner boxes, remove', () => {
  const store = openDb();
  const added = store.addStudyLine({ san: ['e4', 'c5'], color: 'black', name: 'Sicilian Defense', eco: 'B20' });
  assert.equal(added.created, true);
  assert.equal(added.line.box, 0);
  assert.deepEqual(added.line.san, ['e4', 'c5']);
  const again = store.addStudyLine({ san: ['e4', 'c5'], color: 'black', name: 'Sicilian Defense' });
  assert.equal(again.created, false);
  assert.equal(again.line.id, added.line.id);
  const other = store.addStudyLine({ san: ['e4', 'c5'], color: 'white', name: 'Sicilian Defense' });
  assert.equal(other.created, true);
  assert.equal(store.listStudyLines().length, 2);

  const now = new Date('2026-01-01T00:00:00Z');
  let l = store.recordStudyResult(added.line.id, true, now);
  assert.equal(l.box, 1);
  assert.equal(l.attempts, 1);
  assert.equal(l.correct, 1);
  assert.equal(l.streak, 1);
  assert.equal(l.due, new Date(now.getTime() + BOX_INTERVAL_DAYS[1] * 86400000).toISOString());
  l = store.recordStudyResult(added.line.id, true, now);
  assert.equal(l.box, 2);
  l = store.recordStudyResult(added.line.id, false, now);
  assert.equal(l.box, 0);
  assert.equal(l.streak, 0);
  assert.equal(l.due, now.toISOString());
  assert.equal(l.lastResult, 'wrong');
  assert.equal(store.recordStudyResult(999, true), null);

  assert.equal(store.removeStudyLine(added.line.id), true);
  assert.equal(store.removeStudyLine(added.line.id), false);
  assert.equal(store.listStudyLines().length, 1);
  assert.throws(() => store.addStudyLine({ san: [], color: 'white' }));
  assert.throws(() => store.addStudyLine({ san: ['e4'], color: 'red' }));
  store.close();
});

test('settings round-trip JSON', () => {
  const store = openDb();
  assert.equal(store.getSetting('x'), null);
  assert.equal(store.getSetting('x', 5), 5);
  store.setSetting('x', { a: [1, 2] });
  assert.deepEqual(store.getSetting('x'), { a: [1, 2] });
  store.close();
});
