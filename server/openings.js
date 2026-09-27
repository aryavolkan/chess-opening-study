// Loads the vendored opening book and computes the position (EPD) reached
// by every node in the trie, so the server can answer "which book positions
// exist" for the deepener and the analysis coverage map.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Chess } from 'chess.js';
import { parseOpeningsTsv, buildBook, walk, pathOf } from '../shared/book.js';
import { epdOf } from '../shared/fen.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TSV = join(here, '..', 'data', 'openings.tsv');

export function loadOpenings(tsvPath = DEFAULT_TSV) {
  const text = readFileSync(tsvPath, 'utf8');
  const openings = parseOpeningsTsv(text);
  const root = buildBook(openings);
  annotatePositions(root);
  const positions = [];
  walk(root, (node) => {
    positions.push({ epd: node.epd, ply: node.ply, san: pathOf(node), name: node.name, eco: node.eco });
  });
  return { openings, root, positions };
}

/** Attach `fen` and `epd` to every node by replaying moves with chess.js. */
export function annotatePositions(root) {
  const chess = new Chess();
  root.fen = chess.fen();
  root.epd = epdOf(root.fen);
  const visit = (node) => {
    for (const [san, child] of node.children) {
      const move = chess.move(san);
      if (!move) {
        throw new Error(`illegal book move ${san} after ${pathOf(node).join(' ')}`);
      }
      child.fen = chess.fen();
      child.epd = epdOf(child.fen);
      child.uci = move.from + move.to + (move.promotion || '');
      visit(child);
      chess.undo();
    }
  };
  visit(root);
}

/** Positions ordered for deepening: shallow plies first, then by book order. */
export function positionsUnderPrefix(root, sanPrefix) {
  let node = root;
  for (const san of sanPrefix) {
    node = node.children.get(san);
    if (!node) return [];
  }
  const out = [];
  walk(node, (n) => out.push({ epd: n.epd, ply: n.ply, san: pathOf(n) }));
  return out;
}
