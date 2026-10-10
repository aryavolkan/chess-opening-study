import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { epdHash } from '../shared/fen.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis (
  epd        TEXT PRIMARY KEY,
  depth      INTEGER NOT NULL,
  multipv    INTEGER NOT NULL,
  best_move  TEXT,
  score_type TEXT,
  score      INTEGER,
  lines      TEXT NOT NULL,
  nodes      INTEGER,
  engine     TEXT,
  source     TEXT,
  user_id    INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_depth ON analysis(depth);

-- Per-user data carries user_id: 0 is the owner of a self-hosted instance
-- without sign-in (and the data of such an instance before sign-in was
-- enabled); signed-in users have their own ids.
CREATE TABLE IF NOT EXISTS study_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 0,
  san        TEXT NOT NULL,
  color      TEXT NOT NULL,
  name       TEXT NOT NULL,
  eco        TEXT,
  box        INTEGER NOT NULL DEFAULT 0,
  due        TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  correct    INTEGER NOT NULL DEFAULT 0,
  streak     INTEGER NOT NULL DEFAULT 0,
  last_result TEXT,
  last_studied TEXT,
  added_at   TEXT NOT NULL,
  UNIQUE(user_id, san, color)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT,
  name        TEXT,
  picture     TEXT,
  admin       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  last_login  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Imported games. One row per PGN import, one per game, and one per
-- (position, game) pair for the first plies of every game, so "how often did
-- this position occur and how did those games end" is an index lookup.
-- An import is private to its owner unless an admin marks it shared.
CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0,
  shared      INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  player      TEXT,
  source      TEXT,
  games       INTEGER NOT NULL DEFAULT 0,
  positions   INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  invalid     INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  plies       INTEGER NOT NULL,
  ms          INTEGER,
  error       TEXT,
  finished    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL DEFAULT 0,
  shared      INTEGER NOT NULL DEFAULT 0,
  key         TEXT NOT NULL UNIQUE,
  white       TEXT,
  black       TEXT,
  result      TEXT NOT NULL,
  date        TEXT,
  event       TEXT,
  site        TEXT,
  round       TEXT,
  white_elo   INTEGER,
  black_elo   INTEGER,
  eco         TEXT,
  opening     TEXT,
  time_control TEXT,
  termination TEXT,
  plies       INTEGER NOT NULL,
  moves       TEXT NOT NULL,
  book_path   TEXT,
  book_ply    INTEGER NOT NULL DEFAULT 0,
  book_eco    TEXT,
  book_name   TEXT,
  book_family TEXT
);
CREATE INDEX IF NOT EXISTS games_import ON games(import_id);
CREATE INDEX IF NOT EXISTS games_book_name ON games(book_name);

-- Opening explorer: queued jobs and one result row per opening scored.
CREATE TABLE IF NOT EXISTS explore_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,
  scope       TEXT NOT NULL,
  params      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS explore_results (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL,
  path        TEXT NOT NULL,
  ply         INTEGER NOT NULL,
  eco         TEXT,
  name        TEXT,
  color       TEXT NOT NULL,
  fit         INTEGER NOT NULL,
  metrics     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(job_id, path)
);

-- Older databases may still hold the machines and deep_requests tables of the
-- removed dedicated-machines feature; nothing reads them.

CREATE TABLE IF NOT EXISTS public_workers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash     TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  positions_done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS public_workers_seen ON public_workers(last_seen_at);

CREATE TABLE IF NOT EXISTS game_positions (
  hash     INTEGER NOT NULL,
  game_id  INTEGER NOT NULL,
  ply      INTEGER NOT NULL,
  move     TEXT,
  PRIMARY KEY (hash, game_id)
) WITHOUT ROWID;
`;

// Leitner boxes: how many days until a line is due again after a success.
export const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60];

/** The owner of a self-hosted instance without sign-in. */
export const LOCAL_USER_ID = 0;

/**
 * Who is asking, for per-user data. `restrict` is false on a self-hosted
 * instance without sign-in (everything is visible, writes belong to user 0)
 * and true on a public site: a row is visible when it is shared or owned by
 * the user; admins also own the rows of user 0.
 */
export function localScope() {
  return { user: LOCAL_USER_ID, admin: true, restrict: false };
}

export function userScope(user) {
  if (!user) return { user: null, admin: false, restrict: true };
  return { user: user.id, admin: Boolean(user.admin), restrict: true };
}

/** Ids whose rows the scope owns, or null when unrestricted. */
function owners(scope = localScope()) {
  if (!scope.restrict) return null;
  if (scope.user === null || scope.user === undefined) return [];
  return scope.admin && scope.user !== LOCAL_USER_ID ? [scope.user, LOCAL_USER_ID] : [scope.user];
}

function ownerOf(scope = localScope()) {
  return scope.user ?? LOCAL_USER_ID;
}

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA cache_size = -32000');
  db.exec(SCHEMA);
  migrate(db);
  return new Store(db);
}

/** Bring a database created by an older version up to the current schema. */
function migrate(db) {
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  const add = (table, column, definition) => {
    if (!columns(table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  add('analysis', 'user_id', 'INTEGER');
  add('imports', 'user_id', 'INTEGER NOT NULL DEFAULT 0');
  add('imports', 'shared', 'INTEGER NOT NULL DEFAULT 0');
  add('imports', 'source', 'TEXT');
  add('games', 'user_id', 'INTEGER NOT NULL DEFAULT 0');
  add('games', 'shared', 'INTEGER NOT NULL DEFAULT 0');
  add('explore_jobs', 'user_id', 'INTEGER NOT NULL DEFAULT 0');
  if (!columns('study_lines').has('user_id')) {
    // The unique key changes from (san, color) to (user_id, san, color): rebuild.
    db.exec(`
      BEGIN;
      CREATE TABLE study_lines_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL DEFAULT 0, san TEXT NOT NULL, color TEXT NOT NULL,
        name TEXT NOT NULL, eco TEXT, box INTEGER NOT NULL DEFAULT 0, due TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        correct INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, last_result TEXT, last_studied TEXT,
        added_at TEXT NOT NULL, UNIQUE(user_id, san, color));
      INSERT INTO study_lines_v2 (id, user_id, san, color, name, eco, box, due, attempts, correct, streak, last_result, last_studied, added_at)
        SELECT id, 0, san, color, name, eco, box, due, attempts, correct, streak, last_result, last_studied, added_at FROM study_lines;
      DROP TABLE study_lines;
      ALTER TABLE study_lines_v2 RENAME TO study_lines;
      COMMIT;`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS games_user ON games(user_id)');
}

export class Store {
  constructor(db) {
    this.db = db;
    this.cache = new Map();
    this.stmts = {
      getAnalysis: db.prepare('SELECT * FROM analysis WHERE epd = ?'),
      upsertAnalysis: db.prepare(`
        INSERT INTO analysis (epd, depth, multipv, best_move, score_type, score, lines, nodes, engine, source, user_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(epd) DO UPDATE SET
          depth = excluded.depth, multipv = excluded.multipv, best_move = excluded.best_move,
          score_type = excluded.score_type, score = excluded.score, lines = excluded.lines,
          nodes = excluded.nodes, engine = excluded.engine, source = excluded.source, user_id = excluded.user_id,
          updated_at = excluded.updated_at`),
      depthOf: db.prepare('SELECT depth, multipv FROM analysis WHERE epd = ?'),
      allDepths: db.prepare('SELECT epd, depth FROM analysis'),
      stats: db.prepare('SELECT COUNT(*) AS count, MIN(depth) AS min, AVG(depth) AS avg, MAX(depth) AS max FROM analysis'),
      histogram: db.prepare('SELECT depth, COUNT(*) AS count FROM analysis GROUP BY depth ORDER BY depth'),
      allAnalysis: db.prepare('SELECT * FROM analysis ORDER BY epd'),

      getStudy: db.prepare('SELECT * FROM study_lines WHERE id = ?'),
      findStudy: db.prepare('SELECT * FROM study_lines WHERE user_id = ? AND san = ? AND color = ?'),
      insertStudy: db.prepare(`INSERT INTO study_lines (user_id, san, color, name, eco, box, due, added_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)`),
      deleteStudy: db.prepare('DELETE FROM study_lines WHERE id = ?'),
      updateStudy: db.prepare(`UPDATE study_lines SET box = ?, due = ?, attempts = attempts + 1,
        correct = correct + ?, streak = ?, last_result = ?, last_studied = ? WHERE id = ?`),

      getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

      getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
      getUserBySub: db.prepare('SELECT * FROM users WHERE google_sub = ?'),
      insertUser: db.prepare('INSERT INTO users (google_sub, email, name, picture, admin, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      updateUser: db.prepare('UPDATE users SET email = ?, name = ?, picture = ?, admin = ?, last_login = ? WHERE id = ?'),
      listUsers: db.prepare('SELECT * FROM users ORDER BY id'),
      insertSession: db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'),
      getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
      deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
      deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
      purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

      insertImport: db.prepare('INSERT INTO imports (user_id, name, player, plies, source, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      finishImport: db.prepare(`UPDATE imports SET games = ?, positions = ?, duplicates = ?, invalid = ?, bytes = ?, ms = ?, error = ?, finished = 1
        WHERE id = ?`),
      getImport: db.prepare('SELECT * FROM imports WHERE id = ?'),
      shareImport: db.prepare('UPDATE imports SET shared = ? WHERE id = ?'),
      shareGames: db.prepare('UPDATE games SET shared = ? WHERE import_id = ?'),
      deleteImportPositions: db.prepare('DELETE FROM game_positions WHERE game_id IN (SELECT id FROM games WHERE import_id = ?)'),
      deleteImportGames: db.prepare('DELETE FROM games WHERE import_id = ?'),
      deleteImport: db.prepare('DELETE FROM imports WHERE id = ?'),
      insertGame: db.prepare(`INSERT OR IGNORE INTO games (import_id, user_id, shared, key, white, black, result, date, event, site, round,
        white_elo, black_elo, eco, opening, time_control, termination, plies, moves, book_path, book_ply, book_eco, book_name, book_family)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertPosition: db.prepare('INSERT OR IGNORE INTO game_positions (hash, game_id, ply, move) VALUES (?, ?, ?, ?)'),
      getGame: db.prepare('SELECT * FROM games WHERE id = ?'),
      hasGameKey: db.prepare('SELECT 1 FROM games WHERE key = ?'),

      insertPublicWorker: db.prepare('INSERT INTO public_workers (token_hash, name, created_at, last_seen_at, positions_done) VALUES (?, ?, ?, ?, 0)'),
      getPublicWorker: db.prepare('SELECT * FROM public_workers WHERE token_hash = ?'),
      listPublicWorkers: db.prepare("SELECT * FROM public_workers WHERE last_seen_at > ? ORDER BY last_seen_at DESC LIMIT 1000"),
      touchPublicWorker: db.prepare("UPDATE public_workers SET last_seen_at = ?, positions_done = ? WHERE token_hash = ?"),
      deletePublicWorker: db.prepare('DELETE FROM public_workers WHERE token_hash = ?'),

      insertExploreJob: db.prepare('INSERT INTO explore_jobs (user_id, name, color, scope, params, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      listExploreJobs: db.prepare('SELECT * FROM explore_jobs ORDER BY id'),
      getExploreJob: db.prepare('SELECT * FROM explore_jobs WHERE id = ?'),
      nextExploreJob: db.prepare("SELECT * FROM explore_jobs WHERE status IN ('queued', 'running') ORDER BY id LIMIT 1"),
      deleteExploreJob: db.prepare('DELETE FROM explore_jobs WHERE id = ?'),
      deleteExploreResults: db.prepare('DELETE FROM explore_results WHERE job_id = ?'),
      upsertExploreResult: db.prepare(`INSERT INTO explore_results (job_id, path, ply, eco, name, color, fit, metrics, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id, path) DO UPDATE SET fit = excluded.fit, metrics = excluded.metrics, created_at = excluded.created_at`),
      exploreResultPaths: db.prepare('SELECT path FROM explore_results WHERE job_id = ?'),
      exploreResults: db.prepare('SELECT * FROM explore_results WHERE job_id = ? ORDER BY fit DESC, ply, id LIMIT ?'),
      allExploreResults: db.prepare('SELECT * FROM explore_results ORDER BY fit DESC, ply, id LIMIT ?'),
    };
  }

  close() {
    this.db.close();
  }

  /** Run fn inside one transaction; rolled back if it throws. */
  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Prepared statement for an SQL string built at run time (cached). */
  prepared(sql) {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    return st;
  }

  // ---- analysis -------------------------------------------------------

  getAnalysis(epd) {
    const row = this.stmts.getAnalysis.get(epd);
    return row ? rowToAnalysis(row) : null;
  }

  getAnalysisMany(epds) {
    const out = {};
    for (const epd of epds) {
      const a = this.getAnalysis(epd);
      if (a) out[epd] = a;
    }
    return out;
  }

  /**
   * Store an analysis result if it improves on what is stored: deeper, or the
   * same depth with more lines. Returns { stored: boolean, analysis }.
   */
  saveAnalysis(record) {
    const { epd, depth, lines } = record;
    if (!epd || !Number.isInteger(depth) || depth <= 0 || !Array.isArray(lines) || lines.length === 0) {
      throw new Error('invalid analysis record');
    }
    const existing = this.stmts.depthOf.get(epd);
    const multipv = lines.length;
    if (existing && (existing.depth > depth || (existing.depth === depth && existing.multipv >= multipv))) {
      return { stored: false, analysis: this.getAnalysis(epd) };
    }
    const best = lines[0];
    this.stmts.upsertAnalysis.run(
      epd,
      depth,
      multipv,
      best.pv?.[0] ?? null,
      best.score?.type ?? null,
      best.score?.value ?? null,
      JSON.stringify(lines.map(cleanLine)),
      record.nodes ?? null,
      record.engine ?? null,
      record.source ?? null,
      record.userId ?? null,
      new Date().toISOString(),
    );
    return { stored: true, analysis: this.getAnalysis(epd) };
  }

  analysisStats() {
    const s = this.stmts.stats.get();
    return {
      count: s.count,
      minDepth: s.min ?? 0,
      avgDepth: s.avg ? Math.round(s.avg * 10) / 10 : 0,
      maxDepth: s.max ?? 0,
      histogram: this.stmts.histogram.all().map((r) => ({ depth: r.depth, count: r.count })),
    };
  }

  /** Map of epd -> depth for every stored position. */
  depthMap() {
    const map = new Map();
    for (const row of this.stmts.allDepths.all()) map.set(row.epd, row.depth);
    return map;
  }

  exportAnalysis() {
    return this.stmts.allAnalysis.all().map(rowToAnalysis);
  }

  // ---- study lines (per user) -------------------------------------------

  listStudyLines(scope = localScope()) {
    const params = {};
    const where = ownerClause(scope, params, 'user_id');
    if (where === 'NONE') return [];
    return this.prepared(`SELECT * FROM study_lines ${where ? `WHERE ${where}` : ''} ORDER BY due, id`).all(params).map(rowToStudy);
  }

  getStudyLine(id, scope = localScope()) {
    const row = this.stmts.getStudy.get(id);
    return row && ownsRow(scope, row.user_id) ? rowToStudy(row) : null;
  }

  addStudyLine({ san, color, name, eco }, scope = localScope()) {
    if (!Array.isArray(san) || san.length === 0) throw new Error('san moves required');
    if (color !== 'white' && color !== 'black') throw new Error('color must be white or black');
    const owner = ownerOf(scope);
    const key = san.join(' ');
    const existing = this.stmts.findStudy.get(owner, key, color);
    if (existing) return { created: false, line: rowToStudy(existing) };
    const now = new Date().toISOString();
    const result = this.stmts.insertStudy.run(owner, key, color, name || key, eco || null, now, now);
    return { created: true, line: this.getStudyLine(Number(result.lastInsertRowid), scope) };
  }

  removeStudyLine(id, scope = localScope()) {
    if (!this.getStudyLine(id, scope)) return false;
    return this.stmts.deleteStudy.run(id).changes > 0;
  }

  /** Record a drill result and reschedule the line (Leitner boxes). */
  recordStudyResult(id, correct, now = new Date(), scope = localScope()) {
    const line = this.getStudyLine(id, scope);
    if (!line) return null;
    const box = correct ? Math.min(line.box + 1, BOX_INTERVAL_DAYS.length - 1) : 0;
    const days = BOX_INTERVAL_DAYS[box];
    const due = new Date(now.getTime() + days * 86400000).toISOString();
    const streak = correct ? line.streak + 1 : 0;
    this.stmts.updateStudy.run(box, due, correct ? 1 : 0, streak, correct ? 'correct' : 'wrong', now.toISOString(), id);
    return this.getStudyLine(id, scope);
  }

  // ---- settings -------------------------------------------------------

  getSetting(key, fallback = null) {
    const row = this.stmts.getSetting.get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.stmts.setSetting.run(key, JSON.stringify(value));
  }

  // ---- users and sessions ---------------------------------------------

  /** Create or refresh a user from a verified Google identity. */
  upsertUser({ sub, email, name, picture, admin }) {
    const now = new Date().toISOString();
    const existing = this.stmts.getUserBySub.get(sub);
    if (existing) {
      this.stmts.updateUser.run(email ?? existing.email, name ?? existing.name, picture ?? existing.picture, admin ? 1 : 0, now, existing.id);
      return this.getUser(existing.id);
    }
    const r = this.stmts.insertUser.run(sub, email ?? null, name ?? null, picture ?? null, admin ? 1 : 0, now, now);
    return this.getUser(Number(r.lastInsertRowid));
  }

  getUser(id) {
    const row = this.stmts.getUser.get(id);
    return row ? rowToUser(row) : null;
  }

  listUsers() {
    return this.stmts.listUsers.all().map(rowToUser);
  }

  createSession(userId, { ttlMs = 30 * 86400000, userAgent = null } = {}) {
    const id = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.stmts.insertSession.run(id, userId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString(), userAgent ? String(userAgent).slice(0, 200) : null);
    this.stmts.purgeSessions.run(new Date(now).toISOString());
    return id;
  }

  /** The user of a live session, or null (expired sessions are removed). */
  sessionUser(id) {
    if (!id) return null;
    const s = this.stmts.getSession.get(id);
    if (!s) return null;
    if (Date.parse(s.expires_at) < Date.now()) {
      this.stmts.deleteSession.run(id);
      return null;
    }
    return this.getUser(s.user_id);
  }

  deleteSession(id) {
    return this.stmts.deleteSession.run(id).changes > 0;
  }

  deleteUserSessions(userId) {
    return this.stmts.deleteUserSessions.run(userId).changes;
  }

  // ---- imported games -------------------------------------------------

  /** `source` is where the games came from (a chess-results.com tournament page, a PGN address), or null for an uploaded file. */
  createImport({ name, player, plies, source = null }, scope = localScope()) {
    const r = this.stmts.insertImport.run(ownerOf(scope), name, player || null, plies, source || null, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  finishImport(id, { games, positions, duplicates, invalid, bytes, ms, error = null }) {
    this.stmts.finishImport.run(games, positions, duplicates, invalid, bytes, ms, error, id);
    return this.getImport(id);
  }

  getImport(id, scope = localScope()) {
    const row = this.stmts.getImport.get(id);
    if (!row) return null;
    if (!visibleRow(scope, row)) return null;
    return rowToImport(row, scope);
  }

  /** Imports the scope may see: its own and the shared ones (own first). */
  listImports(scope = localScope()) {
    const params = {};
    const where = visibleClause(scope, params, '');
    const rows = this.prepared(`SELECT * FROM imports ${where ? `WHERE ${where}` : ''} ORDER BY id DESC`).all(params);
    return rows.map((r) => rowToImport(r, scope)).sort((a, b) => Number(b.own) - Number(a.own) || b.id - a.id);
  }

  /** Share an import with everyone (or make it private again); admins only, enforced by the caller. */
  setImportShared(id, shared) {
    return this.transaction(() => {
      const changed = this.stmts.shareImport.run(shared ? 1 : 0, id).changes > 0;
      if (changed) this.stmts.shareGames.run(shared ? 1 : 0, id);
      return changed;
    });
  }

  /** Remove an import with its games and positions. */
  deleteImport(id) {
    return this.transaction(() => {
      this.stmts.deleteImportPositions.run(id);
      const games = this.stmts.deleteImportGames.run(id).changes;
      const removed = this.stmts.deleteImport.run(id).changes > 0;
      return { removed, games };
    });
  }

  /** How many games the scope can see and how deep the position index goes. */
  gamesTotal(scope = localScope()) {
    let games = 0;
    let positions = 0;
    let plies = 0;
    for (const imp of this.listImports(scope)) {
      games += imp.games;
      positions += imp.positions;
      plies = Math.max(plies, imp.plies);
    }
    return { games, positions, plies };
  }

  /**
   * Insert one game with its indexed positions. `positions` is a list of
   * { epd, ply, move } (move = the SAN played from that position, or null).
   * Returns the new id, or null if an identical game (same key) exists.
   */
  insertGame(g, positions) {
    const r = this.stmts.insertGame.run(
      g.importId, g.userId ?? LOCAL_USER_ID, g.shared ? 1 : 0, g.key, g.white ?? null, g.black ?? null, g.result || '*', g.date ?? null, g.event ?? null, g.site ?? null, g.round ?? null,
      g.whiteElo ?? null, g.blackElo ?? null, g.eco ?? null, g.opening ?? null, g.timeControl ?? null, g.termination ?? null,
      g.plies, g.moves.join(' '), g.bookPath ?? null, g.bookPly ?? 0, g.bookEco ?? null, g.bookName ?? null, g.bookFamily ?? null,
    );
    if (r.changes === 0) return null;
    const id = Number(r.lastInsertRowid);
    for (const p of positions) this.stmts.insertPosition.run(epdHash(p.epd), id, p.ply, p.move ?? null);
    return id;
  }

  /** Whether a game with this dedupe key is already stored. */
  hasGame(key) {
    return Boolean(this.stmts.hasGameKey.get(key));
  }

  getGame(id, scope = localScope()) {
    const row = this.stmts.getGame.get(id);
    if (!row || !visibleRow(scope, row)) return null;
    return rowToGame(row);
  }

  /**
   * Result counts for one position: games that reached it and how they
   * ended, from White's point of view (white/draws/black) and, when a player
   * is given, from that player's (wins/losses).
   */
  positionStats(epd, filter = {}) {
    const params = { $hash: epdHash(epd) };
    const where = ['p.hash = $hash', ...gameFilter(filter, params)];
    const row = this.prepared(`SELECT ${aggregates(filter)} FROM game_positions p JOIN games g ON g.id = p.game_id WHERE ${where.join(' AND ')}`).get(params);
    return row.games ? rowToStats(row) : null;
  }

  positionStatsMany(epds, filter = {}) {
    const out = {};
    for (const epd of epds) {
      const s = this.positionStats(epd, filter);
      if (s) out[epd] = s;
    }
    return out;
  }

  /** The moves played from a position in the imported games, most frequent first. */
  positionMoves(epd, filter = {}) {
    const params = { $hash: epdHash(epd) };
    const where = ['p.hash = $hash', 'p.move IS NOT NULL', ...gameFilter(filter, params)];
    const rows = this.prepared(`SELECT p.move AS san, ${aggregates(filter)} FROM game_positions p JOIN games g ON g.id = p.game_id
      WHERE ${where.join(' AND ')} GROUP BY p.move ORDER BY games DESC, san`).all(params);
    return rows.map((r) => ({ san: r.san, ...rowToStats(r) }));
  }

  /**
   * Games, most recent first. Filters: epd (games that reached a position,
   * each with the ply at which it did), eco / name / family (book
   * classification), player / color, scope (visibility).
   */
  listGames({ epd, eco, name, family, limit = 50, offset = 0, ...filter } = {}) {
    const params = {};
    const where = gameFilter(filter, params);
    let from = 'games g';
    let extra = '';
    if (epd) {
      params.$hash = epdHash(epd);
      from = 'game_positions p JOIN games g ON g.id = p.game_id';
      where.unshift('p.hash = $hash');
      extra = ', p.ply AS at_ply';
    }
    if (eco !== undefined) { params.$eco = eco; where.push(eco === null ? 'g.book_eco IS NULL' : 'g.book_eco = $eco'); }
    if (name !== undefined) { params.$name = name; where.push(name === null ? 'g.book_name IS NULL' : 'g.book_name = $name'); }
    if (family !== undefined) { params.$family = family; where.push(family === null ? 'g.book_family IS NULL' : 'g.book_family = $family'); }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.prepared(`SELECT COUNT(*) AS n FROM ${from} ${cond}`).get(params).n;
    params.$limit = Math.max(1, Math.min(500, Number(limit) || 50));
    params.$offset = Math.max(0, Number(offset) || 0);
    const rows = this.prepared(`SELECT g.*${extra} FROM ${from} ${cond} ORDER BY g.date DESC, g.id DESC LIMIT $limit OFFSET $offset`).all(params);
    return { total, games: rows.map(rowToGameSummary) };
  }

  /**
   * Imported games grouped by book opening ('opening' = ECO + name, 'family'
   * = the part of the name before the colon, 'eco' = ECO code), with result
   * counts, most frequent first. `path` is the shortest book line that leads
   * into the group, for navigation.
   */
  openingsSummary({ by = 'opening', limit = 40, ...filter } = {}) {
    const params = {};
    const where = gameFilter(filter, params);
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const group = { opening: 'g.book_eco, g.book_name', family: 'g.book_family', eco: 'g.book_eco' }[by];
    if (!group) throw new Error('by must be opening, family or eco');
    const shortest = (col) => `substr(MIN(CASE WHEN ${col} IS NULL THEN NULL ELSE printf('%04d', length(${col})) || ${col} END), 5)`;
    const total = this.prepared(`SELECT ${aggregates(filter)} FROM games g ${cond}`).get(params);
    params.$limit = Math.max(1, Math.min(1000, Number(limit) || 40));
    const rows = this.prepared(`SELECT g.book_eco AS eco, ${by === 'family' ? 'g.book_family' : by === 'eco' ? shortest('g.book_name') : 'g.book_name'} AS name,
        g.book_family AS family, ${shortest('g.book_path')} AS path, ${aggregates(filter)}
      FROM games g ${cond} GROUP BY ${group} ORDER BY games DESC, name LIMIT $limit`).all(params);
    return {
      by,
      total: total.games ? rowToStats(total) : { games: 0, white: 0, draws: 0, black: 0 },
      groups: rows.map((r) => ({
        eco: by === 'family' ? null : r.eco,
        name: r.name,
        family: r.family,
        path: r.path ? r.path.split(' ') : [],
        ...rowToStats(r),
      })),
    };
  }

  // ---- public contributor workers -------------------------------------

  /** Register a public contributor worker and return its row. */
  createPublicWorker({ tokenHash, name, now }) {
    const createdAt = now || new Date().toISOString();
    this.stmts.insertPublicWorker.run(tokenHash, name, createdAt, createdAt);
    return this.getPublicWorker(tokenHash);
  }

  getPublicWorker(tokenHash) {
    return this.stmts.getPublicWorker.get(tokenHash) || null;
  }

  /** Workers seen since `since` (ISO string). */
  listPublicWorkers(since) {
    return this.stmts.listPublicWorkers.all(since);
  }

  touchPublicWorker(tokenHash, { lastSeenAt, positionsDone } = {}) {
    const row = this.getPublicWorker(tokenHash);
    if (!row) return null;
    this.stmts.touchPublicWorker.run(
      lastSeenAt || new Date().toISOString(),
      positionsDone ?? row.positions_done,
      tokenHash,
    );
    return this.getPublicWorker(tokenHash);
  }

  removePublicWorker(tokenHash) {
    this.stmts.deletePublicWorker.run(tokenHash);
  }

  // ---- opening explorer -----------------------------------------------

  createExploreJob({ name, color, scope, params, total = 0, userId = LOCAL_USER_ID }) {
    const r = this.stmts.insertExploreJob.run(userId, name, color, JSON.stringify(scope), JSON.stringify(params), total, new Date().toISOString());
    return this.getExploreJob(Number(r.lastInsertRowid));
  }

  getExploreJob(id) {
    const row = this.stmts.getExploreJob.get(id);
    return row ? rowToExploreJob(row) : null;
  }

  listExploreJobs() {
    return this.stmts.listExploreJobs.all().map(rowToExploreJob);
  }

  /** The oldest job that is queued or was interrupted while running. */
  nextExploreJob() {
    const row = this.stmts.nextExploreJob.get();
    return row ? rowToExploreJob(row) : null;
  }

  updateExploreJob(id, fields) {
    const sets = [];
    const params = { $id: id };
    if (fields.status !== undefined) { sets.push('status = $status'); params.$status = fields.status; }
    if (fields.total !== undefined) { sets.push('total = $total'); params.$total = fields.total; }
    if (fields.done !== undefined) { sets.push('done = $done'); params.$done = fields.done; }
    if (fields.error !== undefined) { sets.push('error = $error'); params.$error = fields.error; }
    if (fields.startedAt) sets.push("started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
    if (fields.finishedAt) sets.push("finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    if (!sets.length) return this.getExploreJob(id);
    this.prepared(`UPDATE explore_jobs SET ${sets.join(', ')} WHERE id = $id`).run(params);
    return this.getExploreJob(id);
  }

  deleteExploreJob(id) {
    return this.transaction(() => {
      const results = this.stmts.deleteExploreResults.run(id).changes;
      const removed = this.stmts.deleteExploreJob.run(id).changes > 0;
      return { removed, results };
    });
  }

  saveExploreResult(jobId, { path, ply, eco, name, color, metrics }) {
    this.stmts.upsertExploreResult.run(jobId, path.join(' '), ply, eco ?? null, name ?? null, color, metrics.fit ?? 0, JSON.stringify(metrics), new Date().toISOString());
  }

  exploreResultPaths(jobId) {
    return this.stmts.exploreResultPaths.all(jobId).map((r) => r.path);
  }

  /** Results of one job (or of every job), best fit first. */
  exploreResults({ jobId, limit = 5000 } = {}) {
    const n = Math.max(1, Math.min(20000, Number(limit) || 5000));
    const rows = jobId ? this.stmts.exploreResults.all(jobId, n) : this.stmts.allExploreResults.all(n);
    return rows.map(rowToExploreResult);
  }
}

// ---- scope helpers ----------------------------------------------------

function ownsRow(scope, userId) {
  const o = owners(scope);
  return o === null || o.includes(userId);
}

function visibleRow(scope, row) {
  return ownsRow(scope, row.user_id) || Boolean(row.shared);
}

/** `col IN (...)` for the rows the scope owns; '' when unrestricted; 'NONE' when it owns nothing. */
function ownerClause(scope, params, col) {
  const o = owners(scope);
  if (o === null) return '';
  if (!o.length) return 'NONE';
  params.$o0 = o[0];
  params.$o1 = o[1] ?? o[0];
  return `${col} IN ($o0, $o1)`;
}

/** Visibility of imports/games: shared, or owned. `prefix` is 'g.' for games. */
function visibleClause(scope, params, prefix) {
  const o = owners(scope);
  if (o === null) return '';
  if (!o.length) return `${prefix}shared = 1`;
  params.$o0 = o[0];
  params.$o1 = o[1] ?? o[0];
  return `(${prefix}shared = 1 OR ${prefix}user_id IN ($o0, $o1))`;
}

/** WHERE clauses for the player / colour / import / visibility filters; adds their params. */
function gameFilter(filter, params) {
  const where = [];
  if (filter.player) {
    params.$player = String(filter.player).toLowerCase();
    if (filter.color === 'white') where.push('LOWER(g.white) = $player');
    else if (filter.color === 'black') where.push('LOWER(g.black) = $player');
    else where.push('(LOWER(g.white) = $player OR LOWER(g.black) = $player)');
  }
  if (filter.importId) {
    params.$import = Number(filter.importId);
    where.push('g.import_id = $import');
  }
  if (filter.scope) {
    const v = visibleClause(filter.scope, params, 'g.');
    if (v) where.push(v);
  }
  return where;
}

function aggregates(filter) {
  let s = `COUNT(*) AS games, SUM(g.result = '1-0') AS white, SUM(g.result = '1/2-1/2') AS draws, SUM(g.result = '0-1') AS black`;
  if (filter.player) {
    s += `, SUM((g.result = '1-0' AND LOWER(g.white) = $player) OR (g.result = '0-1' AND LOWER(g.black) = $player)) AS wins`
      + `, SUM((g.result = '0-1' AND LOWER(g.white) = $player) OR (g.result = '1-0' AND LOWER(g.black) = $player)) AS losses`;
  }
  return s;
}

function rowToStats(r) {
  const out = { games: r.games, white: r.white ?? 0, draws: r.draws ?? 0, black: r.black ?? 0 };
  if (r.wins !== undefined) {
    out.wins = r.wins ?? 0;
    out.losses = r.losses ?? 0;
  }
  return out;
}

function cleanLine(line) {
  return {
    multipv: line.multipv,
    score: { type: line.score.type, value: line.score.value },
    pv: line.pv,
  };
}

function rowToAnalysis(row) {
  return {
    epd: row.epd,
    depth: row.depth,
    multipv: row.multipv,
    bestMove: row.best_move,
    score: row.score_type ? { type: row.score_type, value: row.score } : null,
    lines: JSON.parse(row.lines),
    nodes: row.nodes,
    engine: row.engine,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

function rowToStudy(row) {
  return {
    id: row.id,
    san: row.san.split(' '),
    color: row.color,
    name: row.name,
    eco: row.eco,
    box: row.box,
    due: row.due,
    attempts: row.attempts,
    correct: row.correct,
    streak: row.streak,
    lastResult: row.last_result,
    lastStudied: row.last_studied,
    addedAt: row.added_at,
  };
}

function rowToUser(row) {
  return {
    id: row.id,
    sub: row.google_sub,
    email: row.email,
    name: row.name,
    picture: row.picture,
    admin: Boolean(row.admin),
    createdAt: row.created_at,
    lastLogin: row.last_login,
  };
}

function rowToImport(row, scope = localScope()) {
  return {
    id: row.id,
    name: row.name,
    player: row.player,
    source: row.source ?? null,
    games: row.games,
    positions: row.positions,
    duplicates: row.duplicates,
    invalid: row.invalid,
    bytes: row.bytes,
    plies: row.plies,
    ms: row.ms,
    error: row.error,
    finished: Boolean(row.finished),
    shared: Boolean(row.shared),
    own: ownsRow(scope, row.user_id),
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

function rowToGameSummary(row) {
  return {
    id: row.id,
    importId: row.import_id,
    white: row.white,
    black: row.black,
    result: row.result,
    date: row.date,
    event: row.event,
    site: row.site,
    round: row.round,
    whiteElo: row.white_elo,
    blackElo: row.black_elo,
    eco: row.eco,
    opening: row.opening,
    timeControl: row.time_control,
    termination: row.termination,
    plies: row.plies,
    book: { path: row.book_path ? row.book_path.split(' ') : [], ply: row.book_ply, eco: row.book_eco, name: row.book_name, family: row.book_family },
    ...(row.at_ply !== undefined ? { atPly: row.at_ply } : {}),
  };
}

function rowToGame(row) {
  return { ...rowToGameSummary(row), moves: row.moves ? row.moves.split(' ') : [] };
}

function rowToExploreJob(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    color: row.color,
    scope: JSON.parse(row.scope),
    params: JSON.parse(row.params),
    status: row.status,
    total: row.total,
    done: row.done,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToExploreResult(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    path: row.path.split(' '),
    ply: row.ply,
    eco: row.eco,
    name: row.name,
    color: row.color,
    fit: row.fit,
    ...JSON.parse(row.metrics),
    createdAt: row.created_at,
  };
}
