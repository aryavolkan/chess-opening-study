// Download lichess piece sets and board textures into public/themes/ and
// generate the CSS, index and credits that the board theme picker uses.
// The files come from the lila repository and carry their own licences (GPL,
// AGPL, CC BY, CC BY-NC-SA, …), which is why they are fetched rather than
// kept in this MIT repository. Re-running skips files already present.
//
//   node scripts/fetch-themes.js            # fetch everything
//   node scripts/fetch-themes.js --force    # re-download

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'themes');
// Pinned to one lila commit so builds are reproducible and nothing new is
// pulled in unreviewed; bump the hash (and check COPYING.md) to pick up new sets.
const LILA_COMMIT = 'c91f1d09d0f72e913a56cb5d2d8225f6c0f8e0a2';
const RAW = `https://raw.githubusercontent.com/lichess-org/lila/${LILA_COMMIT}/public/`;
const force = process.argv.includes('--force');

// id, display name, author, licence (from lila's COPYING.md), file type when not svg
export const PIECE_SETS = [
  ['cburnett', 'cburnett', 'Colin M.L. Burnett', 'GPLv2+'],
  ['merida', 'Merida', 'Armando Hernandez Marroquin', 'GPLv2+'],
  ['alpha', 'Alpha', 'Eric Bentzen', 'free for personal non-commercial use'],
  ['leipzig', 'Leipzig', 'Armando Hernandez Marroquin', 'freeware'],
  ['companion', 'Companion', 'David L. Brown', 'freeware'],
  ['chess7', 'Chess7', 'Style-7', 'freeware'],
  ['chessnut', 'Chessnut', 'Alexis Luengas', 'Apache 2.0'],
  ['pirouetti', 'Pirouetti', 'pirouetti', 'AGPLv3+'],
  ['letter', 'Letter', 'usolando', 'AGPLv3+'],
  ['pixel', 'Pixel', 'therealqtpi', 'AGPLv3+'],
  ['shapes', 'Shapes', 'flugsio', 'CC BY-SA 4.0'],
  ['rhosgfx', 'RhosGFX', 'RhosGFX', 'CC0 1.0'],
  ['fantasy', 'Fantasy', 'Maurizio Monge', 'MIT'],
  ['spatial', 'Spatial', 'Maurizio Monge', 'MIT'],
  ['celtic', 'Celtic', 'Maurizio Monge', 'MIT'],
  ['kiwen-suwi', 'Kiwen-Suwi', 'neverRare', 'CC BY 4.0'],
  ['firi', 'Firi', 'James Faure', 'CC BY 4.0'],
  ['totoy', 'Totoy', 'Kosal Sen', 'CC BY 4.0'],
  ['papercut', 'Papercut', 'Nikolay Anzarov', 'CC BY 4.0'],
  ['mpchess', 'MPChess', 'Maxime Chupin', 'GPLv3+'],
  ['staunty', 'Staunty', 'sadsnake1', 'CC BY-NC-SA 4.0'],
  ['gioco', 'Gioco', 'sadsnake1', 'CC BY-NC-SA 4.0'],
  ['tatiana', 'Tatiana', 'sadsnake1', 'CC BY-NC-SA 4.0'],
  ['maestro', 'Maestro', 'sadsnake1', 'CC BY-NC-SA 4.0'],
  ['fresca', 'Fresca', 'sadsnake1', 'CC BY-NC-SA 4.0'],
  ['cardinal', 'Cardinal', 'sadsnake1', 'CC BY-NC-SA 4.0'],
  ['icpieces', 'ICPieces', 'sadsnake1', 'CC BY-NC-SA 4.0'],
  ['dubrovny', 'Dubrovny', 'sadsnake1', 'CC BY-NC-SA 4.0'],
  ['california', 'California', 'Jerry S.', 'CC BY-NC-SA 4.0'],
  ['caliente', 'Caliente', 'avi', 'CC BY-NC-SA 4.0'],
  ['anarcandy', 'Anarcandy', 'caderek', 'CC BY-NC-SA 4.0'],
  ['monarchy', 'Monarchy', 'slither77', 'CC BY-NC-SA 4.0', 'webp'],
  ['cooke', 'Cooke', 'fejfar', 'CC BY-NC-SA 4.0'],
  ['minimal-warmth', 'Minimal Warmth', 'blunder_reign', 'CC BY-NC-SA 4.0'],
  ['horsey', 'Horsey', 'cham, michael1241', 'CC BY-NC-SA 4.0'],
];

// id, display name, file (all by the lila authors and pirouetti, AGPLv3+)
export const BOARDS = [
  ['brown', 'Brown', 'brown.png'],
  ['blue', 'Blue', 'blue.png'],
  ['green', 'Green', 'green.png'],
  ['ic', 'IC', 'ic.png'],
  ['purple', 'Purple', 'purple.png'],
  ['purple-diag', 'Purple diagonal', 'purple-diag.png'],
  ['pink-pyramid', 'Pink pyramid', 'pink-pyramid.png'],
  ['green-plastic', 'Green plastic', 'green-plastic.png'],
  ['blue2', 'Blue 2', 'blue2.jpg'],
  ['blue3', 'Blue 3', 'blue3.jpg'],
  ['blue-marble', 'Blue marble', 'blue-marble.jpg'],
  ['canvas2', 'Canvas', 'canvas2.jpg'],
  ['grey', 'Grey', 'grey.jpg'],
  ['leather', 'Leather', 'leather.jpg'],
  ['maple', 'Maple', 'maple.jpg'],
  ['maple2', 'Maple 2', 'maple2.jpg'],
  ['marble', 'Marble', 'marble.jpg'],
  ['metal', 'Metal', 'metal.jpg'],
  ['olive', 'Olive', 'olive.jpg'],
  ['wood', 'Wood', 'wood.jpg'],
  ['wood2', 'Wood 2', 'wood2.jpg'],
  ['wood3', 'Wood 3', 'wood3.jpg'],
  ['wood4', 'Wood 4', 'wood4.jpg'],
  ['horsey', 'Horsey', 'horsey.jpg'],
];

const PIECES = ['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'];
const ROLE = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

const jobs = [];
let skipped = 0;
function want(url, file) {
  if (!force && existsSync(file)) { skipped++; return; }
  jobs.push({ url, file });
}
for (const [id, , , , ext = 'svg'] of PIECE_SETS) {
  for (const p of PIECES) want(`${RAW}piece/${id}/${p}.${ext}`, join(OUT, 'piece', id, `${p}.${ext}`));
}
for (const [, , file] of BOARDS) {
  want(`${RAW}images/board/${file}`, join(OUT, 'board', file));
  const thumb = file.replace(/\.(png|jpg)$/, '.thumbnail.$1');
  want(`${RAW}images/board/${thumb}`, join(OUT, 'board', thumb));
}

let done = 0;
const failed = [];
async function worker() {
  for (;;) {
    const job = jobs.shift();
    if (!job) return;
    try {
      const res = await fetch(job.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mkdirSync(dirname(job.file), { recursive: true });
      writeFileSync(job.file, Buffer.from(await res.arrayBuffer()));
      done++;
    } catch (err) {
      failed.push(`${job.url}: ${err.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

// Generated files. URLs are relative to themes.css so the GitHub Pages build,
// served under /<repo>/, works unchanged.
let css = '/* Generated by scripts/fetch-themes.js; see CREDITS.md for licences. */\n';
for (const [id, , , , ext = 'svg'] of PIECE_SETS) {
  for (const p of PIECES) {
    const color = p[0] === 'w' ? 'white' : 'black';
    css += `.piece-${id} .cg-wrap piece.${ROLE[p[1]]}.${color} { background-image: url('piece/${id}/${p}.${ext}'); }\n`;
  }
}
for (const [id, , file] of BOARDS) css += `.board-${id} cg-board { background-image: url('board/${file}'); }\n`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'themes.css'), css);
writeFileSync(join(OUT, 'index.json'), JSON.stringify({
  pieces: PIECE_SETS.map(([id, name, author, licence, ext = 'svg']) => ({ id, name, author, licence, ext })),
  boards: BOARDS.map(([id, name, file]) => ({ id, name, file, thumb: file.replace(/\.(png|jpg)$/, '.thumbnail.$1') })),
}, null, 1));
writeFileSync(join(OUT, 'CREDITS.md'), `# Board and piece themes

Downloaded by \`scripts/fetch-themes.js\` from the [lila](https://github.com/lichess-org/lila)
repository at commit ${LILA_COMMIT} (\`public/piece\` and \`public/images/board\`). They are not part of this
project's MIT licence; each set keeps its own, as listed in lila's COPYING.md:

| Piece set | Author | Licence |
|---|---|---|
${PIECE_SETS.map(([id, name, author, licence]) => `| ${name} (\`${id}\`) | ${author} | ${licence} |`).join('\n')}

Board images: the lila authors and pirouetti, AGPLv3+.
`);

console.log(`themes: ${done} files downloaded, ${skipped} already present, ${failed.length} failed; wrote ${OUT}/themes.css`);
for (const f of failed) console.error('  ' + f);
if (failed.length) process.exitCode = 1;
