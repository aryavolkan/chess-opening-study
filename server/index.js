import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { loadOpenings } from './openings.js';
import { Deepener } from './deepener.js';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || join(here, '..', 'data', 'study.sqlite');

const t0 = Date.now();
const book = loadOpenings();
const store = openDb(DB_PATH);
const deepener = new Deepener({ store, book });
deepener.on('result', (r) => {
  if (process.env.LOG_DEEPEN) console.log(`[deepen] ${r.epd} depth ${r.depth} ${r.stored ? 'stored' : 'kept'} (${r.ms} ms)`);
});
deepener.on('error', (err) => console.error('[deepen] error:', err));
deepener.on('idle', () => console.log('[deepen] queue empty, stopped'));

const app = createApp({ store, book, deepener, log: (level, err) => console.error(err) });
const server = createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`Opening study: http://${HOST}:${PORT}  (${book.openings.length} openings, ${book.positions.length} book nodes, loaded in ${Date.now() - t0} ms)`);
  console.log(`Analysis store: ${DB_PATH}`);
  if (deepener.autoResume || process.env.DEEPEN === '1') {
    deepener.start().then((s) => console.log(`[deepen] resumed: target depth ${s.targetDepth}, ${s.remaining} positions to go`))
      .catch((err) => console.error('[deepen] failed to start:', err));
  }
});

function shutdown() {
  console.log('shutting down');
  deepener.stop().finally(() => {
    server.close();
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
