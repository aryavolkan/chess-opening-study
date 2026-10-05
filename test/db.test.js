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

test('per-user scope: study sets and imports are private, shared imports are visible to all', async () => {
  const { userScope, localScope } = await import('../server/db.js');
  const store = openDb();
  const alice = userScope({ id: 1, admin: false });
  const bob = userScope({ id: 2, admin: false });
  const admin = userScope({ id: 3, admin: true });
  const nobody = userScope(null);
  store.addStudyLine({ san: ['e4'], color: 'white', name: 'King pawn' }, alice);
  store.addStudyLine({ san: ['e4'], color: 'white', name: 'King pawn' }, bob);
  store.addStudyLine({ san: ['d4'], color: 'white', name: 'Queen pawn' }); // the local user (id 0)
  assert.equal(store.listStudyLines(alice).length, 1);
  assert.equal(store.listStudyLines(bob).length, 1);
  assert.equal(store.listStudyLines(nobody).length, 0);
  assert.equal(store.listStudyLines(admin).length, 1, 'admins also own the local user\'s lines');
  assert.equal(store.listStudyLines(localScope()).length, 3, 'unrestricted on a self-hosted instance');
  const bobsLine = store.listStudyLines(bob)[0];
  assert.equal(store.removeStudyLine(bobsLine.id, alice), false);
  assert.equal(store.recordStudyResult(bobsLine.id, true, new Date(), alice), null);
  assert.equal(store.removeStudyLine(bobsLine.id, bob), true);

  const a = store.createImport({ name: 'alice', player: null, plies: 40 }, alice);
  const b = store.createImport({ name: 'admin', player: null, plies: 40 }, admin);
  const game = (importId, owner, key, shared = false) => store.insertGame({ importId, userId: owner, shared, key, result: '1-0', plies: 2, moves: ['e4', 'c5'] }, [{ epd: 'start', ply: 0, move: 'e4' }]);
  game(a, 1, 'k1');
  game(b, 3, 'k2');
  store.finishImport(a, { games: 1, positions: 1, duplicates: 0, invalid: 0, bytes: 1, ms: 1 });
  store.finishImport(b, { games: 1, positions: 1, duplicates: 0, invalid: 0, bytes: 1, ms: 1 });
  assert.deepEqual(store.listImports(alice).map((i) => [i.name, i.own]), [['alice', true]]);
  assert.deepEqual(store.listImports(nobody), []);
  assert.equal(store.positionStats('start', { scope: alice }).games, 1);
  assert.equal(store.positionStats('start', { scope: nobody }), null);
  assert.equal(store.positionStats('start', { scope: localScope() }).games, 2);
  assert.equal(store.setImportShared(b, true), true);
  assert.deepEqual(store.listImports(nobody).map((i) => [i.name, i.own, i.shared]), [['admin', false, true]]);
  assert.deepEqual(store.listImports(alice).map((i) => [i.name, i.own]), [['alice', true], ['admin', false]]);
  assert.equal(store.positionStats('start', { scope: nobody }).games, 1);
  assert.equal(store.positionStats('start', { scope: alice }).games, 2);
  assert.equal(store.gamesTotal(nobody).games, 1);
  assert.equal(store.getImport(a, bob), null);
  assert.equal(store.getImport(b, bob).shared, true);
  const g = store.listGames({ scope: alice }).games.find((x) => x.importId === a);
  assert.ok(store.getGame(g.id, alice));
  assert.equal(store.getGame(g.id, bob), null);
  store.close();
});

test('a database from before sign-in is migrated in place', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'ost-')), 'old.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE study_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, san TEXT NOT NULL, color TEXT NOT NULL, name TEXT NOT NULL, eco TEXT,
      box INTEGER NOT NULL DEFAULT 0, due TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, correct INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0, last_result TEXT, last_studied TEXT, added_at TEXT NOT NULL, UNIQUE(san, color));
    INSERT INTO study_lines (san, color, name, due, added_at) VALUES ('e4 c5', 'black', 'Sicilian', '2026-01-01', '2026-01-01');
    CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, player TEXT, games INTEGER NOT NULL DEFAULT 0,
      positions INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, invalid INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
      plies INTEGER NOT NULL, ms INTEGER, error TEXT, finished INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    INSERT INTO imports (name, games, positions, plies, finished, created_at) VALUES ('old', 1, 1, 40, 1, '2026-01-01');
    CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL, key TEXT NOT NULL UNIQUE, white TEXT, black TEXT,
      result TEXT NOT NULL, date TEXT, event TEXT, site TEXT, round TEXT, white_elo INTEGER, black_elo INTEGER, eco TEXT, opening TEXT,
      time_control TEXT, termination TEXT, plies INTEGER NOT NULL, moves TEXT NOT NULL, book_path TEXT, book_ply INTEGER NOT NULL DEFAULT 0,
      book_eco TEXT, book_name TEXT, book_family TEXT);
    INSERT INTO games (import_id, key, result, plies, moves) VALUES (1, 'k', '1-0', 2, 'e4 c5');
    CREATE TABLE analysis (epd TEXT PRIMARY KEY, depth INTEGER NOT NULL, multipv INTEGER NOT NULL, best_move TEXT, score_type TEXT, score INTEGER,
      lines TEXT NOT NULL, nodes INTEGER, engine TEXT, source TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE explore_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, scope TEXT NOT NULL, params TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT);
  `);
  db.close();
  const store = openDb(path);
  const { userScope, localScope } = await import('../server/db.js');
  assert.equal(store.listStudyLines(localScope()).length, 1, 'the old study set belongs to the local user');
  assert.equal(store.listStudyLines(userScope({ id: 9, admin: true })).length, 1, 'and admins see it');
  assert.equal(store.addStudyLine({ san: ['e4', 'c5'], color: 'black', name: 'Sicilian' }, userScope({ id: 7, admin: false })).created, true, 'the unique key is now per user');
  assert.equal(store.listImports(localScope())[0].name, 'old');
  assert.equal(store.listImports(userScope(null)).length, 0, 'old imports are private until shared');
  assert.equal(store.listGames({ scope: localScope() }).total, 1);
  store.saveAnalysis({ epd: 'x', depth: 3, lines: [{ multipv: 1, score: { type: 'cp', value: 0 }, pv: ['e2e4'] }], userId: 7 });
  assert.equal(store.getAnalysis('x').depth, 3);
  const again = openDb(path);
  assert.equal(again.listStudyLines(localScope()).length, 2, 'both lines survive a second open: migrating twice is harmless');
  again.close();
  store.close();
});
