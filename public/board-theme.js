// Board size and themes. The board gets an explicit pixel size: what fits the
// window (the width left beside the side columns, or the height budget,
// whichever is smaller) times a user scale set by dragging the board's corner
// handle. Piece sets and board textures come from public/themes/ (see
// scripts/fetch-themes.js); without them only the built-in cburnett/brown
// pair is offered. The pure helpers at the top are unit tested in Node, so
// nothing here touches the DOM at import time.

export const SIZE_MIN = 240;
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
export const BUILTIN_PIECES = 'cburnett';
export const BUILTIN_BOARD = 'brown';

// Mirrors style.css: layout max-width and padding, side column minimums,
// grid gaps, the eval bar beside the board, and the header + controls above
// and below it.
const LAYOUT_MAX = 1600;
const LAYOUT_PAD = 32;
const SIDE_MIN = 260 + 280;
const GAPS = 24;
const EVAL_BAR = 32;
const VERTICAL = 230;

export function clampScale(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

/**
 * @returns {{ fit: number, size: number }} the size that fits at scale 1, and
 *   the size to use: fit × scale, never under SIZE_MIN or over the width budget.
 */
export function fitBoardSize({ innerWidth, innerHeight, single, scale }) {
  const layoutW = Math.min(innerWidth, LAYOUT_MAX) - LAYOUT_PAD;
  const fitW = Math.max(SIZE_MIN, single ? layoutW - EVAL_BAR : layoutW - SIDE_MIN - GAPS - EVAL_BAR);
  const fitH = Math.max(SIZE_MIN, innerHeight - VERTICAL);
  const fit = Math.min(fitW, fitH);
  const size = Math.round(Math.min(fitW, Math.max(SIZE_MIN, fit * clampScale(scale))));
  return { fit, size };
}

/** Body classes that select a theme; the built-ins need none. */
export function themeClasses(pieces, board) {
  const out = [];
  if (pieces && pieces !== BUILTIN_PIECES) out.push(`piece-${pieces}`);
  if (board && board !== BUILTIN_BOARD) out.push(`board-${board}`);
  return out;
}

// ---------------------------------------------------------------------------
// DOM

const $ = (id) => document.getElementById(id);

/**
 * Wire the size handle, the ⚙ panel and the theme classes. Reads and writes
 * prefs boardScale, pieceSet and boardTheme.
 */
export function initBoardSettings({ prefs }) {
  let scale = clampScale(prefs.get('boardScale', 1));
  let pieces = String(prefs.get('pieceSet', BUILTIN_PIECES));
  let board = String(prefs.get('boardTheme', BUILTIN_BOARD));
  let index = null; // { pieces: [...], boards: [...] } from themes/index.json, or null when not installed

  function metrics() {
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      single: window.matchMedia('(max-width: 1000px)').matches,
      scale,
    };
  }

  function applySize() {
    const { size } = fitBoardSize(metrics());
    document.documentElement.style.setProperty('--board-size', `${size}px`);
    $('board-scale').value = Math.round(scale * 100);
    $('board-scale-value').textContent = `${Math.round(scale * 100)}%`;
  }

  function applyTheme() {
    const cls = document.body.classList;
    for (const c of [...cls]) if (c.startsWith('piece-') || c.startsWith('board-')) cls.remove(c);
    cls.add(...themeClasses(pieces, board));
    for (const b of $('board-themes').querySelectorAll('button')) b.classList.toggle('selected', b.dataset.id === board);
    for (const b of $('piece-sets').querySelectorAll('button')) b.classList.toggle('selected', b.dataset.id === pieces);
  }

  function setScale(s, persist) {
    scale = clampScale(s);
    if (persist) prefs.set('boardScale', scale);
    applySize();
  }

  // Window: refit on resize (the scale stays, the fit changes).
  let raf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(applySize);
  });

  // Corner handle: drag to resize, double-click to go back to the fitted size.
  const handle = $('board-resize');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, size: fitBoardSize(metrics()).size, fit: fitBoardSize(metrics()).fit };
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-board');
    const move = (ev) => setScale((start.size + Math.max(ev.clientX - start.x, ev.clientY - start.y)) / start.fit, false);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-board');
      prefs.set('boardScale', scale);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => setScale(1, true));

  // Settings panel
  $('board-settings-btn').onclick = () => {
    const panel = $('board-settings');
    panel.hidden = !panel.hidden;
    $('board-settings-btn').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden && !index) loadIndex();
  };
  $('board-settings-close').onclick = () => $('board-settings-btn').click();
  $('board-scale').oninput = (e) => setScale(Number(e.target.value) / 100, false);
  $('board-scale').onchange = (e) => setScale(Number(e.target.value) / 100, true);
  $('board-scale-reset').onclick = () => setScale(1, true);

  async function loadIndex() {
    try {
      const res = await fetch('themes/index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      index = await res.json();
    } catch {
      index = { pieces: [{ id: BUILTIN_PIECES, name: 'cburnett' }], boards: [{ id: BUILTIN_BOARD, name: 'Brown' }], missing: true };
    }
    $('themes-missing').hidden = !index.missing;
    renderGrid($('board-themes'), index.boards, (t) => (t.thumb ? `themes/board/${t.thumb}` : null), (id) => { board = id; prefs.set('boardTheme', id); applyTheme(); });
    renderGrid($('piece-sets'), index.pieces, (t) => (index.missing ? null : `themes/piece/${t.id}/wN.${t.ext || 'svg'}`), (id) => { pieces = id; prefs.set('pieceSet', id); applyTheme(); });
    applyTheme();
  }

  function renderGrid(el, items, srcOf, onPick) {
    el.innerHTML = '';
    for (const t of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = t.id;
      b.title = t.licence ? `${t.name} · ${t.author} · ${t.licence}` : t.name;
      b.setAttribute('aria-label', t.name);
      const src = srcOf(t);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        b.appendChild(img);
      } else {
        b.textContent = t.name;
        b.classList.add('text');
      }
      b.onclick = () => onPick(t.id);
      el.appendChild(b);
    }
  }

  applySize();
  applyTheme();
  return { refit: applySize };
}
