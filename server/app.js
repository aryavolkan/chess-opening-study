// HTTP request handler: static files (the front end and vendored libraries)
// plus the JSON API. Built as a plain function over node:http so it can be
// exercised in tests without opening a port.

import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { nearestName } from '../shared/book.js';
import { epdOf } from '../shared/fen.js';
import { Importer } from './games.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function vendorRoots() {
  // Resolved by directory rather than require.resolve: chessground's
  // `exports` map hides its package.json from resolution.
  const nm = join(ROOT, 'node_modules');
  const stockfishDir = join(nm, 'stockfish');
  const chessgroundDir = join(nm, '@lichess-org', 'chessground');
  const chessDir = join(nm, 'chess.js');
  return {
    '/vendor/stockfish/': join(stockfishDir, 'bin'),
    '/vendor/chessground/assets/': join(chessgroundDir, 'assets'),
    '/vendor/chessground/': join(chessgroundDir, 'dist'),
    '/vendor/chess.js/': join(chessDir, 'dist', 'esm'),
  };
}

const MAX_BODY = 2 * 1024 * 1024;

export function createApp({ store, book, deepener, explorer = null, importer = new Importer({ store, book }), log = () => {} }) {
  const vendors = vendorRoots();
  const openingsPayload = JSON.stringify({
    count: book.openings.length,
    openings: book.openings.map((op, i) => ({ id: i, eco: op.eco, name: op.name, pgn: op.pgn, san: op.san })),
  });
  const openingsGz = gzipSync(openingsPayload);
  // Every book position tagged with the ECO code of its nearest named ancestor
  const positionEco = new Map();
  (function tag(node) {
    const named = nearestName(node);
    positionEco.set(node.epd, named ? named.eco : null);
    for (const child of node.children.values()) tag(child);
  })(book.root);
  const uniqueBookEpds = new Set(book.positions.map((p) => p.epd));

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, openings: book.openings.length, positions: uniqueBookEpds.size })],

    ['GET', /^\/api\/openings$/, (req, res) => {
      sendRaw(req, res, 200, 'application/json; charset=utf-8', openingsPayload, openingsGz);
      return SENT;
    }],

    ['GET', /^\/api\/analysis$/, (req) => {
      const epd = req.query.get('epd') || (req.query.get('fen') ? epdOf(req.query.get('fen')) : null);
      if (!epd) throw httpError(400, 'epd or fen query parameter required');
      return { epd, analysis: store.getAnalysis(epd) };
    }],

    ['POST', /^\/api\/analysis\/batch$/, (req) => {
      const epds = req.body?.epds;
      if (!Array.isArray(epds) || epds.length > 5000) throw httpError(400, 'epds must be an array of at most 5000 keys');
      return { analysis: store.getAnalysisMany(epds.map(String)) };
    }],

    ['POST', /^\/api\/analysis$/, (req) => {
      const b = req.body || {};
      const epd = b.epd || (b.fen ? epdOf(b.fen) : null);
      const lines = validateLines(b.lines);
      const depth = Number(b.depth);
      if (!epd || !Number.isInteger(depth) || depth < 1 || depth > 99) throw httpError(400, 'epd and integer depth required');
      const result = store.saveAnalysis({
        epd, depth, lines, nodes: numberOrNull(b.nodes), engine: stringOrNull(b.engine), source: 'browser',
      });
      return { stored: result.stored, analysis: result.analysis };
    }],

    ['GET', /^\/api\/analysis\/stats$/, () => {
      const stats = store.analysisStats();
      const depths = store.depthMap();
      let analysed = 0;
      const buckets = { none: 0, shallow: 0, medium: 0, deep: 0 };
      for (const epd of uniqueBookEpds) {
        const d = depths.get(epd) ?? 0;
        if (d > 0) analysed++;
        if (d === 0) buckets.none++;
        else if (d < 15) buckets.shallow++;
        else if (d < 25) buckets.medium++;
        else buckets.deep++;
      }
      return { ...stats, book: { positions: uniqueBookEpds.size, analysed, buckets } };
    }],

    ['GET', /^\/api\/analysis\/export$/, () => ({ exportedAt: new Date().toISOString(), analysis: store.exportAnalysis() })],

    ['GET', /^\/api\/eco$/, () => {
      const depths = store.depthMap();
      const codes = {};
      for (const pos of book.positions) {
        const eco = positionEco.get(pos.epd);
        if (!eco) continue;
        const c = codes[eco] || (codes[eco] = { positions: 0, analysed: 0, depthSum: 0, minDepth: Infinity, openings: 0 });
        c.positions++;
        const d = depths.get(pos.epd) ?? 0;
        if (d > 0) c.analysed++;
        c.depthSum += d;
        c.minDepth = Math.min(c.minDepth, d);
      }
      for (const op of book.openings) {
        const c = codes[op.eco] || (codes[op.eco] = { positions: 0, analysed: 0, depthSum: 0, minDepth: 0, openings: 0 });
        c.openings++;
      }
      for (const c of Object.values(codes)) {
        c.avgDepth = c.positions ? Math.round((c.depthSum / c.positions) * 10) / 10 : 0;
        if (!Number.isFinite(c.minDepth)) c.minDepth = 0;
        delete c.depthSum;
      }
      return { codes };
    }],

    ['GET', /^\/api\/deepen$/, () => deepener.status()],
    ['POST', /^\/api\/deepen\/start$/, async (req) => deepener.start(req.body || {})],
    ['POST', /^\/api\/deepen\/stop$/, async () => deepener.stop()],
    ['POST', /^\/api\/deepen\/configure$/, (req) => { deepener.configure(req.body || {}); return deepener.status(); }],
    ['GET', /^\/api\/deepen\/next$/, (req) => {
      const count = Math.max(1, Math.min(50, Number(req.query.get('count')) || 5));
      const target = Math.max(1, Math.min(60, Number(req.query.get('targetDepth')) || deepener.targetDepth));
      return { targetDepth: target, positions: deepener.nextPositions(count, target) };
    }],
    ['POST', /^\/api\/deepen\/prioritize$/, (req) => {
      const epds = req.body?.epds;
      if (!Array.isArray(epds) || epds.length > 2000) throw httpError(400, 'epds must be an array of at most 2000 keys');
      return { queued: deepener.prioritize(epds.map(String)), status: deepener.status() };
    }],

    // ---- imported games ----
    ['GET', /^\/api\/games\/imports$/, () => ({ imports: store.listImports(), total: store.gamesTotal(), running: importer.status() })],
    // The body is the PGN itself (optionally gzipped), streamed; not JSON.
    ['POST', /^\/api\/games\/import$/, async (req) => {
      const q = req.query;
      const record = await importer.importStream(req, {
        name: q.get('name') || 'PGN import',
        player: q.get('player') || null,
        maxPlies: q.has('plies') ? Number(q.get('plies')) : undefined,
        gzip: /\bgzip\b/.test(req.headers['content-encoding'] || ''),
      });
      if (record.games === 0 && record.duplicates === 0) {
        store.deleteImport(record.id);
        throw httpError(400, record.error ? `import failed: ${record.error}` : 'no games found in the PGN');
      }
      return { import: record };
    }, { raw: true }],
    ['DELETE', /^\/api\/games\/imports\/(\d+)$/, (req, res, m) => {
      if (importer.status()?.id === Number(m[1])) throw httpError(409, 'this import is still running');
      return store.deleteImport(Number(m[1]));
    }],
    ['POST', /^\/api\/games\/positions$/, (req) => {
      const epds = req.body?.epds;
      if (!Array.isArray(epds) || epds.length > 5000) throw httpError(400, 'epds must be an array of at most 5000 keys');
      return { positions: store.positionStatsMany(epds.map(String), gamesFilter(req.body || {})) };
    }],
    ['GET', /^\/api\/games\/position$/, (req) => {
      const epd = req.query.get('epd') || (req.query.get('fen') ? epdOf(req.query.get('fen')) : null);
      if (!epd) throw httpError(400, 'epd or fen query parameter required');
      const filter = gamesFilter(queryObject(req.query));
      return { epd, stats: store.positionStats(epd, filter), moves: store.positionMoves(epd, filter) };
    }],
    ['GET', /^\/api\/games\/openings$/, (req) => {
      const q = req.query;
      const by = q.get('by') || 'opening';
      if (!['opening', 'family', 'eco'].includes(by)) throw httpError(400, 'by must be opening, family or eco');
      return store.openingsSummary({ by, limit: q.get('limit') || 40, ...gamesFilter(queryObject(q)) });
    }],
    ['GET', /^\/api\/games$/, (req) => {
      const q = req.query;
      const opts = { ...gamesFilter(queryObject(q)), limit: q.get('limit') || 50, offset: q.get('offset') || 0 };
      if (q.has('epd')) opts.epd = q.get('epd');
      for (const k of ['eco', 'name', 'family']) if (q.has(k)) opts[k] = q.get(k) || null;
      return store.listGames(opts);
    }],
    ['GET', /^\/api\/games\/(\d+)$/, (req, res, m) => {
      const game = store.getGame(Number(m[1]));
      if (!game) throw httpError(404, 'no such game');
      return { game };
    }],

    // ---- opening explorer ----
    ['GET', /^\/api\/explore$/, () => needExplorer().status()],
    ['POST', /^\/api\/explore\/jobs$/, (req) => ({ job: needExplorer().addJob(req.body || {}), status: needExplorer().status() })],
    ['DELETE', /^\/api\/explore\/jobs\/(\d+)$/, (req, res, m) => needExplorer().removeJob(Number(m[1]))],
    ['POST', /^\/api\/explore\/start$/, async (req) => needExplorer().start(req.body || {})],
    ['POST', /^\/api\/explore\/stop$/, async () => needExplorer().stop()],
    ['GET', /^\/api\/explore\/results$/, (req) => {
      const jobId = req.query.has('job') ? Number(req.query.get('job')) : undefined;
      return { results: store.exploreResults({ jobId, limit: req.query.get('limit') || 5000 }) };
    }],

    ['GET', /^\/api\/study$/, () => ({ lines: store.listStudyLines(), now: new Date().toISOString() })],
    ['POST', /^\/api\/study$/, (req) => {
      const b = req.body || {};
      return store.addStudyLine({ san: b.san, color: b.color, name: b.name, eco: b.eco });
    }],
    ['DELETE', /^\/api\/study\/(\d+)$/, (req, res, m) => ({ removed: store.removeStudyLine(Number(m[1])) })],
    ['POST', /^\/api\/study\/(\d+)\/result$/, (req, res, m) => {
      const line = store.recordStudyResult(Number(m[1]), Boolean(req.body?.correct));
      if (!line) throw httpError(404, 'no such study line');
      return { line };
    }],
  ];

  function needExplorer() {
    if (!explorer) throw httpError(503, 'the opening explorer is not available');
    return explorer;
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    req.query = url.searchParams;
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) {
        for (const [method, re, fn, opts = {}] of routes) {
          const m = re.exec(path);
          if (!m || method !== req.method) continue;
          if ((method === 'POST' || method === 'PUT') && !opts.raw) req.body = await readJson(req);
          const out = await fn(req, res, m);
          if (out !== SENT) sendJson(req, res, 200, out);
          return;
        }
        throw httpError(404, 'not found');
      }
      await serveStatic(req, res, path, vendors);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log('error', err);
      if (!res.headersSent) sendJson(req, res, status, { error: err.message || 'error' });
      else res.end();
    }
  };
}

const SENT = Symbol('sent');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(v) {
  return typeof v === 'string' ? v.slice(0, 100) : null;
}

/** player / color / importId filter from a query or body object. */
function gamesFilter(o) {
  const filter = {};
  if (typeof o.player === 'string' && o.player.trim()) {
    filter.player = o.player.trim();
    if (o.color === 'white' || o.color === 'black') filter.color = o.color;
  }
  if (o.import && Number.isInteger(Number(o.import))) filter.importId = Number(o.import);
  return filter;
}

function queryObject(query) {
  return Object.fromEntries(query.entries());
}

function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 10) throw httpError(400, 'lines must be a non-empty array');
  return lines.map((l, i) => {
    const ok = l && l.score && (l.score.type === 'cp' || l.score.type === 'mate') && Number.isFinite(Number(l.score.value))
      && Array.isArray(l.pv) && l.pv.length > 0 && l.pv.every((m) => typeof m === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m));
    if (!ok) throw httpError(400, `line ${i + 1} is malformed`);
    return { multipv: i + 1, score: { type: l.score.type, value: Math.trunc(Number(l.score.value)) }, pv: l.pv.slice(0, 40) };
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

function sendRaw(req, res, status, type, body, gz) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
  if (gz && acceptsGzip(req)) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(gz);
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}

function sendJson(req, res, status, obj) {
  const body = JSON.stringify(obj);
  const gz = body.length > 1024 && acceptsGzip(req) ? gzipSync(body) : null;
  sendRaw(req, res, status, 'application/json; charset=utf-8', body, gz);
}

async function serveStatic(req, res, path, vendors) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'method not allowed');
  let file = null;
  let cache = 'no-cache';
  for (const [prefix, dir] of Object.entries(vendors)) {
    if (path.startsWith(prefix)) {
      file = safeJoin(dir, path.slice(prefix.length));
      cache = 'public, max-age=86400';
      break;
    }
  }
  if (!file) {
    if (path.startsWith('/shared/')) file = safeJoin(join(ROOT, 'shared'), path.slice('/shared/'.length));
    else file = safeJoin(join(ROOT, 'public'), path === '/' ? 'index.html' : path.slice(1));
  }
  if (!file) throw httpError(404, 'not found');
  let st;
  try {
    st = statSync(file);
  } catch {
    throw httpError(404, 'not found');
  }
  if (!st.isFile()) throw httpError(404, 'not found');
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': cache,
    // Needed if the multi-threaded engine build is ever enabled.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function safeJoin(dir, rel) {
  const target = normalize(join(dir, rel));
  if (!target.startsWith(dir + '/') && target !== dir) return null;
  return target;
}
