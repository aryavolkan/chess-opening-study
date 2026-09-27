// SVG variation tree. Horizontal tidy layout: one column per ply, rows
// assigned by leaf order. Node fill encodes the stored evaluation (White's
// point of view, diverging blue/grey/red); the ring encodes stored depth.

import { winningChances, formatScore, scoreForWhite } from '/shared/uci.js';
import { sideToMove } from '/shared/fen.js';

const COL_W = 118;
const ROW_H = 34;
const PAD_X = 24;
const PAD_Y = 22;
const R = 6;
const NS = 'http://www.w3.org/2000/svg';

/**
 * @param {SVGElement} svg
 * @param {object} o
 * @param {object} o.root       book node to draw from (must have .epd)
 * @param {object} o.current    node the board is on (or null)
 * @param {number} o.depth      plies shown below the root by default
 * @param {Set<object>} o.expanded  nodes expanded past the default depth
 * @param {Map<string, object>} o.analysis  epd -> stored analysis record
 * @param {(node) => void} o.onSelect
 * @param {(node) => void} o.onToggle
 * @param {(event, node|null) => void} o.onHover
 */
export function renderTree(svg, o) {
  const { root, depth, expanded, analysis } = o;
  const rows = [];
  const visible = new Map(); // node -> { row, col }

  function isOpen(node) {
    if (node.children.size === 0) return false;
    if (node.ply - root.ply < depth) return !expanded.has(node) || true;
    return expanded.has(node);
  }
  function collapsedByUser(node) {
    return node.ply - root.ply < depth && expanded.has(node) && node.children.size > 0;
  }

  function layout(node) {
    const col = node.ply - root.ply;
    const open = isOpen(node) && !collapsedByUser(node);
    if (!open) {
      const row = rows.length;
      rows.push(node);
      visible.set(node, { row, col, open: false });
      return row;
    }
    let first = null;
    let last = null;
    for (const child of node.children.values()) {
      const r = layout(child);
      if (first === null) first = r;
      last = r;
    }
    const row = (first + last) / 2;
    visible.set(node, { row, col, open: true });
    return row;
  }
  layout(root);

  const maxCol = Math.max(...[...visible.values()].map((v) => v.col));
  const width = PAD_X * 2 + (maxCol + 1) * COL_W + 60;
  const height = PAD_Y * 2 + Math.max(1, rows.length) * ROW_H;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = '';

  const onPath = new Set();
  for (let n = o.current; n; n = n.parent) onPath.add(n);

  const x = (col) => PAD_X + col * COL_W + 20;
  const y = (row) => PAD_Y + row * ROW_H + ROW_H / 2;

  // edges first so nodes draw on top
  for (const [node, pos] of visible) {
    if (node === root || !node.parent) continue;
    const p = visible.get(node.parent);
    if (!p) continue;
    const x1 = x(p.col) + R;
    const y1 = y(p.row);
    const x2 = x(pos.col) - R;
    const y2 = y(pos.row);
    const mx = (x1 + x2) / 2;
    const path = el('path', {
      class: 'edge' + (onPath.has(node) && onPath.has(node.parent) ? ' onpath' : ''),
      d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
    });
    svg.appendChild(path);
  }

  for (const [node, pos] of visible) {
    const a = node.epd ? analysis.get(node.epd) : null;
    const cls = ['node', depthClass(a?.depth)];
    if (node.name) cls.push('named');
    if (node === o.current) cls.push('current');
    const g = el('g', { class: cls.join(' '), transform: `translate(${x(pos.col)},${y(pos.row)})` });
    const circle = el('circle', { r: R, fill: a ? evalColor(a, node.epd) : 'var(--surface)' });
    g.appendChild(circle);
    const san = el('text', { class: 'san', x: R + 5, y: 4 });
    san.textContent = node.san ? moveLabel(node) : 'start';
    g.appendChild(san);
    const hidden = !pos.open && node.children.size > 0;
    if (hidden) {
      const more = el('text', { class: 'more', x: R + 5 + textWidth(san.textContent) + 6, y: 4 });
      more.textContent = `⊕${countHidden(node)}`;
      more.addEventListener('click', (e) => { e.stopPropagation(); o.onToggle(node); });
      g.appendChild(more);
    } else if (pos.open && node !== root && expanded.has(node)) {
      const less = el('text', { class: 'more', x: R + 5 + textWidth(san.textContent) + 6, y: 4 });
      less.textContent = '⊖';
      less.addEventListener('click', (e) => { e.stopPropagation(); o.onToggle(node); });
      g.appendChild(less);
    }
    if (node.name && node !== root) {
      const name = el('text', { class: 'name', x: R + 5, y: 15 });
      name.textContent = shortName(node.name, node.parent);
      g.appendChild(name);
    }
    g.addEventListener('click', () => o.onSelect(node));
    g.addEventListener('mouseenter', (e) => o.onHover(e, node, a));
    g.addEventListener('mousemove', (e) => o.onHover(e, node, a));
    g.addEventListener('mouseleave', (e) => o.onHover(e, null));
    svg.appendChild(g);
  }
  return { nodes: visible.size };
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
  return s.length > 22 ? s.slice(0, 21) + '…' : s;
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

function textWidth(s) {
  return s.length * 7.2;
}

export function depthClass(depth) {
  if (!depth) return 'none';
  return depth < 15 ? 'shallow' : 'deep';
}

/** Diverging fill: red (Black better) - grey - blue (White better). */
export function evalColor(a, epd) {
  const white = scoreForWhite(a.score, sideToMove(epd));
  const t = winningChances(white); // -1..1
  return mixEval(t);
}

function mixEval(t) {
  const mid = cssVar('--eval-mid', '#cfcdc6');
  const pole = t >= 0 ? cssVar('--eval-white', '#2a78d6') : cssVar('--eval-black', '#e34948');
  const k = Math.min(1, Math.abs(t) * 1.6);
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
