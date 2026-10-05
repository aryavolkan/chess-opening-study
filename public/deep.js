// Deep analysis on dedicated machines (Engine panel): queue the position on
// the board for the viewer's own machines, start and stop machines, follow
// the queue and the search depth as it grows. The server does the work
// (server/machines.js); results land in the shared analysis store.

import { sanToPgn, pgnToSan } from '/shared/book.js';
import { formatScore, scoreForWhite } from '/shared/uci.js';
import { sideToMove } from '/shared/fen.js';

export function createDeepPanel({ api, prefs, hooks }) {
  const $ = (id) => document.getElementById(id);
  const st = { status: null, timer: null, canEdit: true, signedOut: false, seen: new Map(), started: false };

  async function refresh() {
    try {
      st.status = await api.machinesStatus();
    } catch (err) {
      if (err.status !== 503) console.error(err);
      st.status = { enabled: false };
    }
    noticeFinished();
    render();
    schedule();
  }

  function schedule() {
    clearTimeout(st.timer);
    if (!st.status?.enabled) return;
    const busy = st.status.machines.some((m) => ['starting', 'running', 'idle', 'stopping'].includes(m.state)) || st.status.requests.some((r) => r.status === 'queued' || r.status === 'running');
    st.timer = setTimeout(refresh, busy ? 3000 : 20000);
  }

  /** Requests that just finished: refresh what the app shows for that position. */
  function noticeFinished() {
    for (const r of st.status?.requests || []) {
      const before = st.seen.get(r.id);
      st.seen.set(r.id, { status: r.status, progress: r.progress });
      if (before && (before.status !== r.status || before.progress !== r.progress) && (r.status === 'done' || r.status === 'running')) hooks.onAnalysisChanged(r.epd);
    }
  }

  function render() {
    const box = $('deep');
    const s = st.status;
    if (!s || !s.enabled) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const epd = hooks.currentEpd();
    const own = s.machines.filter((m) => !['stopped', 'failed'].includes(m.state));
    $('deep-badge').textContent = own.length ? `${own.length} machine${own.length === 1 ? '' : 's'} · ${s.activeTotal} on the site` : s.activeTotal ? `${s.activeTotal} on the site` : 'no machine running';
    const may = s.allowed && st.canEdit;
    $('deep-queue').disabled = !may;
    $('deep-start').disabled = !may || own.length >= s.limits.perUser || s.activeTotal >= s.limits.total;
    $('deep-depth').max = s.limits.maxDepth;
    const hint = $('deep-hint');
    if (st.signedOut) hint.textContent = 'Sign in to dedicate machines to the positions you want analysed in depth.';
    else if (!s.allowed) hint.textContent = 'On this site only admins can start machines.';
    else hint.textContent = `${s.backend === 'fly' ? 'Each machine is a Fly Machine with' : 'Each machine is a worker process with'} ${s.limits.cpus} engine${s.limits.cpus === 1 ? '' : 's'}, stops after ${Math.round(s.limits.idleSeconds / 60)} min without work or ${s.limits.maxMinutes} min in all; up to ${s.limits.perUser} per person.`;

    const reqs = $('deep-requests');
    reqs.innerHTML = '';
    const pending = s.requests.filter((r) => r.status === 'queued' || r.status === 'running');
    const recent = s.requests.filter((r) => r.status !== 'queued' && r.status !== 'running').slice(0, 4);
    for (const r of pending.concat(recent)) {
      const li = document.createElement('li');
      if (r.epd === epd) li.classList.add('current');
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = r.label || r.epd.split(' ')[0];
      what.title = `${r.label || ''}\n${r.epd}`;
      what.onclick = () => { if (r.label) hooks.onSelectLine(pgnToSan(r.label)); };
      const state = document.createElement('span');
      state.className = `state ${r.status}`;
      if (r.status === 'running' && r.live) {
        const score = r.live.score ? formatScore(scoreForWhite(r.live.score, sideToMove(r.epd))) : '';
        state.textContent = `depth ${r.live.depth}/${r.depth} ${score}`;
      } else if (r.status === 'running') state.textContent = `running · ${r.depth}`;
      else if (r.status === 'queued') state.textContent = `queued · depth ${r.depth}`;
      else if (r.status === 'done') state.textContent = `done · depth ${r.progress}`;
      else state.textContent = r.status;
      const act = document.createElement('button');
      act.className = 'link';
      if (r.status === 'queued' || r.status === 'running') {
        act.textContent = '✕';
        act.title = 'Cancel';
        act.onclick = async () => { try { await api.machinesCancel(r.id); refresh(); } catch (err) { hooks.flash(err.message); } };
      } else act.hidden = true;
      li.append(what, state, act);
      reqs.appendChild(li);
    }

    const ms = $('deep-machines');
    ms.innerHTML = '';
    for (const m of s.machines.slice(0, 6)) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = `${m.name} · ${m.cpus} cpu · ${m.positions} position${m.positions === 1 ? '' : 's'}${m.minutes !== null ? ` · ${m.minutes} min` : ''}`;
      what.title = m.error || '';
      const state = document.createElement('span');
      state.className = `state ${m.state}`;
      state.textContent = m.state;
      const act = document.createElement('button');
      act.className = 'link';
      if (['stopped', 'failed'].includes(m.state)) act.hidden = true;
      else {
        act.textContent = 'stop';
        act.onclick = async () => { try { await api.machinesStop(m.id); refresh(); } catch (err) { hooks.flash(err.message); } };
      }
      li.append(what, state, act);
      ms.appendChild(li);
    }
  }

  async function queue() {
    const epd = hooks.currentEpd();
    const depth = Number($('deep-depth').value);
    const multipv = Number($('deep-multipv').value);
    prefs.set('deepDepth', depth);
    try {
      const r = await api.machinesRequest({ epd, depth, multipv, label: sanToPgn(hooks.currentLine()) || 'starting position' });
      if (r.done) {
        hooks.flash(`Already analysed to depth ${r.analysis.depth}`);
        return;
      }
      if (r.machines === 0 && st.status?.allowed) {
        await api.machinesCreate({});
        hooks.flash(r.created ? 'Queued; a machine is starting' : 'Already queued; a machine is starting');
      } else hooks.flash(r.created ? 'Queued for your machines' : 'Already in your queue');
    } catch (err) {
      hooks.flash(err.message);
    }
    refresh();
  }

  async function start() {
    try {
      const { machine } = await api.machinesCreate({});
      hooks.flash(`${machine.name} is starting`);
    } catch (err) {
      hooks.flash(err.message);
    }
    refresh();
  }

  $('deep-queue').onclick = queue;
  $('deep-start').onclick = start;
  $('deep-depth').value = prefs.get('deepDepth', 36);

  return {
    render,
    refresh,
    start() { if (!st.started) { st.started = true; refresh(); } },
    setAccess({ canEdit, signedOut }) { st.canEdit = canEdit; st.signedOut = signedOut; render(); },
  };
}
