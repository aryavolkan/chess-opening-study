// Refresh data/openings.tsv from the lichess chess-openings repository (CC0).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const base = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/';
let out = 'eco\tname\tpgn\n';
for (const vol of ['a', 'b', 'c', 'd', 'e']) {
  const res = await fetch(base + vol + '.tsv');
  if (!res.ok) throw new Error(`${vol}.tsv: HTTP ${res.status}`);
  const text = await res.text();
  out += text.split('\n').slice(1).filter(Boolean).join('\n') + '\n';
}
const target = join(here, '..', 'data', 'openings.tsv');
writeFileSync(target, out);
console.log(`wrote ${out.split('\n').length - 2} openings to ${target}`);
