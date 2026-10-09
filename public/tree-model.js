// Pure helpers behind the variation tree: which children to show, in what
// order, and how to grade a move against its parent's evaluation. Kept free
// of DOM work so the rules can be tested in Node (see test/tree-model.test.js).

import { winningChances, scoreForWhite } from '../shared/uci.js';
import { sideToMove } from '../shared/fen.js';

export const ORDERS = ['eval', 'games', 'book'];
export const BRANCH_CAPS = [6, 10, 0]; // 0 = show every reply

/** Winning chances in [-1, 1] for White, from a stored record at the position `epd`. */
export function chancesForWhite(a, epd) {
  if (!a || !a.score) return null;
  return winningChances(scoreForWhite(a.score, sideToMove(epd)));
}

/**
 * The children of `node` in display order.
 *   eval:  best reply for the side to move first, unanalysed replies last
 *   games: most played in the imported games first
 *   book:  as listed in the opening book
 * Ties keep the book order, so the order is stable.
 */
export function orderChildren(node, { analysis, games, order }) {
  const kids = [...node.children.values()];
  if (order === 'book') return kids;
  const sign = node.epd && sideToMove(node.epd) === 'b' ? -1 : 1;
  const key = new Map();
  for (const c of kids) {
    const g = games && c.epd ? games.get(c.epd)?.games || 0 : 0;
    const t = c.epd ? chancesForWhite(analysis.get(c.epd), c.epd) : null;
    key.set(c, { games: g, eval: t === null ? -Infinity : t * sign });
  }
  const idx = new Map(kids.map((c, i) => [c, i]));
  return kids.sort((a, b) => {
    const ka = key.get(a);
    const kb = key.get(b);
    if (order === 'games' && kb.games !== ka.games) return kb.games - ka.games;
    if (kb.eval !== ka.eval) return kb.eval - ka.eval;
    if (order === 'eval' && kb.games !== ka.games) return kb.games - ka.games;
    return idx.get(a) - idx.get(b);
  });
}

/**
 * Keep the first `cap` of an ordered child list (0 = all), plus any child in
 * `keep` (the line on the board must never disappear behind a "more" row).
 * @returns {{ shown: object[], hidden: number }}
 */
export function capChildren(ordered, cap, keep) {
  if (!cap || ordered.length <= cap) return { shown: ordered, hidden: 0 };
  const shown = ordered.filter((c, i) => i < cap || keep.has(c));
  return { shown, hidden: ordered.length - shown.length };
}

const QUALITY_DEPTH = 8;

/**
 * Grade a book move by how many winning chances it gives away compared with
 * the parent position's evaluation, using lichess's thresholds on the
 * [-1, 1] scale. Returns '?!', '?', '??' or null (fine, or not enough data).
 */
export function moveQuality(node, analysis) {
  const parent = node.parent;
  if (!parent || !parent.epd || !node.epd) return null;
  const before = analysis.get(parent.epd);
  const after = analysis.get(node.epd);
  if (!before || !after || before.depth < QUALITY_DEPTH || after.depth < QUALITY_DEPTH) return null;
  const sign = sideToMove(parent.epd) === 'w' ? 1 : -1;
  const drop = (chancesForWhite(before, parent.epd) - chancesForWhite(after, node.epd)) * sign;
  if (drop >= 0.3) return '??';
  if (drop >= 0.2) return '?';
  if (drop >= 0.1) return '?!';
  return null;
}
