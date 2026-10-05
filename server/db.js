import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analysis_depth ON analysis(depth);

CREATE TABLE IF NOT EXISTS study_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
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
  UNIQUE(san, color)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Imported games. One row per PGN import, one per game, and one per
-- (position, game) pair for the first plies of every game, so "how often did
-- this position occur and how did those games end" is an index lookup.
CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  player      TEXT,
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

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA cache_size = -32000');
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
    this.cache = new Map();
    this.stmts = {
      getAnalysis: db.prepare('SELECT * FROM analysis WHERE epd = ?'),
      upsertAnalysis: db.prepare(`
        INSERT INTO analysis (epd, depth, multipv, best_move, score_type, score, lines, nodes, engine, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(epd) DO UPDATE SET
          depth = excluded.depth, multipv = excluded.multipv, best_move = excluded.best_move,
          score_type = excluded.score_type, score = excluded.score, lines = excluded.lines,
          nodes = excluded.nodes, engine = excluded.engine, source = excluded.source,
          updated_at = excluded.updated_at`),
      depthOf: db.prepare('SELECT depth, multipv FROM analysis WHERE epd = ?'),
      allDepths: db.prepare('SELECT epd, depth FROM analysis'),
      stats: db.prepare('SELECT COUNT(*) AS count, MIN(depth) AS min, AVG(depth) AS avg, MAX(depth) AS max FROM analysis'),
      histogram: db.prepare('SELECT depth, COUNT(*) AS count FROM analysis GROUP BY depth ORDER BY depth'),
      allAnalysis: db.prepare('SELECT * FROM analysis ORDER BY epd'),

      listStudy: db.prepare('SELECT * FROM study_lines ORDER BY due, id'),
      getStudy: db.prepare('SELECT * FROM study_lines WHERE id = ?'),
      findStudy: db.prepare('SELECT * FROM study_lines WHERE san = ? AND color = ?'),
      insertStudy: db.prepare(`INSERT INTO study_lines (san, color, name, eco, box, due, added_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)`),
      deleteStudy: db.prepare('DELETE FROM study_lines WHERE id = ?'),
      updateStudy: db.prepare(`UPDATE study_lines SET box = ?, due = ?, attempts = attempts + 1,
        correct = correct + ?, streak = ?, last_result = ?, last_studied = ? WHERE id = ?`),

      getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

      insertImport: db.prepare('INSERT INTO imports (name, player, plies, created_at) VALUES (?, ?, ?, ?)'),
      finishImport: db.prepare(`UPDATE imports SET games = ?, positions = ?, duplicates = ?, invalid = ?, bytes = ?, ms = ?, error = ?, finished = 1
        WHERE id = ?`),
      listImports: db.prepare('SELECT * FROM imports ORDER BY id DESC'),
      getImport: db.prepare('SELECT * FROM imports WHERE id = ?'),
      deleteImportPositions: db.prepare('DELETE FROM game_positions WHERE game_id IN (SELECT id FROM games WHERE import_id = ?)'),
      deleteImportGames: db.prepare('DELETE FROM games WHERE import_id = ?'),
      deleteImport: db.prepare('DELETE FROM imports WHERE id = ?'),
      gamesTotal: db.prepare('SELECT COUNT(*) AS games FROM games'),
      insertGame: db.prepare(`INSERT OR IGNORE INTO games (import_id, key, white, black, result, date, event, site, round,
        white_elo, black_elo, eco, opening, time_control, termination, plies, moves, book_path, book_ply, book_eco, book_name, book_family)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertPosition: db.prepare('INSERT OR IGNORE INTO game_positions (hash, game_id, ply, move) VALUES (?, ?, ?, ?)'),
      getGame: db.prepare('SELECT * FROM games WHERE id = ?'),
      hasGameKey: db.prepare('SELECT 1 FROM games WHERE key = ?'),
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

  // ---- study lines ----------------------------------------------------

  listStudyLines() {
    return this.stmts.listStudy.all().map(rowToStudy);
  }

  getStudyLine(id) {
    const row = this.stmts.getStudy.get(id);
    return row ? rowToStudy(row) : null;
  }

  addStudyLine({ san, color, name, eco }) {
    if (!Array.isArray(san) || san.length === 0) throw new Error('san moves required');
    if (color !== 'white' && color !== 'black') throw new Error('color must be white or black');
    const key = san.join(' ');
    const existing = this.stmts.findStudy.get(key, color);
    if (existing) return { created: false, line: rowToStudy(existing) };
    const now = new Date().toISOString();
    const result = this.stmts.insertStudy.run(key, color, name || key, eco || null, now, now);
    return { created: true, line: this.getStudyLine(Number(result.lastInsertRowid)) };
  }

  removeStudyLine(id) {
    return this.stmts.deleteStudy.run(id).changes > 0;
  }

  /** Record a drill result and reschedule the line (Leitner boxes). */
  recordStudyResult(id, correct, now = new Date()) {
    const line = this.getStudyLine(id);
    if (!line) return null;
    const box = correct ? Math.min(line.box + 1, BOX_INTERVAL_DAYS.length - 1) : 0;
    const days = BOX_INTERVAL_DAYS[box];
    const due = new Date(now.getTime() + days * 86400000).toISOString();
    const streak = correct ? line.streak + 1 : 0;
    this.stmts.updateStudy.run(box, due, correct ? 1 : 0, streak, correct ? 'correct' : 'wrong', now.toISOString(), id);
    return this.getStudyLine(id);
  }

  // ---- settings -------------------------------------------------------

  getSetting(key, fallback = null) {
    const row = this.stmts.getSetting.get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.stmts.setSetting.run(key, JSON.stringify(value));
  }

  // ---- imported games -------------------------------------------------

  createImport({ name, player, plies }) {
    const r = this.stmts.insertImport.run(name, player || null, plies, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  finishImport(id, { games, positions, duplicates, invalid, bytes, ms, error = null }) {
    this.stmts.finishImport.run(games, positions, duplicates, invalid, bytes, ms, error, id);
    return this.getImport(id);
  }

  getImport(id) {
    const row = this.stmts.getImport.get(id);
    return row ? rowToImport(row) : null;
  }

  listImports() {
    return this.stmts.listImports.all().map(rowToImport);
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

  /** How many games are stored and how deep the position index goes. */
  gamesTotal() {
    const r = this.stmts.gamesTotal.get();
    let positions = 0;
    let plies = 0;
    for (const imp of this.listImports()) {
      positions += imp.positions;
      plies = Math.max(plies, imp.plies);
    }
    return { games: r.games, positions, plies };
  }

  /**
   * Insert one game with its indexed positions. `positions` is a list of
   * { epd, ply, move } (move = the SAN played from that position, or null).
   * Returns the new id, or null if an identical game (same key) exists.
   */
  insertGame(g, positions) {
    const r = this.stmts.insertGame.run(
      g.importId, g.key, g.white ?? null, g.black ?? null, g.result || '*', g.date ?? null, g.event ?? null, g.site ?? null, g.round ?? null,
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

  getGame(id) {
    const row = this.stmts.getGame.get(id);
    return row ? rowToGame(row) : null;
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
   * classification), player / color.
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
}

/** WHERE clauses for the player / colour / import filters; adds their params. */
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

function rowToImport(row) {
  return {
    id: row.id,
    name: row.name,
    player: row.player,
    games: row.games,
    positions: row.positions,
    duplicates: row.duplicates,
    invalid: row.invalid,
    bytes: row.bytes,
    plies: row.plies,
    ms: row.ms,
    error: row.error,
    finished: Boolean(row.finished),
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
