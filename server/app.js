// HTTP request handler: static files (the front end and vendored libraries),
// sign-in, and the JSON API. Built as a plain function over node:http so it
// can be exercised in tests without opening a port.
//
// Every API route has an access level: 'public' (anyone, read-only or
// harmless), 'user' (a signed-in account, or the local user when sign-in is
// off) or 'admin' (the server engines and sharing). Per-user data is read
// and written through the request's scope (see db.js).

import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { nearestName } from '../shared/book.js';
import { epdOf } from '../shared/fen.js';
import { Importer } from './games.js';
import { createAuth } from './auth.js';

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

export function createApp({ store, book, deepener, explorer = null, machines = null, importer = new Importer({ store, book }), auth = createAuth({ store }), log = () => {} }) {
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

  const PUBLIC = { access: 'public' };
  const USER = { access: 'user' };
  const ADMIN = { access: 'admin' };
  const WORKER = { access: 'worker' }; // a dedicated machine, by its bearer token

  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true, openings: book.openings.length, positions: uniqueBookEpds.size, signIn: auth.mode }), PUBLIC],

    ['GET', /^\/api\/openings$/, (req, res) => {
      sendRaw(req, res, 200, 'application/json; charset=utf-8', openingsPayload, openingsGz);
      return SENT;
    }, PUBLIC],

    ['GET', /^\/api\/analysis$/, (req) => {
      const epd = req.query.get('epd') || (req.query.get('fen') ? epdOf(req.query.get('fen')) : null);
      if (!epd) throw httpError(400, 'epd or fen query parameter required');
      return { epd, analysis: store.getAnalysis(epd) };
    }, PUBLIC],

    ['POST', /^\/api\/analysis\/batch$/, (req) => {
      const epds = req.body?.epds;
      if (!Array.isArray(epds) || epds.length > 5000) throw httpError(400, 'epds must be an array of at most 5000 keys');
      return { analysis: store.getAnalysisMany(epds.map(String)) };
    }, PUBLIC],

    ['POST', /^\/api\/analysis$/, (req) => {
      const b = req.body || {};
      const epd = b.epd || (b.fen ? epdOf(b.fen) : null);
      const lines = validateLines(b.lines);
      const depth = Number(b.depth);
      if (!epd || !Number.isInteger(depth) || depth < 1 || depth > 99) throw httpError(400, 'epd and integer depth required');
      if (!auth.rateLimit(`analysis:${req.user.id}`, 300, 60000)) throw httpError(429, 'too many analysis results, slow down');
      const result = store.saveAnalysis({
        epd, depth, lines, nodes: numberOrNull(b.nodes), engine: stringOrNull(b.engine), source: 'browser', userId: req.user.local ? null : req.user.id,
      });
      return { stored: result.stored, analysis: result.analysis };
    }, USER],

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
    }, PUBLIC],

    ['GET', /^\/api\/analysis\/export$/, () => ({ exportedAt: new Date().toISOString(), analysis: store.exportAnalysis() }), PUBLIC],

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
    }, PUBLIC],

    ['GET', /^\/api\/deepen$/, () => deepener.status(), PUBLIC],
    ['POST', /^\/api\/deepen\/start$/, async (req) => deepener.start(req.body || {}), ADMIN],
    ['POST', /^\/api\/deepen\/stop$/, async () => deepener.stop(), ADMIN],
    ['POST', /^\/api\/deepen\/configure$/, (req) => { deepener.configure(req.body || {}); return deepener.status(); }, ADMIN],
    ['GET', /^\/api\/deepen\/next$/, (req) => {
      const count = Math.max(1, Math.min(50, Number(req.query.get('count')) || 5));
      const target = Math.max(1, Math.min(60, Number(req.query.get('targetDepth')) || deepener.targetDepth));
      return { targetDepth: target, positions: deepener.nextPositions(count, target) };
    }, USER],
    ['POST', /^\/api\/deepen\/prioritize$/, (req) => {
      const epds = req.body?.epds;
      if (!Array.isArray(epds) || epds.length > 2000) throw httpError(400, 'epds must be an array of at most 2000 keys');
      return { queued: deepener.prioritize(epds.map(String)), status: deepener.status() };
    }, ADMIN],

    ['GET', /^\/api\/workers$/, () => {
      const workers = [];
      const d = deepener.status();
      if (d.running && d.current) workers.push({ source: 'deepener', epd: d.current.epd, depth: d.current.targetDepth ?? d.targetDepth });
      const e = explorer?.status();
      if (e?.running && e.pool?.working) {
        for (const w of e.pool.working) workers.push({ source: 'explorer', epd: epdOf(w.fen), depth: w.depth });
      }
      if (machines?.enabled) {
        for (const w of machines.workers()) workers.push({ source: w.source, epd: w.epd, depth: w.depth, progress: w.progress });
      }
      return { workers, at: new Date().toISOString() };
    }, PUBLIC],

    // ---- imported games ----
    ['GET', /^\/api\/games\/imports$/, (req) => ({
      imports: store.listImports(req.scope),
      total: store.gamesTotal(req.scope),
      running: importer.status(),
      canImport: Boolean(req.user),
      canShare: Boolean(req.user?.admin),
    }), PUBLIC],
    // The body is the PGN itself (optionally gzipped), streamed; not JSON.
    ['POST', /^\/api\/games\/import$/, async (req) => {
      const q = req.query;
      const record = await importer.importStream(req, {
        name: q.get('name') || 'PGN import',
        player: q.get('player') || null,
        maxPlies: q.has('plies') ? Number(q.get('plies')) : undefined,
        gzip: /\bgzip\b/.test(req.headers['content-encoding'] || ''),
        scope: req.scope,
      });
      if (record.games === 0 && record.duplicates === 0) {
        store.deleteImport(record.id);
        throw httpError(400, record.error ? `import failed: ${record.error}` : 'no games found in the PGN');
      }
      return { import: record };
    }, { ...USER, raw: true }],
    ['DELETE', /^\/api\/games\/imports\/(\d+)$/, (req, res, m) => {
      const id = Number(m[1]);
      if (importer.status()?.id === id) throw httpError(409, 'this import is still running');
      const imp = store.getImport(id, req.scope);
      if (!imp) throw httpError(404, 'no such import');
      if (!imp.own && !req.user.admin) throw httpError(403, 'only its owner or an admin can remove this import');
      return store.deleteImport(id);
    }, USER],
    ['POST', /^\/api\/games\/imports\/(\d+)\/share$/, (req, res, m) => {
      const id = Number(m[1]);
      if (!store.getImport(id, req.scope)) throw httpError(404, 'no such import');
      const shared = Boolean(req.body?.shared);
      store.setImportShared(id, shared);
      return { import: store.getImport(id, req.scope) };
    }, ADMIN],
    ['POST', /^\/api\/games\/positions$/, (req) => {
      const epds = req.body?.epds;
      if (!Array.isArray(epds) || epds.length > 5000) throw httpError(400, 'epds must be an array of at most 5000 keys');
      return { positions: store.positionStatsMany(epds.map(String), gamesFilter(req.body || {}, req)) };
    }, PUBLIC],
    ['GET', /^\/api\/games\/position$/, (req) => {
      const epd = req.query.get('epd') || (req.query.get('fen') ? epdOf(req.query.get('fen')) : null);
      if (!epd) throw httpError(400, 'epd or fen query parameter required');
      const filter = gamesFilter(queryObject(req.query), req);
      return { epd, stats: store.positionStats(epd, filter), moves: store.positionMoves(epd, filter) };
    }, PUBLIC],
    ['GET', /^\/api\/games\/openings$/, (req) => {
      const q = req.query;
      const by = q.get('by') || 'opening';
      if (!['opening', 'family', 'eco'].includes(by)) throw httpError(400, 'by must be opening, family or eco');
      return store.openingsSummary({ by, limit: q.get('limit') || 40, ...gamesFilter(queryObject(q), req) });
    }, PUBLIC],
    ['GET', /^\/api\/games$/, (req) => {
      const q = req.query;
      const opts = { ...gamesFilter(queryObject(q), req), limit: q.get('limit') || 50, offset: q.get('offset') || 0 };
      if (q.has('epd')) opts.epd = q.get('epd');
      for (const k of ['eco', 'name', 'family']) if (q.has(k)) opts[k] = q.get(k) || null;
      return store.listGames(opts);
    }, PUBLIC],
    ['GET', /^\/api\/games\/(\d+)$/, (req, res, m) => {
      const game = store.getGame(Number(m[1]), req.scope);
      if (!game) throw httpError(404, 'no such game');
      return { game };
    }, PUBLIC],

    // ---- opening explorer ----
    ['GET', /^\/api\/explore$/, () => needExplorer().status(), PUBLIC],
    ['POST', /^\/api\/explore\/jobs$/, (req) => ({ job: needExplorer().addJob(req.body || {}, { userId: req.user.id }), status: needExplorer().status() }), ADMIN],
    ['DELETE', /^\/api\/explore\/jobs\/(\d+)$/, (req, res, m) => needExplorer().removeJob(Number(m[1])), ADMIN],
    ['POST', /^\/api\/explore\/start$/, async (req) => needExplorer().start(req.body || {}), ADMIN],
    ['POST', /^\/api\/explore\/stop$/, async () => needExplorer().stop(), ADMIN],
    ['GET', /^\/api\/explore\/results$/, (req) => {
      const jobId = req.query.has('job') ? Number(req.query.get('job')) : undefined;
      return { results: store.exploreResults({ jobId, limit: req.query.get('limit') || 5000 }) };
    }, PUBLIC],

    // ---- dedicated analysis machines ----
    ['GET', /^\/api\/machines$/, (req) => needMachines().status(req.user, req.scope), PUBLIC],
    ['POST', /^\/api\/machines$/, async (req) => ({ machine: await needMachines().create(req.user, req.body || {}) }), USER],
    ['DELETE', /^\/api\/machines\/(\d+)$/, async (req, res, m) => ({ machine: await needMachines().stop(req.user, Number(m[1])) }), USER],
    ['POST', /^\/api\/machines\/requests$/, (req) => needMachines().request(req.user, req.body || {}), USER],
    ['DELETE', /^\/api\/machines\/requests\/(\d+)$/, (req, res, m) => needMachines().cancel(req.user, Number(m[1])), USER],
    ['POST', /^\/api\/machines\/worker\/next$/, (req) => needMachines().workerNext(req.machine, req.body || {}), WORKER],
    ['POST', /^\/api\/machines\/worker\/progress$/, (req) => needMachines().workerProgress(req.machine, req.body || {}), WORKER],
    ['POST', /^\/api\/machines\/worker\/result$/, (req) => needMachines().workerResult(req.machine, req.body || {}), WORKER],
    ['POST', /^\/api\/machines\/worker\/bye$/, (req) => needMachines().workerBye(req.machine), WORKER],

    // ---- study set (per user) ----
    ['GET', /^\/api\/study$/, (req) => ({ lines: req.user ? store.listStudyLines(req.scope) : [], now: new Date().toISOString(), signInRequired: !req.user }), PUBLIC],
    ['POST', /^\/api\/study$/, (req) => {
      const b = req.body || {};
      return store.addStudyLine({ san: b.san, color: b.color, name: b.name, eco: b.eco }, req.scope);
    }, USER],
    ['DELETE', /^\/api\/study\/(\d+)$/, (req, res, m) => ({ removed: store.removeStudyLine(Number(m[1]), req.scope) }), USER],
    ['POST', /^\/api\/study\/(\d+)\/result$/, (req, res, m) => {
      const line = store.recordStudyResult(Number(m[1]), Boolean(req.body?.correct), new Date(), req.scope);
      if (!line) throw httpError(404, 'no such study line');
      return { line };
    }, USER],
  ];

  function needExplorer() {
    if (!explorer) throw httpError(503, 'the opening explorer is not available');
    return explorer;
  }

  function needMachines() {
    if (!machines) throw httpError(503, 'dedicated machines are not available on this server');
    return machines;
  }

  /** player / color / import filter from a query or body object, plus the request's visibility scope. */
  function gamesFilter(o, req) {
    const filter = { scope: req.scope };
    if (typeof o.player === 'string' && o.player.trim()) {
      filter.player = o.player.trim();
      if (o.color === 'white' || o.color === 'black') filter.color = o.color;
    }
    if (o.import && Number.isInteger(Number(o.import))) filter.importId = Number(o.import);
    return filter;
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    req.query = url.searchParams;
    const path = url.pathname;
    try {
      if (path.startsWith('/auth/')) {
        await auth.handle(req, res, url);
        return;
      }
      if (path.startsWith('/api/')) {
        for (const [method, re, fn, opts = {}] of routes) {
          const m = re.exec(path);
          if (!m || method !== req.method) continue;
          if (opts.access === 'worker') {
            // Machines authenticate with the token they were started with, not a session
            const token = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '')?.[1];
            req.machine = needMachines().machineForToken(token);
            if (!req.machine) throw httpError(401, 'unknown or stopped machine');
          } else {
            req.user = auth.userFromRequest(req);
            req.scope = auth.scopeFor(req.user);
            const mutating = req.method !== 'GET' && req.method !== 'HEAD';
            if (mutating && auth.crossSite(req)) throw httpError(403, 'cross-site request refused');
            if (opts.access === 'user' && !req.user) throw httpError(401, 'sign in to do this');
            if (opts.access === 'admin' && !req.user?.admin) throw httpError(req.user ? 403 : 401, req.user ? 'only an admin of this site can do this' : 'sign in to do this');
          }
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
