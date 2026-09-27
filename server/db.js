import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
`;

// Leitner boxes: how many days until a line is due again after a success.
export const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60];

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
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
    };
  }

  close() {
    this.db.close();
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
