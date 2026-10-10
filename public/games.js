// Games tab: import PGN files and tournaments and show which openings they
// contain. Owns the import forms (a file upload with progress, or a
// chess-results.com tournament or PGN address the server fetches, polling
// the server while it parses), the list of imports, the filters (one import
// or all, whose results, as which colour), the opening chart, the ECO
// frequency map and the game list. The
// main controller supplies the board: it is told which line or game to show
// and which filter is active, and it asks for the current position.

import { renderEcoMap, frequencyColor } from '/eco-map.js';

const PAGE = 40;

/**
 * @param {object} o
 * @param {object} o.api
 * @param {object} o.prefs
 * @param {object} o.hooks
 * @param {(filter) => void} o.hooks.onFilterChange   player / colour perspective changed
 * @param {() => void} o.hooks.onDataChange           games were imported or deleted
 * @param {(sans: string[]) => void} o.hooks.onSelectLine
 * @param {(id: number, atPly: number|undefined) => void} o.hooks.onLoadGame
 * @param {(html, event) => void} o.hooks.showTooltip
 * @param {() => void} o.hooks.hideTooltip
 * @param {(msg) => void} o.hooks.flash
 * @param {() => Array} o.hooks.openings               the book's opening records
 * @param {() => string} o.hooks.currentEpd
 */
export function createGamesPanel({ api, prefs, hooks }) {
  const $ = (id) => document.getElementById(id);
  const st = {
    imports: [],
    total: { games: 0, positions: 0, plies: 0 },
    running: null,
    canImport: true,
    canShare: false,
    player: prefs.get('gamesPlayer', null), // null = never chosen: follow the newest import
    color: prefs.get('gamesColor', '') || '',
    importId: null, // one import (a tournament) to look at, or null for all of them
    fetching: null, // the address the server is fetching games from, while it does
    by: ['family', 'opening', 'eco'].includes(prefs.get('gamesBy')) ? prefs.get('gamesBy') : 'family',
    summary: null,
    eco: null,
    list: { mode: 'position', epd: null, params: {}, title: 'Games at this position', items: [], total: 0 },
    file: null,
    uploading: false,
    visible: false,
    pollTimer: null,
    listToken: 0,
  };

  // ---- filter -----------------------------------------------------------

  function player() {
    if (st.player !== null) return st.player;
    const withPlayer = st.imports.find((i) => i.player && i.own);
    return withPlayer ? withPlayer.player : '';
  }

  /** The import / player / colour filter as API parameters. */
  function filter() {
    const p = player();
    const f = p ? { player: p, color: st.color || undefined } : {};
    if (st.importId) f.import = st.importId;
    return f;
  }

  function perspective() {
    return Boolean(player());
  }

  /** The import being looked at, or null for all of them. */
  function selectedImport() {
    return st.importId ? st.imports.find((i) => i.id === st.importId) || null : null;
  }

  function renderFilter() {
    if (st.importId && !selectedImport()) st.importId = null; // removed, or no longer visible
    const imps = $('games-import');
    imps.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'all imports';
    imps.appendChild(all);
    for (const imp of st.imports) {
      const opt = document.createElement('option');
      opt.value = String(imp.id);
      opt.textContent = `${shorten(imp.name, 48)} (${fmt(imp.games)})`;
      imps.appendChild(opt);
    }
    imps.value = st.importId ? String(st.importId) : '';
    imps.parentElement.hidden = st.imports.length < 2 && !st.importId;
    const sel = $('games-player');
    const names = [...new Set(st.imports.map((i) => i.player).filter(Boolean))];
    const current = player();
    if (current && !names.includes(current)) names.push(current);
    sel.innerHTML = '';
    const both = document.createElement('option');
    both.value = '';
    both.textContent = 'both sides';
    sel.appendChild(both);
    for (const n of names) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    }
    sel.value = current;
    $('games-color-seg').hidden = !current;
    $('games-color-seg').querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === st.color)));
    $('games-by-seg').querySelectorAll('[data-by]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.by === st.by)));
  }

  function filterChanged() {
    renderFilter();
    hooks.onFilterChange(filter());
    refreshOverview();
  }

  // ---- imports ----------------------------------------------------------

  async function refreshImports() {
    try {
      const r = await api.gamesImports();
      st.imports = r.imports;
      st.total = r.total;
      st.running = r.running;
      st.canImport = r.canImport !== false;
      st.canShare = Boolean(r.canShare);
      renderImports();
      renderFilter();
      if (st.running) schedulePoll();
    } catch (err) {
      console.error(err);
    }
  }

  function schedulePoll() {
    clearTimeout(st.pollTimer);
    st.pollTimer = setTimeout(async () => {
      await refreshImports();
      if (st.running) renderProgress();
    }, 1000);
  }

  function renderImports() {
    const el = $('import-list');
    el.innerHTML = '';
    for (const imp of st.imports) {
      const li = document.createElement('li');
      const when = imp.createdAt ? new Date(imp.createdAt).toLocaleDateString() : '';
      const notes = [];
      if (imp.duplicates) notes.push(`${fmt(imp.duplicates)} duplicates skipped`);
      if (imp.invalid) notes.push(`${fmt(imp.invalid)} with illegal moves`);
      if (imp.error) notes.push(`stopped: ${imp.error}`);
      if (!imp.finished) notes.push('importing…');
      const shareLink = st.canShare && imp.own
        ? `<button class="link" data-share="${imp.shared ? 0 : 1}" title="${imp.shared ? 'Stop sharing these games with visitors' : 'Let everyone who opens this site see these games'}">${imp.shared ? 'make private' : 'share with everyone'}</button>`
        : '';
      const source = imp.source && /^https?:\/\//.test(imp.source)
        ? ` <a class="ext" href="${esc(imp.source)}" target="_blank" rel="noopener" title="Fetched from ${esc(imp.source)}">${/chess-results\.com/i.test(imp.source) ? 'chess-results' : 'source'} ↗</a>`
        : '';
      li.innerHTML = `<span class="imp-name" title="${esc(imp.name)}"><button class="link name" data-select="${imp.id}" title="Show the openings of this import only">${esc(imp.name)}</button>${source}${imp.shared ? ' <span class="badge good" title="Visible to everyone who opens this site">shared</span>' : ''}${imp.own ? '' : ' <span class="badge" title="Shared by this site">site</span>'}</span>
        <span class="imp-meta">${fmt(imp.games)} games${imp.player ? ` · ${esc(imp.player)}` : ''} · ${esc(when)}${notes.length ? ` · <span class="${imp.error ? 'warn' : ''}">${esc(notes.join(' · '))}</span>` : ''}${shareLink ? ` · ${shareLink}` : ''}</span>
        ${imp.own ? `<button class="link" data-remove="${imp.id}" title="Remove this import and its games">✕</button>` : ''}`;
      li.querySelector('[data-select]').onclick = () => selectImport(st.importId === imp.id ? null : imp.id);
      li.querySelector('[data-share]')?.addEventListener('click', async (e) => {
        try {
          await api.gamesShare(imp.id, e.target.dataset.share === '1');
          await dataChanged();
        } catch (err) {
          hooks.flash(err.message);
        }
      });
      if (imp.own) li.querySelector('[data-remove]').onclick = async () => {
        if (!confirm(`Remove "${imp.name}" and its ${fmt(imp.games)} games?`)) return;
        try {
          await api.gamesDeleteImport(imp.id);
          if (st.importId === imp.id) st.importId = null;
          hooks.flash('Import removed');
          await dataChanged();
        } catch (err) {
          hooks.flash(err.message);
        }
      };
      el.appendChild(li);
    }
    const total = st.total.games;
    $('games-total').textContent = total ? `${fmt(total)} games · indexed to move ${Math.ceil(st.total.plies / 2)}` : '';
    $('import-form').hidden = !st.canImport;
    $('import-url-form').hidden = !st.canImport;
    $('import-signin').hidden = st.canImport;
    $('games-empty').hidden = total > 0 || st.imports.length > 0 || !st.canImport;
    $('games-overview').hidden = total === 0;
  }

  function renderProgress() {
    const box = $('import-progress');
    if (!st.uploading && !st.fetching && !st.running) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const r = st.running;
    const parts = [];
    if (st.uploading) parts.push(`uploading ${Math.round(100 * (st.uploadFraction || 0))}%`);
    if (st.fetching) parts.push(r ? `fetching ${r.name}` : `fetching from ${st.fetching}…`);
    if (r) parts.push(`${fmt(r.games)} games stored${r.duplicates ? `, ${fmt(r.duplicates)} duplicates` : ''}`);
    $('import-status').textContent = parts.join(' · ');
    $('import-bar').style.width = st.fetching ? (r ? '100%' : '0') : `${Math.round(100 * (st.uploadFraction || 0))}%`;
    $('import-bar').classList.toggle('busy', Boolean(st.fetching && !r));
  }

  /** Fetch a chess-results.com tournament (or a PGN address) through the server. */
  async function startUrlImport(e) {
    e.preventDefault();
    const url = $('import-url').value.trim();
    if (!url || st.fetching || st.uploading) return;
    const playerName = $('import-player').value.trim();
    st.fetching = /^\d+$/.test(url) ? 'chess-results.com' : (() => { try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname; } catch { return url; } })();
    $('import-url-start').disabled = true;
    renderProgress();
    schedulePoll();
    try {
      const { import: record } = await api.gamesImportUrl(url, { player: playerName || undefined });
      const secs = (record.ms / 1000).toFixed(record.ms < 10000 ? 1 : 0);
      hooks.flash(`Imported ${fmt(record.games)} games of ${record.name} in ${secs} s${record.duplicates ? ` (${fmt(record.duplicates)} duplicates skipped)` : ''}`);
      // Look at the tournament that was just fetched: from the named player's
      // point of view, or from both sides (a remembered name would hide it).
      st.player = playerName;
      prefs.set('gamesPlayer', playerName);
      st.importId = record.id;
      $('import-url').value = '';
    } catch (err) {
      hooks.flash(err.message);
    } finally {
      st.fetching = null;
      $('import-url-start').disabled = !$('import-url').value.trim();
      clearTimeout(st.pollTimer);
      renderProgress();
      await dataChanged();
    }
  }

  /** Look at one import only (null: all), everywhere in the app. */
  function selectImport(id) {
    st.importId = id;
    filterChanged();
  }

  async function startImport(e) {
    e.preventDefault();
    const file = st.file;
    if (!file || st.uploading) return;
    const playerName = $('import-player').value.trim();
    st.uploading = true;
    st.uploadFraction = 0;
    $('import-start').disabled = true;
    renderProgress();
    schedulePoll();
    try {
      const { import: record } = await api.gamesImport(file, {
        name: file.name,
        player: playerName || undefined,
        onProgress: (f) => { st.uploadFraction = f; renderProgress(); },
      });
      const secs = (record.ms / 1000).toFixed(record.ms < 10000 ? 1 : 0);
      hooks.flash(`Imported ${fmt(record.games)} games in ${secs} s${record.duplicates ? ` (${fmt(record.duplicates)} duplicates skipped)` : ''}`);
      if (playerName && st.player === null) st.player = playerName;
      if (playerName) { st.player = playerName; prefs.set('gamesPlayer', playerName); }
      st.file = null;
      $('import-file').value = '';
      $('import-file-name').textContent = 'no file chosen';
    } catch (err) {
      hooks.flash(err.message);
    } finally {
      st.uploading = false;
      clearTimeout(st.pollTimer);
      renderProgress();
      await dataChanged();
    }
  }

  async function dataChanged() {
    await refreshImports();
    renderProgress();
    hooks.onFilterChange(filter());
    hooks.onDataChange();
    refreshOverview();
  }

  // ---- overview: tiles, opening chart, ECO map -----------------------------

  async function refreshOverview() {
    if (!st.visible || !st.total.games) return;
    try {
      const f = filter();
      const [summary, eco] = await Promise.all([api.gamesOpenings(st.by, f, 30), api.gamesOpenings('eco', f, 500)]);
      st.summary = summary;
      st.eco = eco;
      renderTiles();
      renderBars();
      renderEco();
      renderLegend();
      refreshList();
    } catch (err) {
      console.error(err);
    }
  }

  function score(s) {
    if (!s.games) return null;
    const pts = perspective() ? s.wins + s.draws / 2 : s.white + s.draws / 2;
    return pts / s.games;
  }

  function renderTiles() {
    const t = st.summary.total;
    const persp = perspective();
    const top = st.summary.groups[0];
    const imp = selectedImport();
    const tiles = [
      [fmt(t.games), `games${persp ? ` of ${player()}${st.color ? ` as ${st.color}` : ''}` : ''}${imp ? ` in ${shorten(imp.name, 40)}` : ''}`],
      [t.games ? pct(score(t)) : '–', persp ? 'score' : "White's score"],
      [t.games ? pct(t.draws / t.games) : '–', 'draws'],
    ];
    const topTile = top ? `<div class="stat-tile wide"><div class="v" title="${esc(top.name || '')}">${esc(top.name || 'not in the book')}</div><div class="l">most played ${st.by === 'eco' ? 'ECO code' : st.by} · ${fmt(top.games)} games, ${pct(top.games / t.games)}</div></div>` : '';
    $('games-tiles').innerHTML = tiles.map(([v, l]) => `<div class="stat-tile"><div class="v" title="${esc(String(v))}">${esc(String(v))}</div><div class="l">${esc(l)}</div></div>`).join('') + topTile;
  }

  function renderLegend() {
    const persp = perspective();
    const labels = persp ? ['wins', 'draws', 'losses'] : ['White wins', 'draws', 'Black wins'];
    $('games-legend').innerHTML = labels.map((l, i) => `<span class="swatch sq ${['w', 'd', 'b'][i]}"></span> ${esc(l)}`).join(' ');
    $('games-overview').classList.toggle('persp', persp);
  }

  function renderBars() {
    const el = $('opening-bars');
    el.innerHTML = '';
    const groups = st.summary.groups;
    const max = Math.max(1, ...groups.map((g) => g.games));
    for (const g of groups) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'obar';
      row.setAttribute('role', 'row');
      const name = g.name || 'not in the opening book';
      const label = st.by === 'eco' ? `${g.eco || '–'} <span class="eco">${esc(shorten(name, 34))}</span>` : `${esc(shorten(name, 44))}${g.eco ? ` <span class="eco">${esc(g.eco)}</span>` : ''}`;
      // The split is the point of each row, so it gets the full width; the
      // share of games is a separate mark (lengths differ a hundredfold in a
      // long tail, which would squash every other row's split to a sliver).
      row.innerHTML = `<span class="obar-name" title="${esc(name)}">${label}</span>
        <span class="obar-track">${segments(g)}</span>
        <span class="obar-n"><span class="share" title="${pct(g.games / st.summary.total.games)} of the games"><i style="width:${Math.max(2, (100 * g.games) / max)}%"></i></span>${fmt(g.games)}</span><span class="obar-score">${pct(score(g))}</span>`;
      row.onclick = () => selectGroup(g);
      const tip = (e) => hooks.showTooltip(tooltipHtml(name, g), e);
      row.addEventListener('mouseenter', tip);
      row.addEventListener('mousemove', tip);
      row.addEventListener('focus', (e) => hooks.showTooltip(tooltipHtml(name, g), { clientX: e.target.getBoundingClientRect().left, clientY: e.target.getBoundingClientRect().bottom }));
      row.addEventListener('mouseleave', hooks.hideTooltip);
      row.addEventListener('blur', hooks.hideTooltip);
      el.appendChild(row);
    }
    if (!groups.length) el.innerHTML = '<div class="hint">No games match this filter.</div>';
  }

  /** Stacked result segments, in a fixed order, with a 2px surface gap between them. */
  function segments(s) {
    const parts = perspective() ? [['w', s.wins], ['d', s.draws], ['b', s.losses]] : [['w', s.white], ['d', s.draws], ['b', s.black]];
    const known = parts.reduce((n, [, v]) => n + v, 0);
    const unknown = s.games - known;
    if (unknown > 0) parts.push(['u', unknown]);
    return parts.filter(([, v]) => v > 0).map(([k, v]) => `<i class="seg ${k}" style="flex:${v}"></i>`).join('');
  }

  function tooltipHtml(name, s) {
    const persp = perspective();
    const rows = persp
      ? [['wins', s.wins], ['draws', s.draws], ['losses', s.losses]]
      : [['White wins', s.white], ['draws', s.draws], ['Black wins', s.black]];
    const unknown = s.games - rows.reduce((n, [, v]) => n + v, 0);
    if (unknown > 0) rows.push(['unfinished', unknown]);
    return `<div class="t">${esc(name)}</div><div>${fmt(s.games)} game${s.games === 1 ? '' : 's'} · score ${pct(score(s))}</div>
      <div class="d">${rows.map(([l, v]) => `${esc(l)} ${pct(v / s.games)} (${fmt(v)})`).join(' · ')}</div>`;
  }

  function renderEco() {
    const codes = {};
    let max = 1;
    for (const g of st.eco.groups) {
      if (!g.eco) continue;
      codes[g.eco] = g;
      max = Math.max(max, g.games);
    }
    renderEcoMap($('games-eco-map'), codes, {
      selected: st.list.mode === 'eco' ? st.list.key : null,
      hasData: (c) => Boolean(c && c.games),
      colorOf: (c) => frequencyColor(c.games / max),
      onSelect: (code) => selectGroup({ ...codes[code], by: 'eco' }),
      onHover: (e, code, c) => {
        if (!code) return hooks.hideTooltip();
        hooks.showTooltip(tooltipHtml(`${code} · ${c.name || ''}`, c), e);
      },
    });
  }

  /** A bar or ECO cell was clicked: show the line on the board and list the group's games. */
  function selectGroup(g) {
    const by = g.by || st.by;
    const key = by === 'eco' ? g.eco : by === 'family' ? g.family : g.name;
    const params = {};
    params[by === 'opening' ? 'name' : by] = key ?? '';
    const name = by === 'eco' ? `${g.eco || 'no ECO'}` : (g.name || 'not in the opening book');
    setListMode({ mode: by, key, params, title: `Games: ${name}` });
    const line = linePath(g, by);
    if (line.length) hooks.onSelectLine(line);
  }

  /** Book line to put on the board for a group: the family's own opening if there is one, else the shortest line in the group. */
  function linePath(g, by) {
    if (by === 'family' && g.name) {
      const op = hooks.openings().find((o) => o.name === g.name);
      if (op) return op.san;
    }
    if (by === 'eco' && g.eco) {
      const op = hooks.openings().find((o) => o.eco === g.eco);
      if (op && g.path?.length && op.san.length < g.path.length) return op.san;
    }
    return g.path || [];
  }

  // ---- game list ------------------------------------------------------------

  function setListMode(m) {
    st.list = { ...st.list, ...m, items: [], total: 0 };
    renderEco();
    refreshList();
  }

  /** Called by the controller whenever the board moves. */
  function setPosition(epd) {
    st.list.epd = epd;
    if (st.visible && st.list.mode === 'position' && st.total.games) refreshList();
  }

  async function refreshList(more = false) {
    if (!st.visible || !st.total.games) return;
    const token = ++st.listToken;
    const params = { ...filter(), limit: PAGE, offset: more ? st.list.items.length : 0 };
    if (st.list.mode === 'position') params.epd = st.list.epd || hooks.currentEpd();
    else Object.assign(params, st.list.params);
    try {
      const r = await api.gamesList(params);
      if (token !== st.listToken) return;
      st.list.items = more ? st.list.items.concat(r.games) : r.games;
      st.list.total = r.total;
      renderList();
    } catch (err) {
      console.error(err);
    }
  }

  function renderList() {
    const el = $('game-list');
    el.innerHTML = '';
    const persp = perspective();
    const me = player().toLowerCase();
    for (const g of st.list.items) {
      const li = document.createElement('li');
      const mine = persp ? (g.white?.toLowerCase() === me ? 'white' : g.black?.toLowerCase() === me ? 'black' : null) : null;
      const outcome = mine ? (g.result === '1/2-1/2' ? 'd' : g.result === '*' ? 'u' : (g.result === '1-0') === (mine === 'white') ? 'w' : 'b') : '';
      const elo = (e) => (e ? ` <span class="elo">${e}</span>` : '');
      const site = g.site && /^https?:\/\//.test(g.site) ? ` <a class="ext" href="${esc(g.site)}" target="_blank" rel="noopener" title="Open the game at its source">↗</a>` : '';
      li.innerHTML = `<span class="players"><span class="${mine === 'white' ? 'me' : ''}">${esc(g.white || '?')}</span>${elo(g.whiteElo)} – <span class="${mine === 'black' ? 'me' : ''}">${esc(g.black || '?')}</span>${elo(g.blackElo)}</span>
        <span class="res ${outcome}">${esc(g.result === '1/2-1/2' ? '½-½' : g.result)}</span>
        <span class="meta">${esc([g.date, g.event, g.book?.name || (g.opening ?? '')].filter(Boolean).join(' · '))}${g.atPly !== undefined ? ` · reached at move ${Math.ceil(g.atPly / 2) || 0}` : ''}${site}</span>`;
      li.onclick = (e) => {
        if (e.target.closest('a')) return;
        hooks.onLoadGame(g.id, g.atPly);
      };
      el.appendChild(li);
    }
    $('games-list-title').textContent = st.list.title;
    $('games-list-count').textContent = st.list.total ? `${fmt(st.list.total)}` : 'none';
    $('games-more').hidden = st.list.items.length >= st.list.total;
    $('games-list-back').hidden = st.list.mode === 'position';
    const beyond = st.list.mode === 'position' && st.total.plies && (st.list.epd || '').length && hooks.currentCursor() > st.total.plies;
    $('games-list-hint').textContent = beyond ? `Positions are indexed up to move ${Math.ceil(st.total.plies / 2)}; this one is deeper.` : '';
  }

  // ---- wiring -----------------------------------------------------------------

  function bind() {
    $('import-file').onchange = (e) => {
      st.file = e.target.files[0] || null;
      $('import-file-name').textContent = st.file ? `${st.file.name} (${(st.file.size / 1e6).toFixed(1)} MB)` : 'no file chosen';
      $('import-start').disabled = !st.file;
    };
    $('import-form').onsubmit = startImport;
    $('import-url-form').onsubmit = startUrlImport;
    $('import-url').oninput = (e) => { $('import-url-start').disabled = !e.target.value.trim() || Boolean(st.fetching); };
    $('games-import').onchange = (e) => selectImport(e.target.value ? Number(e.target.value) : null);
    $('games-player').onchange = (e) => {
      st.player = e.target.value;
      prefs.set('gamesPlayer', st.player);
      filterChanged();
    };
    $('games-color-seg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (!b) return;
      st.color = b.dataset.color;
      prefs.set('gamesColor', st.color);
      filterChanged();
    });
    $('games-by-seg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-by]');
      if (!b) return;
      st.by = b.dataset.by;
      prefs.set('gamesBy', st.by);
      renderFilter();
      refreshOverview();
    });
    $('games-more').onclick = () => refreshList(true);
    $('games-list-back').onclick = () => setListMode({ mode: 'position', key: null, params: {}, title: 'Games at this position' });
    // Drag a PGN file anywhere onto the panel
    const panel = $('panel-games');
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('drop'); });
    panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('drop');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!st.canImport) { hooks.flash('Sign in with Google to import games'); return; }
      st.file = file;
      $('import-file-name').textContent = `${file.name} (${(file.size / 1e6).toFixed(1)} MB)`;
      $('import-start').disabled = false;
    });
  }

  bind();

  return {
    filter,
    /** Total imported games (0 = nothing to show anywhere). */
    get total() { return st.total; },
    perspective,
    refreshImports,
    setPosition,
    show() {
      st.visible = true;
      refreshImports().then(() => { renderFilter(); refreshOverview(); });
    },
    hide() {
      st.visible = false;
      hooks.hideTooltip();
    },
  };
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function pct(x) {
  return x === null || x === undefined || Number.isNaN(x) ? '–' : `${Math.round(100 * x)}%`;
}

function shorten(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
