// Main controller: wires the opening book, board, engine, tree and study
// panels together. State is a move list (SAN) plus a cursor; everything on
// screen is derived from the position at the cursor.

import { Chess } from '/vendor/chess.js/chess.js';
import { parseOpeningsTsv, buildBook, findNode, pathOf, nearestName, searchOpenings, walk, sanToPgn } from '/shared/book.js';
import { epdOf, sideToMove, fenFromEpd } from '/shared/fen.js';
import { formatScore, scoreForWhite, winningChances } from '/shared/uci.js';
import { api } from '/api.js';
import { createBoard } from '/board.js';
import { EngineClient } from '/engine-client.js';
import { renderTree, describeEval, resetColorCache, stripFamily } from '/tree.js';
import { renderEcoMap } from '/eco-map.js';
import { Drill } from '/study.js';
import { initTheme } from '/theme.js';
import { createPrefs } from '/prefs.js';
import { createGamesPanel } from '/games.js';
import { createExplorerPanel } from '/explorer.js';

const MAX_BROWSER_DEPTH = 26;
const MULTIPV = 3;

const $ = (id) => document.getElementById(id);
const prefs = createPrefs();
const clampDepth = (v) => Math.max(1, Math.min(12, Number(v) || 4));

const state = {
  openings: [],
  root: null,
  line: [],          // SAN moves on the board
  cursor: 0,         // number of moves played from the start
  chess: new Chess(),
  orientation: 'white',
  engineOn: prefs.get('engineOn', true) !== false,
  arrowsOn: prefs.get('arrowsOn', true) !== false,
  live: null,        // latest snapshot from the browser engine for the current epd
  liveEpd: null,
  analysis: new Map(),   // epd -> stored record (null when known to be absent)
  savedDepth: new Map(), // epd -> depth this tab last pushed
  lastSaveNote: '',
  tab: 'explore',
  search: '',
  ecoFilter: null,
  ecoCodes: {},
  treePinned: null,
  treeDepth: clampDepth(prefs.get('treeDepth', 4)),
  treeExpanded: new Set(),
  study: [],
  drillActive: false,
  deepen: null,
  contribute: false,
  contributeCount: 0,
  games: new Map(),       // epd -> imported-game counts for the active perspective (null when none)
  gamesMoves: new Map(),  // epd -> { stats, moves } played from there in the imported games
  gamesFilter: {},        // player / colour perspective, owned by the Games panel
  gamesTotal: 0,
  gamesPlies: 0,
};

const board = createBoard($('board'), { onMove: onBoardMove });
const engine = new EngineClient();
const helper = new EngineClient();
const drill = new Drill({
  onLineStart: (line, i, n) => {
    state.orientation = line.color;
    $('drill-box').hidden = false;
    $('drill-box').innerHTML = `<div class="drill-title">${esc(line.eco || '')} ${esc(line.name)}</div>
      <div class="drill-msg" id="drill-msg"></div>
      <div class="drill-progress">Line ${i + 1} of ${n} · playing as ${line.color} · ${line.san.length} moves</div>
      <div class="btn-row"><button class="btn small" id="drill-skip">skip line</button><button class="btn small" id="drill-quit">stop drilling</button></div>`;
    $('drill-skip').onclick = () => drill.next();
    $('drill-quit').onclick = () => stopDrill();
    render();
  },
  setLine: (sans) => { state.line = sans.slice(); state.cursor = sans.length; render(); },
  playMove: (san) => applyMove(san),
  onMessage: (msg, kind) => {
    const el = $('drill-msg');
    if (el) { el.textContent = msg; el.className = 'drill-msg ' + kind; }
  },
  showHint: (san) => {
    if (!san) return board.setShapes([]);
    const m = tryMove(new Chess(state.chess.fen()), san);
    if (m) board.setShapes([{ orig: m.from, dest: m.to, brush: 'yellow' }]);
  },
  onLineDone: async (line, correct) => {
    try {
      await api.studyResult(line.id, correct);
    } catch (err) {
      console.error(err);
    }
  },
  onFinish: ({ results }) => {
    const ok = results.filter((r) => r.correct).length;
    $('drill-box').innerHTML = `<div class="drill-title">Drill finished</div>
      <div class="drill-msg">${ok} of ${results.length} lines without mistakes.</div>
      <div class="btn-row"><button class="btn small" id="drill-close">close</button></div>`;
    $('drill-close').onclick = () => stopDrill();
    state.drillActive = false;
    refreshStudy();
    render();
  },
});

// ---------------------------------------------------------------------------
// imported games

const games = createGamesPanel({
  api,
  prefs,
  hooks: {
    onFilterChange: (filter) => { state.gamesFilter = filter; state.games.clear(); state.gamesMoves.clear(); render(); },
    onDataChange: () => { syncGamesTotal(); state.games.clear(); state.gamesMoves.clear(); render(); },
    onSelectLine: (sans) => { if (!state.drillActive) setLine(sans); },
    onLoadGame: loadGame,
    showTooltip,
    hideTooltip,
    flash,
    openings: () => state.openings,
    currentEpd: () => epdOf(state.chess.fen()),
    currentCursor: () => state.cursor,
  },
});

const explorerPanel = createExplorerPanel({
  api,
  prefs,
  hooks: {
    onSelectLine: (sans) => { if (!state.drillActive) setLine(sans); },
    currentLine: () => state.line.slice(0, state.cursor),
    flash,
    refreshStudy: () => refreshStudy(),
  },
});

function syncGamesTotal() {
  state.gamesTotal = games.total.games;
  state.gamesPlies = games.total.plies;
  $('tree-games-legend').hidden = !state.gamesTotal;
}

/** Game counts for positions, batched and cached per perspective. */
async function fetchGames(epds) {
  if (!state.gamesTotal) return false;
  const missing = [...new Set(epds)].filter((e) => !state.games.has(e));
  if (!missing.length) return false;
  for (const e of missing) state.games.set(e, null);
  const filter = state.gamesFilter;
  try {
    const { positions } = await api.gamesPositions(missing, filter);
    if (filter !== state.gamesFilter) return false; // perspective changed meanwhile; the cache was cleared
    for (const e of missing) state.games.set(e, positions[e] || null);
  } catch (err) {
    for (const e of missing) state.games.delete(e);
    console.error(err);
  }
  return true;
}

/** The moves played from a position in the imported games, with the position's own counts. */
async function fetchGameMoves(epd) {
  if (!state.gamesTotal || state.gamesMoves.has(epd)) return false;
  state.gamesMoves.set(epd, null);
  const filter = state.gamesFilter;
  try {
    const r = await api.gamesPosition(epd, filter);
    if (filter !== state.gamesFilter) return false;
    state.gamesMoves.set(epd, { stats: r.stats, moves: r.moves });
    state.games.set(epd, r.stats);
  } catch (err) {
    state.gamesMoves.delete(epd);
    console.error(err);
  }
  return true;
}

/** Put an imported game on the board, with the cursor where it reached the position being looked at. */
async function loadGame(id, atPly) {
  if (state.drillActive) return;
  try {
    const { game } = await api.game(id);
    setLine(game.moves, atPly ?? game.moves.length);
    flash(`${game.white || '?'} – ${game.black || '?'}  ${game.result === '1/2-1/2' ? '½-½' : game.result}${game.date ? ` · ${game.date}` : ''}`);
  } catch (err) {
    flash(err.message);
  }
}

/** Stacked result segments (fixed order, 2px surface gaps) for a mini bar. */
function resultSegments(s, persp) {
  const parts = persp ? [['w', s.wins], ['d', s.draws], ['b', s.losses]] : [['w', s.white], ['d', s.draws], ['b', s.black]];
  const known = parts.reduce((n, [, v]) => n + v, 0);
  if (s.games - known > 0) parts.push(['u', s.games - known]);
  return parts.filter(([, v]) => v > 0).map(([k, v]) => `<i class="seg ${k}" style="flex:${v}"></i>`).join('');
}

function describeGames(s, persp) {
  const p = (v) => `${Math.round((100 * v) / s.games)}%`;
  const n = `${s.games.toLocaleString()} game${s.games === 1 ? '' : 's'}`;
  return persp ? `${n} · wins ${p(s.wins)} · draws ${p(s.draws)} · losses ${p(s.losses)}` : `${n} · 1-0 ${p(s.white)} · ½ ${p(s.draws)} · 0-1 ${p(s.black)}`;
}

function renderPositionGames() {
  const el = $('position-games');
  if (!state.gamesTotal || state.drillActive) {
    el.innerHTML = '';
    return;
  }
  const epd = epdOf(state.chess.fen());
  const known = state.gamesMoves.get(epd) || state.games.has(epd);
  if (!known) {
    el.innerHTML = '';
    return;
  }
  const s = state.gamesMoves.get(epd)?.stats ?? state.games.get(epd);
  if (!s) {
    el.innerHTML = `<span class="hint">${state.cursor > state.gamesPlies ? `your games are indexed up to move ${Math.ceil(state.gamesPlies / 2)}` : 'not reached in your games'}</span>`;
    return;
  }
  const persp = games.perspective();
  el.innerHTML = `<span>your games: ${esc(describeGames(s, persp))}</span><span class="mini ${persp ? 'persp' : ''}" title="${esc(describeGames(s, persp))}">${resultSegments(s, persp)}</span>`;
}

// ---------------------------------------------------------------------------
// position helpers

/** chess.js throws on illegal input; we prefer null. */
function tryMove(chess, move) {
  try {
    return chess.move(move);
  } catch {
    return null;
  }
}

function replay(sans) {
  const chess = new Chess();
  for (const san of sans) {
    if (!tryMove(chess, san)) break;
  }
  return chess;
}

function currentNode() {
  return findNode(state.root, state.line.slice(0, state.cursor));
}

function bookAncestor() {
  for (let n = state.cursor; n >= 0; n--) {
    const node = findNode(state.root, state.line.slice(0, n));
    if (node) return node;
  }
  return state.root;
}

/** Make sure every node in the subtree carries fen/epd/uci. */
function annotate(node) {
  if (node.epd && node.annotated) return;
  const chess = replay(pathOf(node));
  const visit = (n) => {
    if (!n.epd) {
      n.fen = chess.fen();
      n.epd = epdOf(n.fen);
    }
    for (const [san, child] of n.children) {
      const m = tryMove(chess, san);
      if (!m) continue;
      if (!child.uci) child.uci = m.from + m.to + (m.promotion || '');
      visit(child);
      chess.undo();
    }
    n.annotated = true;
  };
  visit(node);
}

function ensureEpd(node) {
  if (node.epd) return node.epd;
  const chess = replay(pathOf(node));
  node.fen = chess.fen();
  node.epd = epdOf(node.fen);
  return node.epd;
}

async function fetchAnalysis(epds) {
  const missing = [...new Set(epds)].filter((e) => !state.analysis.has(e));
  if (!missing.length) return false;
  for (const e of missing) state.analysis.set(e, null);
  try {
    const { analysis } = await api.analysisBatch(missing);
    for (const e of missing) state.analysis.set(e, analysis[e] || null);
  } catch (err) {
    for (const e of missing) state.analysis.delete(e);
    console.error(err);
  }
  return true;
}

// ---------------------------------------------------------------------------
// moves

function applyMove(san) {
  if (state.cursor < state.line.length && state.line[state.cursor] === san) {
    state.cursor++;
  } else {
    state.line = state.line.slice(0, state.cursor).concat(san);
    state.cursor = state.line.length;
  }
  render();
}

function onBoardMove(orig, dest) {
  const test = new Chess(state.chess.fen());
  const move = tryMove(test, { from: orig, to: dest, promotion: 'q' });
  if (!move) return render();
  if (state.drillActive) {
    if (!drill.userMoved(move.san)) {
      board.shake();
      render();
    } else {
      applyMove(move.san);
    }
    return;
  }
  applyMove(move.san);
}

function setLine(sans, cursor = sans.length) {
  state.line = sans.slice();
  state.cursor = Math.min(cursor, sans.length);
  render();
}

function goTo(cursor) {
  state.cursor = Math.max(0, Math.min(state.line.length, cursor));
  render();
}

// ---------------------------------------------------------------------------
// engine

let engineFailed = false;
async function startEngine() {
  try {
    await engine.load();
    $('engine-status').textContent = `engine: ${engine.name}`;
    engine.onStatus = ({ searching }) => {
      $('engine-status').textContent = `engine: ${engine.name}${searching ? ' · thinking' : ' · idle'}`;
    };
    analyseCurrent();
  } catch (err) {
    engineFailed = true;
    $('engine-status').textContent = 'engine unavailable: ' + err.message;
    console.error(err);
  }
}

let analyseToken = 0;
async function analyseCurrent() {
  if (engineFailed) return;
  const epd = epdOf(state.chess.fen());
  if (!state.engineOn || state.drillActive || state.chess.isGameOver()) {
    if (state.liveEpd === null) return;
    state.live = null;
    state.liveEpd = null;
    analyseToken++;
    renderEngine();
    await engine.stop();
    return;
  }
  if (state.liveEpd === epd) return; // already analysed or analysing
  const token = ++analyseToken;
  state.live = null;
  state.liveEpd = epd;
  renderEngine();
  const fen = state.chess.fen();
  const result = await engine.analyse(fen, {
    depth: MAX_BROWSER_DEPTH,
    multipv: MULTIPV,
    onUpdate: (snap) => {
      if (token !== analyseToken) return;
      state.live = snap;
      renderEngine();
      renderEvalBar();
      maybeSave(epd, snap, false);
    },
  });
  if (token !== analyseToken || result.stopped) return;
  state.live = result;
  renderEngine();
  maybeSave(epd, result, true);
}

async function maybeSave(epd, snap, final) {
  if (!snap.lines.length || !snap.depth) return;
  const stored = state.analysis.get(epd)?.depth ?? 0;
  const last = Math.max(stored, state.savedDepth.get(epd) ?? 0);
  if (snap.depth <= last) return;
  if (!final && snap.depth < last + 2 && snap.depth < 10) return;
  state.savedDepth.set(epd, snap.depth);
  try {
    const res = await api.saveAnalysis({ epd, depth: snap.depth, lines: snap.lines, nodes: snap.nodes, engine: engine.name });
    if (res.stored) {
      state.analysis.set(epd, res.analysis);
      state.lastSaveNote = `saved depth ${res.analysis.depth}${stored ? ` (was ${stored})` : ''}`;
      renderEngine();
      renderBookMoves();
      renderTreeNow();
    }
  } catch (err) {
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// rendering

let treeTimer = null;
function render() {
  state.chess = replay(state.line.slice(0, state.cursor));
  syncUrl();
  $('subtree-chooser').hidden = true;
  renderBoard();
  renderMoves();
  renderHead();
  renderPositionGames();
  renderEngine();
  renderEvalBar();
  renderBookMoves();
  renderList();
  scheduleTree();
  analyseCurrent();
  games.setPosition(epdOf(state.chess.fen()));
}

/** Keep ?moves= in the address bar equal to the position on the board, so the link can be shared. */
function syncUrl() {
  const sans = state.line.slice(0, state.cursor);
  const url = new URL(location.href);
  if (sans.length) url.searchParams.set('moves', sans.join(' '));
  else url.searchParams.delete('moves');
  const next = url.pathname + url.search + url.hash;
  if (next !== location.pathname + location.search + location.hash) history.replaceState(null, '', next);
}

function renderBoard() {
  const hist = state.chess.history({ verbose: true });
  const last = hist.length ? hist[hist.length - 1] : null;
  board.set(state.chess, {
    lastMove: last,
    orientation: state.orientation,
    movable: !state.drillActive || drill.userToMove(),
    shapes: boardShapes(),
  });
  $('eval-bar').classList.toggle('flipped', state.orientation === 'black');
}

function boardShapes() {
  if (state.drillActive) return [];
  const shapes = [];
  if (state.arrowsOn) {
    const node = currentNode();
    if (node) {
      annotate(node);
      for (const child of node.children.values()) {
        if (child.uci) shapes.push({ orig: child.uci.slice(0, 2), dest: child.uci.slice(2, 4), brush: child.name ? 'green' : 'paleGreen' });
      }
    }
  }
  const best = state.live?.lines?.[0]?.pv?.[0] || state.analysis.get(epdOf(state.chess.fen()))?.bestMove;
  if (best && state.engineOn) shapes.push({ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: 'blue' });
  return shapes;
}

function renderMoves() {
  const el = $('moves');
  el.innerHTML = '';
  const start = document.createElement('span');
  start.className = 'mv' + (state.cursor === 0 ? ' current' : '');
  start.textContent = '⌂';
  start.title = 'Starting position';
  start.onclick = () => goTo(0);
  el.appendChild(start);
  let node = state.root;
  state.line.forEach((san, i) => {
    if (i % 2 === 0) {
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = ` ${i / 2 + 1}.`;
      el.appendChild(num);
    }
    node = node ? node.children.get(san) : null;
    const mv = document.createElement('span');
    mv.className = 'mv' + (i + 1 === state.cursor ? ' current' : '') + (node ? '' : ' offbook');
    mv.textContent = san;
    mv.title = node ? (node.name || '') : 'not in the opening book';
    mv.onclick = () => goTo(i + 1);
    el.appendChild(mv);
    el.appendChild(document.createTextNode(' '));
  });
}

function renderHead() {
  const node = currentNode();
  const named = node ? nearestName(node) : nearestName(bookAncestor());
  const inBook = Boolean(node);
  $('opening-name').textContent = state.cursor === 0 ? 'Starting position' : named ? `${named.eco} · ${named.name}` : 'Unnamed position';
  const meta = [];
  if (!inBook && state.cursor > 0) meta.push('off book');
  else if (node && node.children.size) meta.push(`${node.children.size} book continuation${node.children.size > 1 ? 's' : ''}`);
  else if (node) meta.push('end of book line');
  meta.push(`${state.chess.turn() === 'w' ? 'White' : 'Black'} to move`);
  $('position-meta').textContent = meta.join(' · ');
}

function renderEngine() {
  const epd = epdOf(state.chess.fen());
  const stored = state.analysis.get(epd);
  if (stored === undefined) {
    fetchAnalysis([epd]).then((changed) => { if (changed) { renderEngine(); renderEvalBar(); renderBoard(); } });
  }
  const badge = $('stored-depth');
  badge.textContent = state.drillActive ? 'drilling' : stored ? `stored: depth ${stored.depth} (${stored.source || '?'})` : 'stored: none';
  badge.className = 'badge' + (stored ? (stored.depth >= 20 ? ' good' : '') : ' warn');

  const el = $('engine-lines');
  const source = state.drillActive ? null : state.live?.lines?.length ? state.live : stored;
  el.innerHTML = '';
  if (!source || !source.lines?.length) {
    el.innerHTML = `<div class="hint">${state.engineOn ? (state.drillActive ? 'Engine paused while drilling.' : 'Waiting for the engine…') : 'Engine is off. Showing nothing; stored analysis, if any, is in the badge above.'}</div>`;
  } else {
    const stm = sideToMove(epd);
    for (const line of source.lines) {
      const row = document.createElement('div');
      row.className = 'engine-line';
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = formatScore(scoreForWhite(line.score, stm));
      const pv = document.createElement('span');
      pv.className = 'pv';
      const chess = new Chess(state.chess.fen());
      const sans = [];
      for (const uci of line.pv.slice(0, 12)) {
        const m = tryMove(chess, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        if (!m) break;
        sans.push(m.san);
      }
      sans.forEach((san, i) => {
        const s = document.createElement('span');
        s.className = 'mv';
        const ply = state.cursor + i;
        s.textContent = (ply % 2 === 0 ? `${ply / 2 + 1}.` : i === 0 ? `${Math.floor(ply / 2) + 1}…` : '') + san + ' ';
        s.onclick = () => playPv(sans.slice(0, i + 1));
        pv.appendChild(s);
      });
      row.append(score, pv);
      el.appendChild(row);
    }
  }
  const foot = $('engine-foot');
  const parts = [];
  if (state.drillActive) parts.push('');
  else if (state.live) parts.push(`live depth ${state.live.depth}${state.live.nps ? ` · ${Math.round(state.live.nps / 1000)}k n/s` : ''}`);
  else if (stored) parts.push(`showing stored analysis · ${stored.engine || ''}`);
  foot.innerHTML = `<span>${esc(parts.join(' '))}</span><span class="saved">${esc(state.lastSaveNote)}</span>`;
}

function playPv(sans) {
  const line = state.line.slice(0, state.cursor).concat(sans);
  setLine(line, line.length);
}

function renderEvalBar() {
  const epd = epdOf(state.chess.fen());
  const stm = sideToMove(epd);
  const src = state.drillActive ? null : state.live?.lines?.[0] || state.analysis.get(epd)?.lines?.[0];
  const score = src ? scoreForWhite(src.score, stm) : null;
  const chances = winningChances(score);
  const pct = 50 + chances * 50;
  $('eval-bar-white').style.height = `${pct}%`;
  $('eval-bar-label').textContent = score ? formatScore(score) : '';
}

function renderBookMoves() {
  const node = currentNode();
  const table = $('book-moves');
  table.innerHTML = '';
  const children = node ? [...node.children.values()] : [];
  $('book-count').textContent = node ? `${children.length}` : 'off book';
  if (node) annotate(node);
  const epds = children.map((c) => c.epd).filter(Boolean);
  fetchAnalysis(epds).then((changed) => { if (changed) renderBookMoves(); });
  const epd = epdOf(state.chess.fen());
  const gm = state.gamesTotal ? state.gamesMoves.get(epd) : undefined;
  if (state.gamesTotal && gm === undefined) fetchGameMoves(epd).then((changed) => { if (changed) { renderBookMoves(); renderPositionGames(); } });
  const bySan = new Map((gm?.moves || []).map((m) => [m.san, m]));
  const persp = games.perspective();
  const gameCell = (s) => (state.gamesTotal
    ? `<td class="games" title="${s ? esc(describeGames(s, persp)) : ''}">${s ? `${s.games.toLocaleString()}<span class="mini ${persp ? 'persp' : ''}">${resultSegments(s, persp)}</span>` : ''}</td>`
    : '');
  const stmAfter = state.chess.turn() === 'w' ? 'b' : 'w';
  const rows = children.map((child) => ({ child, a: state.analysis.get(child.epd) }));
  // Best for the side to move first, unanalysed last
  const mover = state.chess.turn();
  rows.sort((x, y) => {
    const sx = x.a ? winningChances(scoreForWhite(x.a.score, stmAfter)) : null;
    const sy = y.a ? winningChances(scoreForWhite(y.a.score, stmAfter)) : null;
    if (sx === null && sy === null) return 0;
    if (sx === null) return 1;
    if (sy === null) return -1;
    return mover === 'w' ? sy - sx : sx - sy;
  });
  for (const { child, a } of rows) {
    const tr = document.createElement('tr');
    const white = a ? scoreForWhite(a.score, stmAfter) : null;
    tr.innerHTML = `<td class="san">${esc(child.san)}</td><td class="name" title="${esc(child.name || '')}">${esc(child.name ? shortName(child, node) : '')}</td>
      <td class="eval">${white ? esc(formatScore(white)) : '<span class="hint">–</span>'}</td><td class="depth">${a ? `d${a.depth}` : ''}</td>${gameCell(bySan.get(child.san))}`;
    tr.onclick = () => applyMove(child.san);
    table.appendChild(tr);
  }
  // Moves played in the imported games that the book does not have (all of them when off book)
  for (const m of gm?.moves || []) {
    if (node && node.children.has(m.san)) continue;
    const tr = document.createElement('tr');
    tr.className = 'offbook';
    tr.innerHTML = `<td class="san">${esc(m.san)}</td><td class="name">${node ? 'not in the book' : ''}</td><td class="eval"></td><td class="depth"></td>${gameCell(m)}`;
    tr.onclick = () => applyMove(m.san);
    table.appendChild(tr);
  }
  if (!node && gm?.moves?.length) $('book-count').textContent = 'off book · your games';
  $('add-subtree').disabled = !node || node.children.size === 0;
  $('deepen-here').disabled = !node;
  $('add-white').disabled = $('add-black').disabled = state.cursor === 0;
}

function shortName(child, parent) {
  return stripFamily(child.name, nearestName(parent)?.name);
}

function renderList() {
  const el = $('opening-list');
  const q = state.search;
  let ids;
  if (q) ids = searchOpenings(state.openings, q, 400);
  else if (state.ecoFilter) ids = state.openings.map((_, i) => i).filter((i) => state.openings[i].eco === state.ecoFilter);
  else ids = state.openings.map((_, i) => i).slice(0, 400);
  const activeKey = state.line.slice(0, state.cursor).join(' ');
  const frag = document.createDocumentFragment();
  for (const i of ids) {
    const op = state.openings[i];
    const li = document.createElement('li');
    if (op.san.join(' ') === activeKey) li.className = 'active';
    li.innerHTML = `<span class="eco">${esc(op.eco)}</span><span class="name">${esc(op.name)}</span><span class="pgn">${esc(op.pgn)}</span>`;
    li.onclick = () => { if (state.drillActive) return; setLine(op.san); };
    frag.appendChild(li);
  }
  el.innerHTML = '';
  el.appendChild(frag);
  if (!q && !state.ecoFilter && state.openings.length > 400) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="eco"></span><span class="hint">${state.openings.length - 400} more… use search or the ECO map</span>`;
    el.appendChild(li);
  }
  $('eco-clear').hidden = !state.ecoFilter;
}

function treeRoot() {
  if (state.treePinned) return state.treePinned;
  return bookAncestor();
}

function scheduleTree() {
  clearTimeout(treeTimer);
  $('tree-panel').hidden = state.drillActive;
  if (!state.drillActive) treeTimer = setTimeout(renderTreeNow, 30);
}

function renderTreeNow() {
  const root = treeRoot();
  annotate(root);
  const current = currentNode();
  const named = nearestName(root);
  $('tree-root-name').textContent = root === state.root ? 'whole book' : `${named ? named.eco + ' ' + named.name : ''} (${pathOf(root).join(' ')})`;
  $('tree-up').disabled = root === state.root;
  const svg = $('tree');
  // First pass to learn which nodes are visible, fetch their analysis, and redraw.
  const visibleEpds = [];
  walk(root, (n) => { if (n.ply - root.ply <= state.treeDepth + 1 && n.epd) visibleEpds.push(n.epd); });
  fetchAnalysis(visibleEpds.slice(0, 4000)).then((changed) => { if (changed) renderTreeNow(); });
  fetchGames(visibleEpds.slice(0, 4000)).then((changed) => { if (changed) renderTreeNow(); });
  renderTree(svg, {
    root,
    current,
    depth: state.treeDepth,
    expanded: state.treeExpanded,
    analysis: state.analysis,
    games: state.gamesTotal ? state.games : null,
    onSelect: (node) => { if (!state.drillActive) setLine(pathOf(node)); },
    onToggle: (node) => {
      if (state.treeExpanded.has(node)) state.treeExpanded.delete(node);
      else {
        state.treeExpanded.add(node);
        annotate(node);
      }
      renderTreeNow();
    },
    onHover: (e, node, a) => {
      if (!node) return hideTooltip();
      const named = nearestName(node);
      const g = state.gamesTotal && node.epd ? state.games.get(node.epd) : null;
      const html = `<div class="t">${esc(pathOf(node).join(' ') || 'start')}</div>
        <div>${esc(node.name ? node.name : named ? `in ${named.name}` : '')}</div>
        <div class="d">${esc(describeEval(a, node.epd))}${a?.bestMove ? ` · best ${esc(a.bestMove)}` : ''}${node.openings.length ? ` · ${node.openings.length} named opening${node.openings.length > 1 ? 's' : ''} end here` : ''}</div>
        ${g ? `<div class="d">your games: ${esc(describeGames(g, games.perspective()))}</div>` : ''}`;
      showTooltip(html, e);
    },
  });
}

// ---------------------------------------------------------------------------
// ECO map & list

async function refreshEco() {
  try {
    const { codes } = await api.eco();
    state.ecoCodes = codes;
    renderEcoMapNow();
  } catch (err) {
    console.error(err);
  }
}

function renderEcoMapNow() {
  renderEcoMap($('eco-map'), state.ecoCodes, {
    selected: state.ecoFilter,
    onSelect: (code) => {
      state.ecoFilter = state.ecoFilter === code ? null : code;
      state.search = '';
      $('search').value = '';
      renderEcoMapNow();
      renderList();
    },
    onHover: (e, code, c) => {
      if (!code) return hideTooltip();
      showTooltip(`<div class="t">${code}</div><div>${c.openings} named openings · ${c.positions} positions</div>
        <div class="d">${c.analysed} analysed · average depth ${c.avgDepth} · shallowest ${c.minDepth}</div>`, e);
    },
  });
}

// ---------------------------------------------------------------------------
// study

async function refreshStudy() {
  try {
    const { lines, now } = await api.studyList();
    state.study = lines;
    state.studyNow = now;
    renderStudy();
  } catch (err) {
    console.error(err);
  }
}

function renderStudy() {
  const el = $('study-list');
  el.innerHTML = '';
  const now = Date.parse(state.studyNow || new Date().toISOString());
  $('study-empty').hidden = state.study.length > 0;
  let due = 0;
  for (const line of state.study) {
    const isDue = Date.parse(line.due) <= now;
    if (isDue) due++;
    const li = document.createElement('li');
    const acc = line.attempts ? Math.round((100 * line.correct) / line.attempts) + '%' : 'new';
    li.innerHTML = `<span><span class="eco">${esc(line.eco || '')}</span> ${esc(line.name)} <span class="hint">as ${line.color}</span></span>
      <span class="meta"><span class="${isDue ? 'due' : ''}">${isDue ? 'due' : 'due ' + relDate(line.due, now)}</span><span class="box" title="Leitner box">box ${line.box}</span><span title="accuracy">${acc}</span>
      <button class="link" data-remove="${line.id}" title="remove from study set">✕</button></span>
      <span class="pgn">${esc(line.san.join(' '))}</span>`;
    li.onclick = (e) => {
      if (e.target.dataset.remove) {
        e.stopPropagation();
        api.studyRemove(line.id).then(refreshStudy);
        return;
      }
      if (!state.drillActive) { state.orientation = line.color; setLine(line.san); }
    };
    el.appendChild(li);
  }
  $('drill-due').textContent = `Drill due (${due})`;
  $('drill-due').disabled = due === 0;
  $('drill-all').disabled = state.study.length === 0;
}

function relDate(iso, now) {
  const days = Math.round((Date.parse(iso) - now) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} d`;
}

function startDrill(lines) {
  if (!lines.length) return;
  state.drillActive = true;
  state.treePinned = null;
  engine.stop();
  const shuffled = lines.slice().sort(() => Math.random() - 0.5);
  drill.start(shuffled);
}

function stopDrill() {
  drill.stop();
  state.drillActive = false;
  state.liveEpd = null;
  $('drill-box').hidden = true;
  refreshStudy();
  render();
}

async function addStudyLine(color) {
  const sans = state.line.slice(0, state.cursor);
  if (!sans.length) return;
  const node = currentNode();
  const named = node ? nearestName(node) : nearestName(bookAncestor());
  try {
    const res = await api.studyAdd({ san: sans, color, name: named?.name || sans.join(' '), eco: named?.eco || null });
    flash(res.created ? `Added to study set as ${color}` : 'Already in the study set');
    refreshStudy();
  } catch (err) {
    flash(err.message);
  }
}

function addSubtree() {
  const node = currentNode();
  if (!node) return;
  const leaves = [];
  walk(node, (n) => { if (n.children.size === 0 || n.openings.length) leaves.push(n); });
  $('subtree-chooser-text').textContent = `Add ${leaves.length} variation${leaves.length === 1 ? '' : 's'} below this position, drilled`;
  $('subtree-white').onclick = () => addLeaves(leaves, 'white');
  $('subtree-black').onclick = () => addLeaves(leaves, 'black');
  $('subtree-chooser').hidden = false;
}

async function addLeaves(leaves, color) {
  $('subtree-chooser').hidden = true;
  let added = 0;
  for (const leaf of leaves) {
    const named = nearestName(leaf);
    try {
      const res = await api.studyAdd({ san: pathOf(leaf), color, name: named?.name || '', eco: named?.eco || null });
      if (res.created) added++;
    } catch (err) {
      console.error(err);
    }
  }
  flash(`Added ${added} new lines`);
  refreshStudy();
}

// ---------------------------------------------------------------------------
// analysis tab: stats & deepening

async function refreshStats() {
  try {
    const s = await api.stats();
    const tiles = [
      [`${s.book.analysed} / ${s.book.positions}`, 'book positions analysed'],
      [s.count, 'positions stored (incl. off-book)'],
      [s.avgDepth, 'average stored depth'],
      [s.maxDepth, 'deepest stored'],
    ];
    $('stat-tiles').innerHTML = tiles.map(([v, l]) => `<div class="stat-tile"><div class="v">${esc(String(v))}</div><div class="l">${esc(l)}</div></div>`).join('');
    const hist = $('hist');
    hist.innerHTML = '';
    const max = Math.max(1, ...s.histogram.map((h) => h.count));
    const depths = s.histogram.map((h) => h.depth);
    const lo = depths.length ? Math.min(...depths) : 0;
    const hi = depths.length ? Math.max(...depths) : 0;
    const byDepth = new Map(s.histogram.map((h) => [h.depth, h.count]));
    for (let d = lo; d <= hi && depths.length; d++) {
      const c = byDepth.get(d) || 0;
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = `${Math.max(2, (100 * c) / max)}%`;
      bar.title = `depth ${d}: ${c} position${c === 1 ? '' : 's'}`;
      bar.addEventListener('mouseenter', (e) => showTooltip(`<div class="t">depth ${d}</div><div>${c} position${c === 1 ? '' : 's'}</div>`, e));
      bar.addEventListener('mouseleave', hideTooltip);
      hist.appendChild(bar);
    }
    let axis = document.querySelector('.hist-axis');
    if (!axis) {
      axis = document.createElement('div');
      axis.className = 'hist-axis';
      hist.after(axis);
    }
    axis.innerHTML = depths.length ? `<span>depth ${lo}</span><span>depth ${hi}</span>` : '<span>nothing stored yet</span>';
  } catch (err) {
    console.error(err);
  }
}

async function refreshDeepen() {
  try {
    state.deepen = await api.deepenStatus();
    renderDeepen();
  } catch (err) {
    console.error(err);
  }
}

function renderDeepen() {
  const d = state.deepen;
  if (!d) return;
  const badge = $('deepen-state');
  badge.textContent = d.running ? 'running' : d.lastError ? 'error' : 'stopped';
  badge.className = 'badge' + (d.running ? ' good' : d.lastError ? ' warn' : '');
  if (document.activeElement !== $('deepen-depth')) $('deepen-depth').value = d.targetDepth;
  if (document.activeElement !== $('deepen-multipv')) $('deepen-multipv').value = d.multipv;
  $('deepen-scope').textContent = d.scope.length ? d.scope.join(' ') : 'whole book';
  const pct = d.total ? Math.round((100 * d.done) / d.total) : 0;
  $('deepen-progress').innerHTML = `
    <div>${d.done} of ${d.total} positions at depth ≥ ${d.targetDepth} in scope${d.running ? ` · ${d.remaining} to go` : ''}</div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div>${d.running && d.current ? `working on <span class="mono">${esc(d.current.epd)}</span>` : ''}</div>
    <div>${d.lastResult ? `last: depth ${d.lastResult.depth} in ${(d.lastResult.ms / 1000).toFixed(1)} s · ${d.improved} improved this run` : ''}</div>
    <div>${d.lastError ? `<span style="color:var(--bad)">${esc(d.lastError)}</span>` : ''}${d.engine ? `<span class="hint">${esc(d.engine)}</span>` : ''}</div>`;
  $('deepen-start').textContent = d.running ? 'Apply' : 'Start';
  $('deepen-stop').disabled = !d.running;
}

function deepenOpts() {
  return { targetDepth: Number($('deepen-depth').value), multipv: Number($('deepen-multipv').value) };
}

async function contributeLoop() {
  let idleNote = 0;
  while (state.contribute) {
    let batch;
    try {
      batch = await api.deepenNext(3, Number($('deepen-depth').value) || undefined);
    } catch (err) {
      $('contribute-status').textContent = err.message;
      await sleep(10000);
      continue;
    }
    if (!batch.positions.length) {
      $('contribute-status').textContent = `Nothing left below depth ${batch.targetDepth} in scope; checking again in 30 s. ${state.contributeCount} positions done in this tab.`;
      idleNote++;
      await sleep(30000);
      continue;
    }
    for (const p of batch.positions) {
      if (!state.contribute) break;
      $('contribute-status').textContent = `Analysing ${p.epd} (stored depth ${p.depth}) to depth ${batch.targetDepth}… ${state.contributeCount} done in this tab.`;
      const r = await helper.analyse(fenFromEpd(p.epd), { depth: batch.targetDepth, multipv: MULTIPV });
      if (r.stopped || !r.lines.length) continue;
      try {
        const res = await api.saveAnalysis({ epd: p.epd, depth: r.depth, lines: r.lines, nodes: r.nodes, engine: helper.name });
        if (res.stored) {
          state.contributeCount++;
          state.analysis.set(p.epd, res.analysis);
        }
      } catch (err) {
        console.error(err);
      }
    }
    refreshDeepen();
  }
  $('contribute-status').textContent = `Stopped. ${state.contributeCount} positions deepened in this tab.`;
}

// ---------------------------------------------------------------------------
// tabs & misc UI

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('panel-explore-list').hidden = tab !== 'explore';
  $('panel-study-list').hidden = tab !== 'study';
  $('panel-explorer').hidden = tab !== 'study';
  $('panel-games').hidden = tab !== 'games';
  $('panel-analysis-stats').hidden = tab !== 'analysis';
  $('panel-deepen').hidden = tab !== 'analysis';
  $('panel-book').hidden = tab === 'analysis';
  if (tab === 'study') { refreshStudy(); explorerPanel.show(); } else explorerPanel.hide();
  if (tab === 'games') games.show(); else games.hide();
  if (tab === 'analysis') { refreshStats(); refreshDeepen(); }
}

function showTooltip(html, e) {
  const t = $('tooltip');
  t.innerHTML = html;
  t.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - 330);
  const y = Math.min(e.clientY + 14, window.innerHeight - 90);
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
function hideTooltip() { $('tooltip').hidden = true; }

let flashTimer;
function flash(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

/** Clipboard API where available (https, localhost); a hidden textarea elsewhere (plain http on a LAN). */
async function copyText(text, what) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  flash(ok ? `${what} copied` : `Could not copy the ${what}`);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bind() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('nav-start').onclick = () => goTo(0);
  $('nav-back').onclick = () => goTo(state.cursor - 1);
  $('nav-fwd').onclick = () => goTo(state.cursor + 1);
  $('nav-end').onclick = () => goTo(state.line.length);
  $('flip').onclick = () => { state.orientation = state.orientation === 'white' ? 'black' : 'white'; renderBoard(); };
  $('engine-toggle').checked = state.engineOn;
  $('arrows-toggle').checked = state.arrowsOn;
  $('tree-depth').value = state.treeDepth;
  $('engine-toggle').onchange = (e) => { state.engineOn = e.target.checked; prefs.set('engineOn', state.engineOn); state.live = null; state.liveEpd = null; render(); };
  $('arrows-toggle').onchange = (e) => { state.arrowsOn = e.target.checked; prefs.set('arrowsOn', state.arrowsOn); renderBoard(); };
  $('copy-link').onclick = () => copyText(location.href, 'link');
  $('copy-pgn').onclick = () => copyText(sanToPgn(state.line.slice(0, state.cursor)), 'PGN');
  $('copy-fen').onclick = () => copyText(state.chess.fen(), 'FEN');
  $('subtree-cancel').onclick = () => { $('subtree-chooser').hidden = true; };
  $('search').oninput = (e) => { state.search = e.target.value; state.ecoFilter = null; renderList(); renderEcoMapNow(); };
  $('eco-clear').onclick = () => { state.ecoFilter = null; renderList(); renderEcoMapNow(); };
  $('add-white').onclick = () => addStudyLine('white');
  $('add-black').onclick = () => addStudyLine('black');
  $('add-subtree').onclick = addSubtree;
  $('deepen-here').onclick = async () => {
    const node = currentNode();
    if (!node) return;
    annotate(node);
    const epds = [];
    walk(node, (n) => { if (n.epd) epds.push(n.epd); });
    try {
      const res = await api.deepenPrioritize(epds.slice(0, 2000));
      if (!res.status.running) await api.deepenStart({});
      flash(`${res.queued} positions moved to the front of the deepening queue`);
      refreshDeepen();
    } catch (err) {
      flash(err.message);
    }
  };
  $('drill-due').onclick = () => {
    const now = Date.parse(state.studyNow);
    startDrill(state.study.filter((l) => Date.parse(l.due) <= now));
  };
  $('drill-all').onclick = () => startDrill(state.study);
  $('tree-pin').onchange = (e) => { state.treePinned = e.target.checked ? treeRoot() : null; renderTreeNow(); };
  $('tree-depth').onchange = (e) => { state.treeDepth = clampDepth(e.target.value); prefs.set('treeDepth', state.treeDepth); renderTreeNow(); };
  $('tree-up').onclick = () => {
    const root = treeRoot();
    if (root.parent) { state.treePinned = root.parent; $('tree-pin').checked = true; renderTreeNow(); }
  };
  $('deepen-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const opts = deepenOpts();
      state.deepen = state.deepen?.running ? await api.deepenConfigure(opts) : await api.deepenStart(opts);
      renderDeepen();
    } catch (err) { flash(err.message); }
  };
  $('deepen-stop').onclick = async () => { state.deepen = await api.deepenStop(); renderDeepen(); };
  $('deepen-scope-here').onclick = async () => {
    const scope = state.line.slice(0, state.cursor);
    state.deepen = await api.deepenConfigure({ scope });
    renderDeepen();
  };
  $('deepen-scope-all').onclick = async () => { state.deepen = await api.deepenConfigure({ scope: [] }); renderDeepen(); };
  $('contribute-toggle').onchange = (e) => {
    state.contribute = e.target.checked;
    if (state.contribute) contributeLoop();
    else helper.stop();
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') goTo(state.cursor - 1);
    else if (e.key === 'ArrowRight') goTo(state.cursor + 1);
    else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(state.line.length);
    else if (e.key === 'f') $('flip').click();
  });
  // Theme: the tree caches resolved colours, so it is redrawn whenever the shown theme changes.
  const theme = initTheme({ onChange: () => { resetColorCache(); renderTreeNow(); } });
  const seg = $('theme-seg');
  const syncSeg = () => seg.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === theme.preference)));
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-choice]');
    if (!b) return;
    theme.set(b.dataset.themeChoice);
    syncSeg();
  });
  syncSeg();
  setInterval(() => { if (state.tab === 'analysis') { refreshDeepen(); } }, 3000);
  setInterval(() => { if (state.tab === 'analysis') refreshStats(); }, 15000);
}

async function main() {
  bind();
  const { openings } = await api.openings();
  state.openings = openings;
  state.root = buildBook(openings);
  ensureEpd(state.root);
  // Deep link: ?moves=e4 c5 Nf3
  const params = new URLSearchParams(location.search);
  const moves = (params.get('moves') || '').split(/\s+/).filter(Boolean);
  render();
  if (moves.length) setLine(moves);
  refreshEco();
  refreshStudy();
  refreshDeepen();
  startEngine();
  games.refreshImports().then(() => {
    syncGamesTotal();
    state.gamesFilter = games.filter();
    if (state.gamesTotal) render();
  });
}

main().catch((err) => {
  console.error(err);
  $('engine-status').textContent = 'failed to load: ' + err.message;
});

// exported for debugging in the console
window.openingStudy = { state, board, engine, helper, setLine, parseOpeningsTsv, games };
