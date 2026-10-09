// Opening explorer panel (Study tab): queue exploration jobs, drive the
// engine workers and show the scored openings. The server does the work
// (server/explorer.js); this module renders its status and results.

const PAGE = 60;
const SORTS = {
  fit: (a, b) => b.fit - a.fit,
  decisions: (a, b) => a.decisions - b.decisions || b.fit - a.fit,
  eval: (a, b) => b.eval - a.eval,
  worst: (a, b) => b.worst - a.worst,
  forgiveness: (a, b) => nullsLast(a.forgiveness, b.forgiveness, 1) || b.fit - a.fit,
  reach: (a, b) => nullsLast(a.reach, b.reach, -1) || b.fit - a.fit,
  games: (a, b) => (b.games?.games ?? -1) - (a.games?.games ?? -1),
  theory: (a, b) => a.theory - b.theory || b.fit - a.fit,
};

/**
 * @param {object} o.hooks
 * @param {(sans: string[]) => void} o.hooks.onSelectLine
 * @param {() => string[]} o.hooks.currentLine   moves on the board up to the cursor
 * @param {(msg) => void} o.hooks.flash
 * @param {() => void} o.hooks.refreshStudy
 */
export function createExplorerPanel({ api, prefs, hooks }) {
  const $ = (id) => document.getElementById(id);
  const st = {
    status: null,
    color: prefs.get('exploreColor', 'white') === 'black' ? 'black' : 'white',
    scope: [],
    results: [],
    shown: PAGE,
    jobFilter: '',
    sort: prefs.get('exploreSort', 'fit'),
    soundOnly: prefs.get('exploreSound', true) !== false,
    visible: false,
    timer: null,
    resultsStamp: '',
    admin: true,
  };

  async function refresh() {
    try {
      st.status = await api.exploreStatus();
      renderStatus();
      const stamp = st.status.jobs.map((j) => `${j.id}:${j.done}`).join(',');
      if (stamp !== st.resultsStamp) {
        st.resultsStamp = stamp;
        await loadResults();
      }
    } catch (err) {
      $('explore-state').textContent = 'unavailable';
      $('explore-progress').textContent = err.message;
    }
    schedule();
  }

  function schedule() {
    clearTimeout(st.timer);
    if (st.visible) st.timer = setTimeout(refresh, st.status?.running ? 2500 : 10000);
  }

  function renderAccess() {
    $('explore-form').classList.toggle('locked', !st.admin);
    $('explore-form').querySelectorAll('input, button').forEach((el) => { el.disabled = !st.admin; });
    $('explore-admin-note').hidden = st.admin;
    $('explore-jobs').querySelectorAll('[data-remove]').forEach((b) => { b.hidden = !st.admin; });
  }

  function renderStatus() {
    const s = st.status;
    const badge = $('explore-state');
    badge.textContent = s.running ? `running · ${s.pool?.workers ?? s.workers} worker${(s.pool?.workers ?? s.workers) === 1 ? '' : 's'}` : s.lastError ? 'error' : 'stopped';
    badge.className = 'badge' + (s.running ? ' good' : s.lastError ? ' warn' : '');
    if (document.activeElement !== $('explore-workers')) $('explore-workers').value = s.workers;
    $('explore-start').textContent = s.running ? 'Apply workers' : 'Start workers';
    $('explore-stop').disabled = !s.running;
    const c = s.current;
    const parts = [];
    if (c) parts.push(`working on <b>${esc(c.eco || '')} ${esc(c.candidate)}</b> (${c.done} of ${c.total} in this job)`);
    if (s.running && s.pool) parts.push(`${s.pool.busy} of ${s.pool.workers} workers busy · ${s.pool.queued} positions queued · ${s.analysed} analysed this run`);
    if (s.lastError) parts.push(`<span style="color:var(--bad)">${esc(s.lastError)}</span>`);
    if (!s.jobs.length) parts.push('No jobs queued.');
    $('explore-progress').innerHTML = parts.join('<br>');

    const ul = $('explore-jobs');
    ul.innerHTML = '';
    for (const j of s.jobs) {
      const li = document.createElement('li');
      const pct = j.total ? Math.round((100 * j.done) / j.total) : 0;
      const p = j.params;
      li.innerHTML = `<span class="job-name" title="${esc(j.name)}">${esc(j.name)}</span>
        <span class="status ${j.status}">${j.status === 'running' && !s.running ? 'interrupted' : j.status}</span>
        <button class="link" data-remove="${j.id}" title="Remove this job and its results">✕</button>
        <span class="job-meta">${j.done} of ${j.total} openings · depth ${p.depth} · horizon ${p.horizon} · ${p.replies} replies${p.minGames ? ` · ≥ ${p.minGames} games` : ''}${j.error ? ` · <span style="color:var(--bad)">${esc(j.error)}</span>` : ''}
          <div class="progress"><div style="width:${pct}%"></div></div></span>`;
      li.querySelector('[data-remove]').onclick = async () => {
        if (!confirm(`Remove "${j.name}" and its results?`)) return;
        try {
          await api.exploreRemove(j.id);
          st.resultsStamp = null; // force the results to reload, even when no job is left
          await refresh();
        } catch (err) { hooks.flash(err.message); }
      };
      ul.appendChild(li);
    }
    renderAccess();
    const sel = $('explore-results-job');
    const have = new Set([...sel.options].map((o) => o.value));
    for (const j of s.jobs) {
      if (have.has(String(j.id))) continue;
      const opt = document.createElement('option');
      opt.value = String(j.id);
      opt.textContent = j.name;
      sel.appendChild(opt);
    }
    for (const o of [...sel.options]) if (o.value && !s.jobs.some((j) => String(j.id) === o.value)) o.remove();
    sel.value = st.jobFilter && s.jobs.some((j) => String(j.id) === st.jobFilter) ? st.jobFilter : '';
    st.jobFilter = sel.value;
  }

  async function loadResults() {
    try {
      const { results } = await api.exploreResults(st.jobFilter || undefined);
      st.results = results;
      renderResults();
    } catch (err) {
      console.error(err);
    }
  }

  function renderResults() {
    const table = $('explore-results');
    table.innerHTML = '';
    let rows = st.results.slice();
    if (st.soundOnly) rows = rows.filter((r) => r.eval >= -50);
    rows.sort(SORTS[st.sort] || SORTS.fit);
    $('explore-empty').hidden = rows.length > 0;
    $('explore-empty').textContent = st.results.length && !rows.length ? 'Every result is below −0.50 for this colour; untick "sound only" to see them.' : 'No results yet. Queue a search and start the workers.';
    if (!rows.length) { $('explore-more').hidden = true; return; }
    const hasGames = rows.some((r) => r.games);
    const head = document.createElement('thead');
    head.innerHTML = `<tr><th>opening</th><th data-sort="eval" title="Engine evaluation of the opening's position, from your point of view">eval</th><th data-sort="worst" title="Worst evaluation at the end of the lines you must know">worst</th>
      <th data-sort="decisions" title="Positions where you must know a move (within the horizon)">learn</th><th title="Distinct moves of yours in those positions">moves</th><th data-sort="forgiveness" title="Average loss, in pawns, of playing your second-best move: lower is more forgiving">2nd best</th>
      <th data-sort="theory" title="Named book lines below this opening">theory</th>${hasGames ? '<th data-sort="reach" title="How often opponents in your games played into this opening">reach</th><th data-sort="games">games</th>' : ''}<th data-sort="fit" title="0–100: sound and little to learn">fit</th><th></th></tr>`;
    head.querySelectorAll('th[data-sort]').forEach((th) => {
      const sorted = th.dataset.sort === st.sort;
      th.classList.toggle('sorted', sorted);
      if (sorted) th.textContent += ' ▾';
      th.onclick = () => {
        st.sort = th.dataset.sort;
        $('explore-sort').value = st.sort;
        prefs.set('exploreSort', st.sort);
        renderResults();
      };
    });
    table.appendChild(head);
    const body = document.createElement('tbody');
    for (const r of rows.slice(0, st.shown)) {
      const tr = document.createElement('tr');
      const pawns = (cp) => (Math.abs(cp) >= 9000 ? (cp > 0 ? '#' : '#−') : (cp > 0 ? '+' : cp < 0 ? '−' : '') + (Math.abs(cp) / 100).toFixed(2));
      tr.innerHTML = `<td class="name" title="${esc(r.name)} (${esc(r.path.join(' '))})"><span class="eco">${esc(r.eco || '')}</span>${esc(r.name)}</td>
        <td class="${r.eval < -50 ? 'bad' : r.eval >= 30 ? 'good' : ''}">${pawns(r.eval)}</td><td class="${r.worst < -100 ? 'bad' : ''}">${pawns(r.worst)}</td>
        <td>${r.decisions}</td><td>${r.moves}</td><td>${r.forgiveness === null || r.forgiveness === undefined ? '–' : (r.forgiveness / 100).toFixed(2)}</td><td>${r.theory}</td>
        ${hasGames ? `<td>${r.reach === null || r.reach === undefined ? '–' : `${Math.round(r.reach * 100)}%`}</td><td>${r.games ? r.games.games : '–'}</td>` : ''}
        <td><span class="fitbar"><i style="width:${r.fit}%"></i></span>${r.fit}</td>
        <td class="act"><button class="link" data-study title="Add this line to the study set as ${r.color}">+ study</button></td>`;
      tr.onclick = (e) => {
        if (e.target.dataset.study !== undefined) {
          e.stopPropagation();
          api.studyAdd({ san: r.path, color: r.color, name: r.name, eco: r.eco })
            .then((res) => { hooks.flash(res.created ? `Added to the study set as ${r.color}` : 'Already in the study set'); hooks.refreshStudy(); })
            .catch((err) => hooks.flash(err.message));
          return;
        }
        hooks.onSelectLine(r.path);
      };
      body.appendChild(tr);
    }
    table.appendChild(body);
    $('explore-more').hidden = rows.length <= st.shown;
  }

  function renderScope() {
    $('explore-scope').textContent = st.scope.length ? st.scope.join(' ') : 'whole book';
  }

  function bind() {
    $('explore-color-seg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (!b) return;
      st.color = b.dataset.color;
      prefs.set('exploreColor', st.color);
      $('explore-color-seg').querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.color === st.color)));
    });
    $('explore-color-seg').querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.color === st.color)));
    $('explore-scope-here').onclick = () => { st.scope = hooks.currentLine(); renderScope(); };
    $('explore-scope-all').onclick = () => { st.scope = []; renderScope(); };
    $('explore-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { status } = await api.exploreAdd({
          color: st.color,
          scope: st.scope,
          depth: Number($('explore-depth').value),
          horizon: Number($('explore-horizon').value),
          replies: Number($('explore-replies').value),
          minGames: Number($('explore-min-games').value),
        });
        st.status = status;
        renderStatus();
        hooks.flash(`Queued: ${status.jobs[status.jobs.length - 1].total} openings to explore`);
        if (!status.running) {
          st.status = await api.exploreStart({ workers: Number($('explore-workers').value) });
          renderStatus();
        }
        schedule();
      } catch (err) { hooks.flash(err.message); }
    };
    $('explore-start').onclick = async () => {
      try {
        st.status = await api.exploreStart({ workers: Number($('explore-workers').value) });
        renderStatus();
        schedule();
      } catch (err) { hooks.flash(err.message); }
    };
    $('explore-stop').onclick = async () => {
      try {
        st.status = await api.exploreStop();
        renderStatus();
      } catch (err) { hooks.flash(err.message); }
    };
    $('explore-results-job').onchange = (e) => { st.jobFilter = e.target.value; st.shown = PAGE; loadResults(); };
    $('explore-sort').value = SORTS[st.sort] ? st.sort : 'fit';
    $('explore-sort').onchange = (e) => { st.sort = e.target.value; prefs.set('exploreSort', st.sort); renderResults(); };
    $('explore-sound').checked = st.soundOnly;
    $('explore-sound').onchange = (e) => { st.soundOnly = e.target.checked; prefs.set('exploreSound', st.soundOnly); renderResults(); };
    $('explore-more').onclick = () => { st.shown += PAGE; renderResults(); };
    renderScope();
  }

  bind();

  return {
    show() { st.visible = true; refresh(); },
    hide() { st.visible = false; clearTimeout(st.timer); },
    /** Whether the viewer may queue jobs and drive the workers. */
    setAccess({ admin }) { st.admin = admin; renderAccess(); },
  };
}

function nullsLast(a, b, dir) {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return dir * (a - b);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
