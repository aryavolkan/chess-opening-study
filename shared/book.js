// The opening book: a trie built from the lichess chess-openings TSV.
// Shared between server (deepener, API) and browser (explorer, tree view).
// Pure data structure work only; FEN calculation is done by the caller
// with chess.js where it is needed.

/** Parse the TSV text (`eco\tname\tpgn` rows) into opening records. */
export function parseOpeningsTsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith('eco\t'))) continue;
    const [eco, name, pgn] = line.split('\t');
    if (!eco || !name || !pgn) continue;
    rows.push({ eco, name, pgn, san: pgnToSan(pgn) });
  }
  return rows;
}

/** "1. e4 c5 2. Nf3" -> ["e4", "c5", "Nf3"] */
export function pgnToSan(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .filter((tok) => tok && !/^\d+\.(\.\.)?$/.test(tok) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok))
    .map((tok) => tok.replace(/^\d+\.+/, ''));
}

/** ["e4", "c5", "Nf3"] -> "1. e4 c5 2. Nf3" */
export function sanToPgn(sans) {
  return sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
}

/** Build the trie. Nodes are keyed by SAN move from their parent. */
export function buildBook(openings) {
  const root = makeNode(null, null, 0);
  openings.forEach((op, index) => {
    let node = root;
    for (const san of op.san) {
      let child = node.children.get(san);
      if (!child) {
        child = makeNode(san, node, node.ply + 1);
        node.children.set(san, child);
      }
      node = child;
    }
    node.openings.push(index);
    if (!node.name || op.name.length < node.name.length) {
      node.name = op.name;
      node.eco = op.eco;
    }
  });
  return root;
}

function makeNode(san, parent, ply) {
  return { san, parent, ply, children: new Map(), openings: [], name: null, eco: null };
}

/** Follow a SAN move list from the root; returns the node or null. */
export function findNode(root, sans) {
  let node = root;
  for (const san of sans) {
    node = node.children.get(san);
    if (!node) return null;
  }
  return node;
}

/** SAN moves from the root to this node. */
export function pathOf(node) {
  const path = [];
  for (let n = node; n && n.san; n = n.parent) path.push(n.san);
  return path.reverse();
}

/** Walk the subtree depth first, calling fn(node). */
export function walk(node, fn) {
  fn(node);
  for (const child of node.children.values()) walk(child, fn);
}

/** Count nodes in the subtree, including the node itself. */
export function subtreeSize(node) {
  let n = 0;
  walk(node, () => n++);
  return n;
}

/** Number of leaves under the node (a node with no children counts as 1). */
export function leafCount(node) {
  if (node.children.size === 0) return 1;
  let n = 0;
  for (const child of node.children.values()) n += leafCount(child);
  return n;
}

/**
 * The closest named ancestor (or the node itself), used to label a position
 * that is deeper than any named opening.
 */
export function nearestName(node) {
  for (let n = node; n; n = n.parent) {
    if (n.name) return { name: n.name, eco: n.eco };
  }
  return null;
}

/** Plain-object copy of a subtree, safe to JSON.stringify. */
export function serialize(node, depthLimit = Infinity) {
  const out = { san: node.san, ply: node.ply, name: node.name, eco: node.eco, openings: node.openings, children: [] };
  if (depthLimit > 0) {
    for (const child of node.children.values()) out.children.push(serialize(child, depthLimit - 1));
  }
  return out;
}

/** Group openings by ECO volume letter (A-E) and code, for the ECO map. */
export function ecoIndex(openings) {
  const byCode = new Map();
  openings.forEach((op, index) => {
    if (!byCode.has(op.eco)) byCode.set(op.eco, []);
    byCode.get(op.eco).push(index);
  });
  return byCode;
}

/** Simple substring search over names and ECO codes. */
export function searchOpenings(openings, query, limit = 50) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const hits = [];
  for (let i = 0; i < openings.length; i++) {
    const op = openings[i];
    const hay = (op.eco + ' ' + op.name + ' ' + op.pgn).toLowerCase();
    if (words.every((w) => hay.includes(w))) {
      hits.push(i);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
