// Import a PGN file (optionally gzipped) into the games database without the
// web server, for example a multi-gigabyte archive on the machine that hosts
// the app. Shares the database with the running server.
// Usage: node scripts/import-pgn.js games.pgn[.gz] [--name "My games"] [--player "me"] [--plies 40]
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../server/db.js';
import { loadOpenings } from '../server/openings.js';
import { Importer, DEFAULT_MAX_PLIES } from '../server/games.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const file = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
if (!file) {
  console.error('usage: node scripts/import-pgn.js games.pgn[.gz] [--name "My games"] [--player "me"] [--plies 40]');
  process.exit(2);
}
const dbPath = process.env.DB_PATH || join(here, '..', 'data', 'study.sqlite');
const book = loadOpenings();
const store = openDb(dbPath);
const importer = new Importer({ store, book });
const t0 = Date.now();
let lastLog = 0;
const record = await importer.importStream(createReadStream(file), {
  name: opt('name', basename(file)),
  player: opt('player', null),
  maxPlies: Number(opt('plies', DEFAULT_MAX_PLIES)),
  onProgress: (p) => {
    if (Date.now() - lastLog < 1000) return;
    lastLog = Date.now();
    const s = (Date.now() - t0) / 1000;
    console.log(`${p.games} games, ${p.duplicates} duplicates, ${(p.bytes / 1e6).toFixed(1)} MB read, ${(p.games / s).toFixed(0)} games/s`);
  },
});
console.log(`import #${record.id} "${record.name}": ${record.games} games, ${record.positions} positions indexed to ply ${record.plies}, `
  + `${record.duplicates} duplicates skipped, ${record.invalid} games with illegal moves, ${(record.ms / 1000).toFixed(1)} s`);
if (record.error) console.error(`stopped early: ${record.error}`);
const top = store.openingsSummary({ by: 'family', limit: 10, player: record.player || undefined });
if (top.groups.length) {
  console.log('most played:');
  for (const g of top.groups) {
    const pct = (n) => `${Math.round((100 * n) / g.games)}%`;
    const line = g.wins !== undefined
      ? `W ${pct(g.wins)} D ${pct(g.draws)} L ${pct(g.losses)}`
      : `1-0 ${pct(g.white)} ½ ${pct(g.draws)} 0-1 ${pct(g.black)}`;
    console.log(`  ${String(g.games).padStart(7)}  ${(g.name || 'not in the book').padEnd(40)} ${line}`);
  }
}
store.close();
