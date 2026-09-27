// Headless deepening: run the engine over the book without the web server.
// Usage: node scripts/deepen.js [--depth 24] [--multipv 3] [--scope "e4 c5"] [--limit N]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../server/db.js';
import { loadOpenings } from '../server/openings.js';
import { Deepener } from '../server/deepener.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const targetDepth = Number(opt('depth', 20));
const multipv = Number(opt('multipv', 3));
const scope = (opt('scope', '') || '').split(/\s+/).filter(Boolean);
const limit = Number(opt('limit', 0));
const dbPath = process.env.DB_PATH || join(here, '..', 'data', 'study.sqlite');

const book = loadOpenings();
const store = openDb(dbPath);
const deepener = new Deepener({ store, book });
let n = 0;
deepener.on('result', (r) => {
  n++;
  const s = deepener.status();
  console.log(`[${s.done}/${s.total}] ${r.epd}  depth ${r.depth}  ${r.stored ? 'stored' : 'kept'}  ${r.ms} ms`);
  if (limit && n >= limit) deepener.stop().then(() => process.exit(0));
});
deepener.on('idle', () => { console.log('done: every position in scope is at target depth'); process.exit(0); });
deepener.on('error', (err) => { console.error(err); process.exit(1); });
process.on('SIGINT', () => deepener.stop().then(() => process.exit(0)));
const status = await deepener.start({ targetDepth, multipv, scope });
console.log(`deepening ${status.remaining} of ${status.total} positions to depth ${targetDepth} with ${status.engine}`);
