// SVG variation tree. Horizontal tidy layout: one column per ply (as wide as
// its labels need), rows assigned by leaf order. Node fill encodes the stored
// evaluation (White's point of view, diverging blue/grey/red); the ring
// encodes stored depth. Replies are ordered and capped by tree-model.js, and
// edges run along a shared trunk per parent so wide fans stay readable.

import { formatScore, scoreForWhite } from '/shared/uci.js';
import { sideToMove } from '/shared/fen.js';
import { orderChildren, capChildren, moveQuality, chancesForWhite } from '/tree-model.js';

const ROW_H = 34;
const PAD_X = 24;
const PAD_Y = 22;
const R = 6;
const STUB = 16;        // horizontal run from a node to its trunk
const MIN_COL = 120;
const MAX_COL = 320;
const NS = 'http://www.w3.org/2000/svg';
const FONT_SAN = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_EV = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_NAME = '10px system-ui, -apple-system, sans-serif';
const NAME_MAX = 34;

/**
 * @param {SVGElement} svg
 * @param {object} o
 * @param {object} o.root       book node to draw from (must have .epd)
 * @param {object} o.current    node the board is on (or null)
 * @param {number} o.depth      plies shown below the root by default
 * @param {Set<object>} o.expanded  nodes toggled away from their default open/closed state
 * @param {Map<string, object>} o.analysis  epd -> stored analysis record
 * @param {Map<string, object>} [o.games]  epd -> imported-game counts; edges are
 *   drawn thicker the more games went through them (relative to the root)
 * @param {'eval'|'games'|'book'} [o.order]  reply order (default eval)
 * @param {number} [o.branches]  replies shown per node before a "more" row (0 = all)
 * @param {Set<object>} [o.showAll]  nodes whose reply cap has been lifted
 * @param {(node) => void} o.onSelect
 * @param {(node) => void} o.onToggle
 * @param {(node) => void} [o.onShowAll]
 * @param {(event, node|null) => void} o.onHover
 */
export function renderTree(svg, o) {
  const { root, depth, expanded, analysis } = o;
  const workers = o.workers || [];
  const games = o.games || null;
  const order = o.order || 'eval';
  const branches = o.branches ?? 6;
  const showAll = o.showAll || new Set();
  const rows = [];
  const visible = new Map(); // node -> { row, col, open }
  const moreRows = [];       // { parent, hidden, row, col }

  const onPath = new Set();
  for (let n = o.current; n; n = n.parent) onPath.add(n);

  function defaultOpen(node) {
    if (node.children.size === 0) return false;
    return node.ply - root.ply < depth || onPath.has(node);
  }
  function isOpen(node) {
    return defaultOpen(node) !== expanded.has(node) && node.children.size > 0;
  }

  function layout(node) {
    const col = node.ply - root.ply;
    if (!isOpen(node)) {
      const row = rows.length;
      rows.push(node);
      visible.set(node, { row, col, open: false });
      return row;
    }
    const ordered = orderChildren(node, { analysis, games, order });
    const { shown, hidden } = capChildren(ordered, showAll.has(node) ? 0 : branches, onPath);
    let first = null;
    let last = null;
    for (const child of shown) {
      const r = layout(child);
      if (first === null) first = r;
      last = r;
    }
    if (hidden) {
      last = rows.length;
      rows.push(null);
      moreRows.push({ parent: node, hidden, row: last, col: col + 1 });
    }
    const row = (first + last) / 2;
    visible.set(node, { row, col, open: true });
    return row;
  }
  layout(root);

  const gamesOf = (node) => (games && node.epd ? games.get(node.epd)?.games || 0 : 0);
  const rootGames = games ? gamesOf(root) : 0;

  // Labels are measured first so every column is exactly as wide as it needs.
  const labels = new Map(); // node -> { san, quality, ev, games, more, name }
  for (const [node, pos] of visible) {
    const a = node.epd ? analysis.get(node.epd) : null;
    const l = { san: node.san ? moveLabel(node) : 'start', quality: null, ev: null, games: null, more: null, fewer: null, name: null };
    if (node !== root) l.quality = moveQuality(node, analysis);
    if (a) l.ev = formatScore(scoreForWhite(a.score, sideToMove(node.epd)));
    if (games && gamesOf(node)) l.games = String(gamesOf(node));
    if (!pos.open && node.children.size > 0) l.more = `⊕${countHidden(node)}`;
    else if (pos.open && node !== root && !(node.ply - root.ply < depth && !expanded.has(node))) l.more = '⊖';
    if (pos.open && showAll.has(node)) l.fewer = 'fewer';
    if (node.name && node !== root) l.name = shortName(node.name, node.parent);
    l.width = R + 5 + measure(l.san + (l.quality || ''), FONT_SAN)
      + (l.ev ? 6 + measure(l.ev, FONT_EV) : 0)
      + (l.games ? 6 + measure(l.games, FONT_EV) : 0)
      + (l.more ? 6 + measure(l.more, FONT_SAN) : 0)
      + (l.fewer ? 6 + measure(l.fewer, FONT_EV) : 0);
    l.nameWidth = l.name ? R + 5 + measure(l.name, FONT_NAME) : 0;
    labels.set(node, l);
  }
  const maxCol = Math.max(0, ...[...visible.values()].map((v) => v.col), ...moreRows.map((m) => m.col));
  const colW = new Array(maxCol + 1).fill(MIN_COL);
  for (const [node, pos] of visible) {
    const l = labels.get(node);
    colW[pos.col] = Math.max(colW[pos.col], Math.min(MAX_COL, Math.max(l.width, l.nameWidth) + STUB + 20));
  }
  const colX = [PAD_X + 20];
  for (let c = 1; c <= maxCol; c++) colX[c] = colX[c - 1] + colW[c - 1];
  const x = (col) => colX[col];
  const y = (row) => PAD_Y + row * ROW_H + ROW_H / 2;

  const width = colX[maxCol] + colW[maxCol] + PAD_X;
  const height = PAD_Y * 2 + Math.max(1, rows.length) * ROW_H;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = '';

  const edgeLayer = el('g', { class: 'edges' });
  const nodeLayer = el('g', { class: 'nodes' });
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  const edgeEls = new Map(); // node -> its incoming edge
  const nodeEls = new Map(); // node -> its <g>
  const edgeOrder = [];      // stable z-order: plain, then best, then on-path

  /** Orthogonal edge: stub out of the parent, a shared vertical trunk, and a run into the child. */
  function edgePath(x1, y1, x2, y2) {
    if (Math.abs(y2 - y1) < 0.5) return `M${x1},${y1} H${x2}`;
    const tx = x1 + STUB;
    const dir = y2 > y1 ? 1 : -1;
    const r = Math.min(7, Math.abs(y2 - y1) / 2, (x2 - tx) / 2);
    return `M${x1},${y1} H${tx - r} Q${tx},${y1} ${tx},${y1 + dir * r}`
      + ` V${y2 - dir * r} Q${tx},${y2} ${tx + r},${y2} H${x2}`;
  }

  for (const [node, pos] of visible) {
    if (node === root || !node.parent) continue;
    const p = visible.get(node.parent);
    if (!p) continue;
    const cls = ['edge'];
    const onpath = onPath.has(node) && onPath.has(node.parent);
    if (onpath) cls.push('onpath');
    const parentBest = node.parent.epd ? analysis.get(node.parent.epd)?.bestMove : null;
    const best = parentBest && node.uci === parentBest;
    if (best) cls.push('best');
    const attrs = { d: edgePath(x(p.col) + R, y(p.row), x(pos.col) - R, y(pos.row)) };
    if (rootGames) {
      const n = gamesOf(node);
      cls.push(n ? 'flow' : 'noflow');
      if (n) attrs['stroke-width'] = (1.5 + 8 * Math.sqrt(n / rootGames)).toFixed(1);
    }
    attrs.class = cls.join(' ');
    const path = el('path', attrs);
    edgeEls.set(node, path);
    edgeOrder.push({ path, rank: onpath ? 2 : best ? 1 : 0 });
  }
  for (const m of moreRows) {
    const p = visible.get(m.parent);
    edgeOrder.push({ path: el('path', { class: 'edge more', d: edgePath(x(p.col) + R, y(p.row), x(m.col) - R, y(m.row)) }), rank: 0 });
  }
  edgeOrder.sort((a, b) => a.rank - b.rank);
  const restack = () => { for (const e of edgeOrder) edgeLayer.appendChild(e.path); };
  restack();

  for (const [node, pos] of visible) {
    const a = node.epd ? analysis.get(node.epd) : null;
    const l = labels.get(node);
    const cls = ['node', depthClass(a?.depth)];
    if (node.name) cls.push('named');
    if (node === o.current) cls.push('current');
    else if (onPath.has(node)) cls.push('onpath');
    if (l.quality) cls.push('q' + l.quality.length + (l.quality === '?!' ? 'i' : ''));
    const g = el('g', { class: cls.join(' '), transform: `translate(${x(pos.col)},${y(pos.row)})` });
    g.appendChild(el('circle', { r: R, fill: a ? evalColor(a, node.epd) : 'var(--surface)' }));
    let cx = R + 5;
    const san = el('text', { class: 'san', x: cx, y: -3 });
    san.textContent = l.san;
    if (l.quality) {
      const q = el('tspan', { class: 'quality' });
      q.textContent = l.quality;
      san.appendChild(q);
    }
    g.appendChild(san);
    cx += measure(l.san + (l.quality || ''), FONT_SAN) + 6;
    if (l.ev) {
      const ev = el('text', { class: 'ev', x: cx, y: -3 });
      ev.textContent = l.ev;
      g.appendChild(ev);
      cx += measure(l.ev, FONT_EV) + 6;
    }
    if (l.games) {
      const count = el('text', { class: 'games', x: cx, y: -3 });
      count.textContent = l.games;
      g.appendChild(count);
      cx += measure(l.games, FONT_EV) + 6;
    }
    if (l.more) {
      const more = el('text', { class: 'more', x: cx, y: -3 });
      more.textContent = l.more;
      more.appendChild(el('title', {})).textContent = l.more === '⊖' ? 'collapse' : 'expand';
      more.addEventListener('click', (e) => { e.stopPropagation(); o.onToggle(node); });
      g.appendChild(more);
      cx += measure(l.more, FONT_SAN) + 6;
    }
    if (l.fewer) {
      const fewer = el('text', { class: 'fewer', x: cx, y: -3 });
      fewer.textContent = l.fewer;
      fewer.appendChild(el('title', {})).textContent = 'back to the top replies only';
      fewer.addEventListener('click', (e) => { e.stopPropagation(); o.onShowAll?.(node); });
      g.appendChild(fewer);
    }
    if (l.name) {
      const name = el('text', { class: 'name', x: R + 5, y: 13 });
      name.textContent = l.name;
      g.appendChild(name);
    }
    g.addEventListener('click', () => o.onSelect(node));
    nodeEls.set(node, g);
    g.addEventListener('mouseenter', (e) => { lineage(node, true); o.onHover(e, node, a); });
    g.addEventListener('mousemove', (e) => o.onHover(e, node, a));
    g.addEventListener('mouseleave', (e) => { lineage(node, false); o.onHover(e, null); });
    nodeLayer.appendChild(g);
  }

  for (const m of moreRows) {
    const g = el('g', { class: 'node more-row', transform: `translate(${x(m.col)},${y(m.row)})` });
    g.appendChild(el('circle', { r: R - 2, class: 'more-dot' }));
    const t = el('text', { class: 'more', x: R + 5, y: 4 });
    t.textContent = `+${m.hidden} more ${m.hidden === 1 ? 'reply' : 'replies'}`;
    g.appendChild(t);
    g.appendChild(el('title', {})).textContent = 'show every book reply here';
    g.addEventListener('click', (e) => { e.stopPropagation(); o.onShowAll?.(m.parent); });
    nodeLayer.appendChild(g);
  }

  /** Light up the line from the root to a hovered node and dim the rest. */
  function lineage(node, on) {
    svg.classList.toggle('hovering', on);
    for (let n = node; n; n = n.parent) {
      const e = edgeEls.get(n);
      e?.classList.toggle('hl', on);
      if (e && on) edgeLayer.appendChild(e);
      nodeEls.get(n)?.classList.toggle('hl', on);
    }
    if (!on) restack();
  }

  // Worker dots: shared CPUs currently analysing positions in the visible tree.
  const byEpd = new Map();
  for (const w of workers) {
    if (!w.epd) continue;
    const list = byEpd.get(w.epd) || (byEpd.set(w.epd, []), byEpd.get(w.epd));
    list.push(w);
  }
  for (const [node, pos] of visible) {
    const list = byEpd.get(node.epd);
    if (!list || !list.length) continue;
    const cx = x(pos.col);
    const cy = y(pos.row);
    const spacing = 8;
    const totalW = (list.length - 1) * spacing;
    let wx = cx - totalW / 2;
    const wy = cy - R - 7;
    for (const w of list) {
      const color = workerColor(w.source);
      svg.appendChild(el('circle', {
        class: 'worker-glow', cx: wx.toFixed(1), cy: wy.toFixed(1), r: 5, fill: color, opacity: 0.25,
      }));
      const dot = el('circle', {
        class: `worker source-${w.source}`, cx: wx.toFixed(1), cy: wy.toFixed(1), r: 3,
        fill: color, stroke: 'var(--surface)', 'stroke-width': 0.8, 'data-source': w.source,
      });
      dot.appendChild(el('title', {})).textContent = workerLabel(w);
      svg.appendChild(dot);
      wx += spacing;
    }
    if (list.length > 1) {
      const badge = el('text', { class: 'worker-count', x: (cx + totalW / 2 + 5).toFixed(1), y: (wy + 1).toFixed(1) });
      badge.textContent = list.length;
      svg.appendChild(badge);
    }
  }

  keepCurrentInView(svg, visible.get(o.current), o.current, x, y, colW);
  return { nodes: visible.size };
}

/** Scroll the tree's container so the node the board is on stays visible; only when it changes. */
function keepCurrentInView(svg, pos, current, x, y, colW) {
  if (!pos || svg._followed === current) return;
  svg._followed = current;
  const box = svg.parentElement;
  if (!box || box.clientWidth === 0) return;
  const cx = x(pos.col);
  const cy = y(pos.row);
  const margin = 80;
  if (cx < box.scrollLeft + margin || cx > box.scrollLeft + box.clientWidth - colW[pos.col]) {
    box.scrollLeft = Math.max(0, cx - box.clientWidth / 3);
  }
  if (cy < box.scrollTop + margin || cy > box.scrollTop + box.clientHeight - margin) {
    box.scrollTop = Math.max(0, cy - box.clientHeight / 2);
  }
}

function workerColor(source) {
  const map = {
    deepener: cssVar('--accent', '#2a78d6'),
    explorer: cssVar('--good', '#0ca30c'),
    browser: cssVar('--warn', '#fab219'),
  };
  return map[source] || cssVar('--text-3', '#8a8983');
}

function workerLabel(w) {
  const src = { deepener: 'server deepener', explorer: 'opening explorer', browser: 'browser engine' }[w.source] || w.source;
  const prog = w.progress ? ` · depth ${w.progress}` : '';
  return `${src} analysing to depth ${w.depth}${prog}`;
}

function moveLabel(node) {
  const n = Math.ceil(node.ply / 2);
  return node.ply % 2 === 1 ? `${n}.${node.san}` : `${n}…${node.san}`;
}

/** Drop the part of the name shared with the parent's nearest name. */
function shortName(name, parent) {
  let base = null;
  for (let p = parent; p; p = p.parent) if (p.name) { base = p.name; break; }
  const s = stripFamily(name, base);
  return s.length > NAME_MAX ? s.slice(0, NAME_MAX - 1) + '…' : s;
}

/**
 * "Sicilian Defense: Najdorf Variation, English Attack" under a parent named
 * "Sicilian Defense: Najdorf Variation" becomes "English Attack"; under a
 * parent named "Sicilian Defense: Open" it becomes "Najdorf Variation, …".
 */
export function stripFamily(name, base) {
  if (!base) return name;
  if (name.startsWith(base)) {
    const rest = name.slice(base.length).replace(/^[:,\s]+/, '');
    if (rest) return rest;
    return name;
  }
  const family = base.split(':')[0];
  if (name.startsWith(family + ':')) {
    const rest = name.slice(family.length + 1).replace(/^[:,\s]+/, '');
    if (rest) return rest;
  }
  return name;
}

function countHidden(node) {
  let n = 0;
  (function walk(x) { for (const c of x.children.values()) { n++; walk(c); } })(node);
  return n;
}

// Text is measured on a canvas so column widths match what is drawn.
let ctx = null;
const widthCache = new Map();
function measure(s, font) {
  const key = font + '|' + s;
  let w = widthCache.get(key);
  if (w !== undefined) return w;
  if (!ctx) ctx = document.createElement('canvas').getContext('2d');
  if (ctx) {
    ctx.font = font;
    w = ctx.measureText(s).width;
  } else {
    w = s.length * (parseInt(font, 10) || 12) * 0.6;
  }
  widthCache.set(key, w);
  return w;
}

export function depthClass(depth) {
  if (!depth) return 'none';
  return depth < 15 ? 'shallow' : 'deep';
}

/** Diverging fill: red (Black better) - grey - blue (White better). */
export function evalColor(a, epd) {
  return mixEval(chancesForWhite(a, epd) || 0);
}

function mixEval(t) {
  const mid = cssVar('--eval-mid', '#cfcdc6');
  const pole = t >= 0 ? cssVar('--eval-white', '#2a78d6') : cssVar('--eval-black', '#e34948');
  const k = Math.min(1, Math.sqrt(Math.abs(t)) * 1.5); // opening evals are small; keep them visible
  return mixHex(mid, pole, k);
}

const varCache = new Map();
function cssVar(name, fallback) {
  if (!varCache.has(name)) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    varCache.set(name, v || fallback);
  }
  return varCache.get(name);
}
export function resetColorCache() { varCache.clear(); }

function mixHex(a, b, k) {
  const pa = hex(a);
  const pb = hex(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
function hex(h) {
  const s = h.replace('#', '');
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}

export function describeEval(a, epd) {
  if (!a) return 'not analysed';
  const white = scoreForWhite(a.score, sideToMove(epd));
  return `${formatScore(white)} at depth ${a.depth}`;
}

function el(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
