// Browser-only implementation of the JSON API, used by the GitHub Pages build
// (see scripts/build-pages.js), where there is no server. The opening book is
// a static file; stored engine analysis and the study set live in
// localStorage. Features that need the server (imported games, the opening
// explorer, server-side deepening, contributor workers) answer as "empty" and
// the build hides their panels.

const BOX_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60];
const KEY_ANALYSIS = 'static:analysis';
const KEY_STUDY = 'static:study';

const memory = new Map();
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch { /* storage unavailable: fall through to memory */ }
  return memory.has(key) ? memory.get(key) : fallback;
}
function save(key, value) {
  memory.set(key, value);
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or private mode: kept in memory for this tab */ }
}

function unavailable(what) {
  const err = new Error(`${what} needs the self-hosted server; this page runs entirely in your browser`);
  err.status = 404;
  return err;
}

let bookIndex = null;
function index() {
  bookIndex ||= fetch('./book-index.json').then((r) => r.json());
  return bookIndex;
}

let analysis = null;
const stored = () => (analysis ||= load(KEY_ANALYSIS, {}));

let study = null;
const studyState = () => (study ||= load(KEY_STUDY, { nextId: 1, lines: [] }));

const noGames = { imports: [], total: 0, running: null, canImport: false, canShare: false };

export const staticApi = {
  me: async () => ({ mode: 'off', user: null, admin: true }),
  logout: async () => ({}),
  openings: () => fetch('./openings.json').then((r) => r.json()),

  analysis: async (epd) => ({ epd, analysis: stored()[epd] || null }),
  analysisBatch: async (epds) => {
    const all = stored();
    const out = {};
    for (const epd of epds) if (all[epd]) out[epd] = all[epd];
    return { analysis: out };
  },
  saveAnalysis: async (record) => {
    const { epd, depth, lines } = record;
    if (!epd || !Number.isInteger(depth) || depth < 1 || !Array.isArray(lines) || !lines.length) throw new Error('epd, depth and lines required');
    const all = stored();
    const existing = all[epd];
    if (existing && (existing.depth > depth || (existing.depth === depth && existing.multipv >= lines.length))) {
      return { stored: false, analysis: existing };
    }
    const clean = lines.map((l, i) => ({ multipv: i + 1, score: { type: l.score.type, value: Math.trunc(Number(l.score.value)) }, pv: l.pv.slice(0, 40) }));
    all[epd] = {
      epd,
      depth,
      multipv: clean.length,
      bestMove: clean[0].pv[0] ?? null,
      score: clean[0].score,
      lines: clean,
      nodes: record.nodes ?? null,
      engine: record.engine ?? null,
      source: 'browser',
      updatedAt: new Date().toISOString(),
    };
    save(KEY_ANALYSIS, all);
    return { stored: true, analysis: all[epd] };
  },
  stats: async () => {
    const idx = await index();
    const all = Object.values(stored());
    const depths = new Map();
    for (const a of all) depths.set(a.depth, (depths.get(a.depth) || 0) + 1);
    const buckets = { none: 0, shallow: 0, medium: 0, deep: 0 };
    let analysed = 0;
    for (const epd of Object.keys(idx.epdEco)) {
      const d = stored()[epd]?.depth ?? 0;
      if (d > 0) analysed++;
      if (d === 0) buckets.none++;
      else if (d < 15) buckets.shallow++;
      else if (d < 25) buckets.medium++;
      else buckets.deep++;
    }
    const sum = all.reduce((s, a) => s + a.depth, 0);
    return {
      count: all.length,
      minDepth: all.length ? Math.min(...all.map((a) => a.depth)) : 0,
      avgDepth: all.length ? Math.round((sum / all.length) * 10) / 10 : 0,
      maxDepth: all.length ? Math.max(...all.map((a) => a.depth)) : 0,
      histogram: [...depths].sort((a, b) => a[0] - b[0]).map(([depth, count]) => ({ depth, count })),
      book: { positions: Object.keys(idx.epdEco).length, analysed, buckets },
    };
  },
  eco: async () => {
    const idx = await index();
    const codes = {};
    for (const [eco, c] of Object.entries(idx.codes)) codes[eco] = { positions: c.positions, openings: c.openings, analysed: 0, minDepth: Infinity, depthSum: 0 };
    for (const [epd, eco] of Object.entries(idx.epdEco)) {
      const c = codes[eco];
      if (!c) continue;
      const d = stored()[epd]?.depth ?? 0;
      if (d > 0) c.analysed++;
      c.depthSum += d;
      c.minDepth = Math.min(c.minDepth, d);
    }
    for (const c of Object.values(codes)) {
      c.avgDepth = c.positions ? Math.round((c.depthSum / c.positions) * 10) / 10 : 0;
      if (!Number.isFinite(c.minDepth)) c.minDepth = 0;
      delete c.depthSum;
    }
    return { codes };
  },

  studyList: async () => ({ lines: [...studyState().lines].sort((a, b) => a.due.localeCompare(b.due) || a.id - b.id), now: new Date().toISOString(), signInRequired: false }),
  studyAdd: async ({ san, color, name, eco }) => {
    if (!Array.isArray(san) || !san.length) throw new Error('san moves required');
    if (color !== 'white' && color !== 'black') throw new Error('color must be white or black');
    const s = studyState();
    const found = s.lines.find((l) => l.color === color && l.san.join(' ') === san.join(' '));
    if (found) return { created: false, line: found };
    const now = new Date().toISOString();
    const line = {
      id: s.nextId++, san, color, name: name || san.join(' '), eco: eco || null,
      box: 0, due: now, attempts: 0, correct: 0, streak: 0, lastResult: null, lastStudied: null, addedAt: now,
    };
    s.lines.push(line);
    save(KEY_STUDY, s);
    return { created: true, line };
  },
  studyRemove: async (id) => {
    const s = studyState();
    const before = s.lines.length;
    s.lines = s.lines.filter((l) => l.id !== Number(id));
    save(KEY_STUDY, s);
    return { removed: s.lines.length < before };
  },
  studyResult: async (id, correct) => {
    const s = studyState();
    const line = s.lines.find((l) => l.id === Number(id));
    if (!line) throw Object.assign(new Error('no such study line'), { status: 404 });
    const now = new Date();
    line.box = correct ? Math.min(line.box + 1, BOX_INTERVAL_DAYS.length - 1) : 0;
    line.due = new Date(now.getTime() + BOX_INTERVAL_DAYS[line.box] * 86400000).toISOString();
    line.attempts += 1;
    if (correct) line.correct += 1;
    line.streak = correct ? line.streak + 1 : 0;
    line.lastResult = correct ? 'correct' : 'wrong';
    line.lastStudied = now.toISOString();
    save(KEY_STUDY, s);
    return { line };
  },

  // ---- server-only features ---------------------------------------------
  workers: async () => ({ workers: [], at: new Date().toISOString() }),
  deepenStatus: async () => ({ running: false, stopping: false, targetDepth: 20, multipv: 3, scope: [], total: 0, remaining: 0, done: 0, current: null, analysed: 0, improved: 0, lastError: null }),
  deepenStart: async () => { throw unavailable('Server deepening'); },
  deepenStop: async () => { throw unavailable('Server deepening'); },
  deepenConfigure: async () => { throw unavailable('Server deepening'); },
  deepenPrioritize: async () => ({ queued: 0 }),
  deepenNext: async () => ({ positions: [] }),

  gamesImports: async () => noGames,
  gamesImport: async () => { throw unavailable('Importing games'); },
  gamesDeleteImport: async () => { throw unavailable('Importing games'); },
  gamesShare: async () => { throw unavailable('Importing games'); },
  gamesPositions: async () => ({ positions: {} }),
  gamesPosition: async (epd) => ({ epd, stats: null, moves: [] }),
  gamesOpenings: async () => ({ rows: [], total: 0 }),
  gamesList: async () => ({ games: [], total: 0 }),
  game: async () => { throw unavailable('Imported games'); },

  exploreStatus: async () => ({ running: false, workers: 0, pool: null, current: null, analysed: 0, lastError: null, jobs: [] }),
  publicWorkers: async () => { throw Object.assign(unavailable('Contributor workers'), { status: 503 }); },
  publicWorkerJoin: async () => { throw unavailable('Contributor workers'); },
  exploreAdd: async () => { throw unavailable('The opening explorer'); },
  exploreRemove: async () => { throw unavailable('The opening explorer'); },
  exploreStart: async () => { throw unavailable('The opening explorer'); },
  exploreStop: async () => { throw unavailable('The opening explorer'); },
  exploreResults: async () => ({ results: [] }),
};
