// Public contributor worker: anyone can run this to help deepen the opening
// book. It connects with a token from /api/public-workers/join, pulls shallow
// positions, analyses them with Stockfish, and pushes results back.
//
// Environment: WORKER_API_URL, WORKER_TOKEN, WORKER_CPUS, WORKER_IDLE_SECONDS,
// WORKER_MAX_MINUTES, STOCKFISH_FLAVOR.

import { EnginePool } from './engine-pool.js';

const API = (process.env.WORKER_API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = process.env.WORKER_TOKEN;
const CPUS = Math.max(1, Number(process.env.WORKER_CPUS) || 1);
const IDLE_MS = Math.max(10, Number(process.env.WORKER_IDLE_SECONDS) || 180) * 1000;
const MAX_MS = Math.max(1, Number(process.env.WORKER_MAX_MINUTES) || 120) * 60000;
const POLL_MS = 3000;
const PROGRESS_MS = 3000;

if (!TOKEN) {
  console.error('WORKER_TOKEN is not set. Get one from POST /api/public-workers/join');
  process.exit(2);
}

const started = Date.now();
let lastWork = Date.now();
let stopping = false;
const inflight = new Set();
const log = (...a) => console.log(`[public-worker ${new Date().toISOString()}]`, ...a);

async function call(path, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (r.status === 401 || r.status === 410) return { stop: true, reason: `the app answered ${r.status}` };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

const pool = new EnginePool({ size: CPUS });
await pool.start();
log(`ready: ${pool.status().engine} x${CPUS}, idle limit ${IDLE_MS / 1000} s, lifetime ${MAX_MS / 60000} min`);

async function work(request) {
  inflight.add(request.id);
  let lastProgress = 0;
  try {
    const r = await pool.analyse(request.fen, {
      depth: request.depth,
      multipv: request.multipv,
      onProgress: (snap) => {
        if (Date.now() - lastProgress < PROGRESS_MS || !snap.lines.length) return;
        lastProgress = Date.now();
        call('/api/public-workers/worker/progress', { id: request.id, depth: snap.depth, lines: snap.lines, nodes: snap.nodes }).catch(() => {});
      },
    });
    await call('/api/public-workers/worker/result', { id: request.id, depth: r.depth, lines: r.lines, nodes: r.nodes, engine: r.engine, terminal: r.terminal });
    log(`done #${request.id} depth ${r.depth}`);
  } catch (err) {
    log(`failed #${request.id}: ${err.message}`);
    await call('/api/public-workers/worker/result', { id: request.id, error: String(err.message || err) }).catch(() => {});
  } finally {
    inflight.delete(request.id);
    lastWork = Date.now();
  }
}

async function main() {
  while (!stopping) {
    if (Date.now() - started > MAX_MS) {
      log('lifetime over');
      break;
    }
    if (inflight.size >= CPUS) {
      await sleep(500);
      continue;
    }
    let r;
    try {
      r = await call('/api/public-workers/worker/next', { busy: inflight.size });
    } catch (err) {
      log(`cannot reach the app: ${err.message}`);
      break;
    }
    if (!r || r.stop) {
      log(`stopping: ${r?.reason || 'asked to'}`);
      break;
    }
    if (r.request) {
      lastWork = Date.now();
      work(r.request);
      continue;
    }
    if (inflight.size === 0 && Date.now() - lastWork > IDLE_MS) {
      log('nothing to do, exiting');
      break;
    }
    await sleep(POLL_MS);
  }
  stopping = true;
  const deadline = Date.now() + 15000;
  while (inflight.size && Date.now() < deadline) await sleep(250);
  await pool.stop();
  await call('/api/public-workers/worker/bye', {}).catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => { log('SIGTERM'); stopping = true; });
process.on('SIGINT', () => { stopping = true; });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
