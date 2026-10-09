// Builds the browser-only version of the app into dist/ for GitHub Pages:
// the front end, the vendored board / engine / chess.js, the opening book as
// JSON and a small index of which ECO code every book position belongs to.
// Without a server the app keeps analysis and the study set in localStorage
// (public/static-api.js). Usage: node scripts/build-pages.js [outDir]

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenings } from '../server/openings.js';
import { nearestName, walk } from '../shared/book.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(ROOT, 'dist'));
const nm = join(ROOT, 'node_modules');
const REPO = 'https://github.com/aryavolkan/chess-opening-study';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// front end and shared modules, flat, so every import can be made relative
cpSync(join(ROOT, 'public'), out, { recursive: true });
cpSync(join(ROOT, 'shared'), join(out, 'shared'), { recursive: true });

// vendored libraries, laid out as the server serves them
const vendor = join(out, 'vendor');
mkdirSync(join(vendor, 'stockfish'), { recursive: true });
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  cpSync(join(nm, 'stockfish', 'bin', f), join(vendor, 'stockfish', f));
}
cpSync(join(nm, '@lichess-org', 'chessground', 'assets'), join(vendor, 'chessground', 'assets'), { recursive: true });
cpSync(join(nm, '@lichess-org', 'chessground', 'dist', 'chessground.min.js'), join(vendor, 'chessground', 'chessground.min.js'));
cpSync(join(nm, 'chess.js', 'dist', 'esm', 'chess.js'), join(vendor, 'chess.js', 'chess.js'));

// opening book + ECO index
const book = loadOpenings();
writeFileSync(join(out, 'openings.json'), JSON.stringify({
  count: book.openings.length,
  openings: book.openings.map((op, i) => ({ id: i, eco: op.eco, name: op.name, pgn: op.pgn, san: op.san })),
}));
const epdEco = {};
walk(book.root, (node) => {
  const named = nearestName(node);
  if (named) epdEco[node.epd] = named.eco;
});
const codes = {};
for (const eco of Object.values(epdEco)) (codes[eco] ||= { positions: 0, openings: 0 }).positions++;
for (const op of book.openings) (codes[op.eco] ||= { positions: 0, openings: 0 }).openings++;
writeFileSync(join(out, 'book-index.json'), JSON.stringify({ codes, epdEco }));

// root-absolute URLs become relative so the site works under /<repo>/
function relativise(text, ext) {
  if (ext === '.js') return text.replace(/(\bfrom\s+['"]|\bimport\(\s*['"]|ENGINE_URL\s*=\s*['"])\//g, '$1./');
  if (ext === '.html') return text.replace(/\b(href|src)="\/(?!\/)/g, '$1="./');
  return text;
}
(function visit(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') visit(p); continue; }
    const ext = extname(p);
    if (['.js', '.html'].includes(ext)) writeFileSync(p, relativise(readFileSync(p, 'utf8'), ext));
  }
})(out);

// mark the page as serverless, hide what needs a server, and say so
const htmlPath = join(out, 'index.html');
let html = readFileSync(htmlPath, 'utf8');
html = html
  .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="static-demo" content="1">')
  .replace('<body>', `<body class="static-demo">
  <div class="demo-banner">Runs entirely in your browser: engine analysis and your study set are saved on this device.
    Importing games, the opening explorer and server-side deepening need the <a href="${REPO}">self-hosted app</a>.</div>`);
writeFileSync(htmlPath, html);
const css = join(out, 'style.css');
writeFileSync(css, readFileSync(css, 'utf8') + `
/* ---- GitHub Pages build ---- */
.demo-banner { background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--text-2); font-size: 12px; padding: 6px 16px; text-align: center; }
body.static-demo .tab[data-tab="games"],
body.static-demo #panel-explorer,
body.static-demo #panel-deepen,
body.static-demo #panel-public-workers,
body.static-demo #deepen-here,
body.static-demo #account { display: none !important; }
`);
console.log(`built ${out}: ${book.openings.length} openings, ${Object.keys(epdEco).length} positions`);
