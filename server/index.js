import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { loadOpenings } from './openings.js';
import { Deepener } from './deepener.js';
import { Explorer } from './explorer.js';
import { createAuth, authConfigFromEnv } from './auth.js';
import { PublicWorkerPool } from './public-worker-pool.js';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || join(here, '..', 'data', 'study.sqlite');

const t0 = Date.now();
const book = loadOpenings();
const store = openDb(DB_PATH);
const auth = createAuth({ store, config: authConfigFromEnv(process.env) });
const deepener = new Deepener({ store, book });
deepener.on('result', (r) => {
  if (process.env.LOG_DEEPEN) console.log(`[deepen] ${r.epd} depth ${r.depth} ${r.stored ? 'stored' : 'kept'} (${r.ms} ms)`);
});
deepener.on('error', (err) => console.error('[deepen] error:', err));
deepener.on('idle', () => console.log('[deepen] queue empty, stopped'));

// Explorer jobs see the games their creator can see (shared ones, plus their own).
const explorer = new Explorer({ store, book, scopeFor: (userId) => auth.scopeFor(userId ? store.getUser(userId) : null) });
explorer.on('result', (r) => {
  if (process.env.LOG_EXPLORE) console.log(`[explore] job ${r.jobId}: ${r.name} fit ${r.metrics.fit} eval ${r.metrics.eval} decisions ${r.metrics.decisions}`);
});
explorer.on('error', (err) => console.error('[explore] error:', err));
explorer.on('idle', () => console.log('[explore] queue empty, workers stopped'));

// Public contributor workers: anyone can run a worker and help deepen the book.
const publicWorkers = new PublicWorkerPool({ store, deepener });
publicWorkers.on('result', (r) => { if (process.env.LOG_PUBLIC_WORKERS) console.log(`[public-worker] ${r.worker}: ${r.epd} depth ${r.depth}${r.stored ? ' stored' : ''}`); });
publicWorkers.on('error', (err) => console.error('[public-worker] error:', err));

const app = createApp({ store, book, deepener, explorer, publicWorkers, auth, log: (level, err) => console.error(err) });
const server = createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`Opening study: http://${HOST}:${PORT}  (${book.openings.length} openings, ${book.positions.length} book nodes, loaded in ${Date.now() - t0} ms)`);
  console.log(`Analysis store: ${DB_PATH}`);
  if (auth.mode === 'on') {
    const admins = auth.config.adminEmails.length;
    console.log(`Sign in with Google: on, public origin ${auth.config.baseUrl}, ${admins} admin${admins === 1 ? '' : 's'}${admins ? '' : ' (set ADMIN_EMAILS to run the server engines)'}`);
  } else {
    console.log('Sign in with Google: off (single local user; set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and BASE_URL to publish the site)');
  }
  if (explorer.autoResume || process.env.EXPLORE === '1') {
    explorer.start().then((s) => console.log(`[explore] resumed with ${s.workers} workers, ${s.jobs.filter((j) => j.status !== 'done').length} jobs queued`))
      .catch((err) => console.error('[explore] failed to start:', err));
  }
  if (deepener.autoResume || process.env.DEEPEN === '1') {
    deepener.start().then((s) => console.log(`[deepen] resumed: target depth ${s.targetDepth}, ${s.remaining} positions to go`))
      .catch((err) => console.error('[deepen] failed to start:', err));
  }
});

function shutdown() {
  console.log('shutting down');
  Promise.allSettled([deepener.stop(), explorer.stop(), publicWorkers.shutdown()]).finally(() => {
    server.close();
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
