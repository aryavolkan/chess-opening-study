// Dedicated analysis machines: every user can start machines that work
// through that user's queue of positions to analyse in depth. Machines are
// Fly Machines created from the app's own image (on Fly, with a token) or
// local worker processes (anywhere else); see machine-backends.js. Results
// go into the shared analysis store, so everyone benefits from the depth.
//
// Limits (environment): MACHINES_PER_USER, MACHINES_TOTAL, MACHINE_CPUS,
// MACHINE_MEMORY_MB, MACHINE_MAX_MINUTES, MACHINE_IDLE_SECONDS,
// MACHINE_MAX_DEPTH, MACHINE_STOCKFISH_FLAVOR, MACHINE_USERS (all | admins).

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fenFromEpd } from '../shared/fen.js';
import { LOCAL_USER_ID } from './db.js';
import { backendFromEnv, workerApiUrlFromEnv } from './machine-backends.js';

export function machinesConfigFromEnv(env = process.env, port = 3000) {
  const int = (v, d, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
  return {
    perUser: int(env.MACHINES_PER_USER, 2, 0, 50),
    total: int(env.MACHINES_TOTAL, 8, 0, 500),
    cpus: int(env.MACHINE_CPUS, 2, 1, 16),
    memoryMb: int(env.MACHINE_MEMORY_MB, 1024, 256, 65536),
    maxMinutes: int(env.MACHINE_MAX_MINUTES, 120, 1, 1440),
    idleSeconds: int(env.MACHINE_IDLE_SECONDS, 180, 10, 86400),
    maxDepth: int(env.MACHINE_MAX_DEPTH, 45, 10, 99),
    flavor: env.MACHINE_STOCKFISH_FLAVOR || env.STOCKFISH_FLAVOR || 'lite-single',
    users: env.MACHINE_USERS === 'admins' ? 'admins' : 'all',
    workerApiUrl: workerApiUrlFromEnv(env, port),
  };
}

export class Machines extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./db.js').Store} o.store
   * @param {object|null} [o.backend]   from backendFromEnv(); null = feature off
   * @param {object} [o.config]         from machinesConfigFromEnv()
   */
  constructor({ store, backend = backendFromEnv(), config = machinesConfigFromEnv(), now = Date.now }) {
    super();
    this.store = store;
    this.backend = backend;
    this.config = config;
    this.now = now;
    this.live = new Map(); // request id -> latest progress snapshot
    this.housekeeper = null;
    if (backend?.on) {
      backend.on('exit', ({ remoteId, code }) => {
        const m = this.store.activeMachines().find((x) => x.remoteId === remoteId);
        if (m) this.markStopped(m, code ? `worker exited with code ${code}` : null);
      });
    }
    // Machines from a previous run of the app are gone (local) or unknown (Fly): check them
    for (const m of this.store.activeMachines()) {
      if (!backend || backend.kind !== m.backend) this.markStopped(m, 'the app restarted');
    }
  }

  get enabled() {
    return Boolean(this.backend);
  }

  startHousekeeping(intervalMs = 30000) {
    this.housekeeper = setInterval(() => this.housekeeping().catch((err) => this.emit('error', err)), intervalMs);
    this.housekeeper.unref?.();
  }

  /** May this user start machines? */
  allowed(user) {
    if (!this.enabled || !user) return false;
    if (user.local) return true;
    return this.config.users === 'all' || Boolean(user.admin);
  }

  status(user, scope) {
    const machines = this.store.listMachines(scope).map((m) => this.publicMachine(m));
    const requests = this.store.listRequests(scope).map((r) => this.publicRequest(r));
    const active = this.store.activeMachines();
    return {
      enabled: this.enabled,
      backend: this.backend?.kind ?? null,
      allowed: this.allowed(user),
      limits: { perUser: this.config.perUser, total: this.config.total, cpus: this.config.cpus, maxMinutes: this.config.maxMinutes, idleSeconds: this.config.idleSeconds, maxDepth: this.config.maxDepth },
      machines,
      requests,
      activeTotal: active.length,
      activeOwn: user ? active.filter((m) => m.userId === user.id).length : 0,
    };
  }

  publicMachine(m) {
    const minutes = m.startedAt || m.createdAt ? Math.round((this.now() - Date.parse(m.startedAt || m.createdAt)) / 60000) : 0;
    return { id: m.id, name: m.name, backend: m.backend, cpus: m.cpus, state: m.state, positions: m.positions, error: m.error, createdAt: m.createdAt, lastSeen: m.lastSeen, minutes: ['stopped', 'failed'].includes(m.state) ? null : minutes };
  }

  publicRequest(r) {
    const live = this.live.get(r.id);
    return { ...r, live: live ? { depth: live.depth, score: live.lines[0]?.score ?? null, pv: live.lines[0]?.pv?.slice(0, 8) ?? [], at: live.at } : null };
  }

  /** Start a machine for the user. */
  async create(user, { cpus } = {}) {
    if (!this.enabled) throw httpError(503, 'dedicated machines are not available on this server');
    if (!this.allowed(user)) throw httpError(403, 'dedicated machines are reserved for the admins of this site');
    const active = this.store.activeMachines();
    if (active.filter((m) => m.userId === user.id).length >= this.config.perUser) throw httpError(409, `you already have ${this.config.perUser} machine${this.config.perUser === 1 ? '' : 's'} running`);
    if (active.length >= this.config.total) throw httpError(409, `the site's limit of ${this.config.total} machines is reached, try again later`);
    const n = Math.max(1, Math.min(this.config.cpus, Number(cpus) || this.config.cpus));
    const token = randomBytes(32).toString('base64url');
    const row = this.store.createMachine({
      userId: user.id,
      backend: this.backend.kind,
      name: `engine-u${user.id}-${randomBytes(3).toString('hex')}`,
      cpus: n,
      tokenHash: hashToken(token),
    });
    try {
      const { remoteId } = await this.backend.create({
        name: row.name,
        cpus: n,
        memoryMb: this.config.memoryMb,
        env: {
          WORKER_API_URL: this.config.workerApiUrl,
          WORKER_TOKEN: token,
          WORKER_CPUS: n,
          WORKER_IDLE_SECONDS: this.config.idleSeconds,
          WORKER_MAX_MINUTES: this.config.maxMinutes,
          STOCKFISH_FLAVOR: this.config.flavor,
          MACHINE_ID: row.id,
        },
      });
      const m = this.store.updateMachine(row.id, { remoteId });
      this.emit('machine', { event: 'created', machine: m });
      return this.publicMachine(m);
    } catch (err) {
      this.store.updateMachine(row.id, { state: 'failed', error: String(err.message || err), stoppedAt: new Date(this.now()).toISOString() });
      throw httpError(502, `could not start a machine: ${err.message}`);
    }
  }

  /** Stop a machine (its owner, or an admin). */
  async stop(user, id) {
    const m = this.store.getMachine(id);
    if (!m) throw httpError(404, 'no such machine');
    if (m.userId !== user.id && !user.admin && !user.local) throw httpError(403, 'not your machine');
    if (['stopped', 'failed'].includes(m.state)) return this.publicMachine(m);
    this.store.updateMachine(id, { state: 'stopping' });
    try {
      if (m.remoteId) await this.backend?.stop(m.remoteId);
    } catch (err) {
      this.emit('error', err);
    }
    return this.publicMachine(this.markStopped(this.store.getMachine(id), null));
  }

  markStopped(m, error) {
    if (['stopped', 'failed'].includes(m.state)) return m;
    const requeued = this.store.requeueRequestsOf(m.id);
    const row = this.store.updateMachine(m.id, { state: error ? 'failed' : 'stopped', error: error ?? null, stoppedAt: new Date(this.now()).toISOString() });
    this.emit('machine', { event: 'stopped', machine: row, requeued });
    return row;
  }

  /** Queue a position for the user's machines. Returns the request, or the stored analysis if it is already deep enough. */
  request(user, { epd, depth, multipv, label }) {
    if (!this.enabled) throw httpError(503, 'dedicated machines are not available on this server');
    if (typeof epd !== 'string' || epd.split(' ').length !== 4) throw httpError(400, 'epd required');
    const d = Number(depth);
    if (!Number.isInteger(d) || d < 10 || d > this.config.maxDepth) throw httpError(400, `depth must be an integer between 10 and ${this.config.maxDepth}`);
    const pv = Math.max(1, Math.min(5, Number(multipv) || 3));
    const stored = this.store.getAnalysis(epd);
    if (stored && stored.depth >= d && stored.multipv >= pv) return { created: false, done: true, analysis: stored, request: null };
    const r = this.store.createRequest({ userId: user.id, epd, depth: d, multipv: pv, label: typeof label === 'string' ? label.slice(0, 300) : null });
    return { created: r.created, done: false, request: this.publicRequest(r.request), machines: this.store.activeMachines().filter((m) => m.userId === user.id).length };
  }

  cancel(user, id) {
    const r = this.store.getRequest(id);
    if (!r || (r.userId !== user.id && !user.admin && !user.local)) throw httpError(404, 'no such request');
    if (r.status === 'queued' || r.status === 'running') {
      this.store.updateRequest(id, { status: 'cancelled', finishedAt: new Date(this.now()).toISOString() });
      this.live.delete(id);
    }
    return { cancelled: true };
  }

  // ---- the worker side -------------------------------------------------

  /** The machine a worker token belongs to, or null. */
  machineForToken(token) {
    if (!token) return null;
    const m = this.store.machineByTokenHash(hashToken(token));
    if (!m || ['stopped', 'failed'].includes(m.state)) return null;
    return m;
  }

  workerNext(machine, { busy = 0 } = {}) {
    const now = new Date(this.now()).toISOString();
    if (machine.state === 'stopping' || machine.state === 'stopped' || machine.state === 'failed') return { stop: true, reason: 'stopped by its owner' };
    if (this.now() - Date.parse(machine.createdAt) > (this.config.maxMinutes + 5) * 60000) {
      this.markStopped(machine, null);
      return { stop: true, reason: 'lifetime over' };
    }
    const request = this.store.claimRequest(machine.userId, machine.id);
    this.store.updateMachine(machine.id, { state: request || busy ? 'running' : 'idle', lastSeen: now, startedAt: machine.startedAt || now });
    if (!request) return { request: null };
    this.store.updateRequest(request.id, { status: 'running' });
    return { request: { id: request.id, fen: fenFromEpd(request.epd), depth: request.depth, multipv: request.multipv } };
  }

  workerProgress(machine, { id, depth, lines, nodes }) {
    const r = this.store.getRequest(Number(id));
    if (!r || r.machineId !== machine.id || r.status !== 'running') return { ok: false };
    this.store.updateMachine(machine.id, { lastSeen: new Date(this.now()).toISOString() });
    const clean = cleanLines(lines);
    if (Number.isInteger(depth) && depth > 0 && clean.length) {
      this.live.set(r.id, { depth, lines: clean, at: new Date(this.now()).toISOString() });
      this.store.updateRequest(r.id, { progress: depth });
      // Keep the store up to date as the search deepens, so nothing is lost if the machine dies
      this.store.saveAnalysis({ epd: r.epd, depth, lines: clean, nodes: numberOrNull(nodes), engine: `${machine.name}`, source: 'machine', userId: machine.userId || null });
    }
    return { ok: true };
  }

  workerResult(machine, { id, depth, lines, nodes, engine, error }) {
    const r = this.store.getRequest(Number(id));
    if (!r || r.machineId !== machine.id) return { ok: false };
    const finishedAt = new Date(this.now()).toISOString();
    this.store.updateMachine(machine.id, { lastSeen: finishedAt, positionsDone: 1 });
    this.live.delete(r.id);
    if (r.status !== 'running') return { ok: true };
    const clean = cleanLines(lines);
    if (error || !clean.length) {
      this.store.updateRequest(r.id, { status: error ? 'failed' : 'done', error: error ? String(error).slice(0, 300) : null, finishedAt, progress: depth || r.progress });
      this.emit('request', { event: error ? 'failed' : 'done', request: this.store.getRequest(r.id) });
      return { ok: true };
    }
    const saved = this.store.saveAnalysis({ epd: r.epd, depth, lines: clean, nodes: numberOrNull(nodes), engine: engine ? String(engine).slice(0, 100) : machine.name, source: 'machine', userId: machine.userId || null });
    this.store.updateRequest(r.id, { status: 'done', progress: depth, finishedAt });
    this.emit('request', { event: 'done', request: this.store.getRequest(r.id), stored: saved.stored });
    return { ok: true, stored: saved.stored };
  }

  workerBye(machine) {
    this.markStopped(machine, null);
    return { ok: true };
  }

  /** Machines that fell silent are checked with the backend and written off; lifetimes are enforced. */
  async housekeeping() {
    for (const m of this.store.activeMachines()) {
      const age = this.now() - Date.parse(m.createdAt);
      const silence = this.now() - Date.parse(m.lastSeen || m.createdAt);
      if (age > (this.config.maxMinutes + 10) * 60000 || silence > 5 * 60000) {
        let state = 'unknown';
        try {
          state = m.remoteId ? await this.backend.status(m.remoteId) : 'stopped';
        } catch (err) {
          this.emit('error', err);
          continue;
        }
        if (state === 'stopped' || age > (this.config.maxMinutes + 10) * 60000) {
          if (state !== 'stopped' && m.remoteId) await this.backend.stop(m.remoteId).catch((err) => this.emit('error', err));
          this.markStopped(m, state === 'stopped' && silence > 5 * 60000 ? 'the machine went away' : null);
        }
      }
    }
    // Requests nobody is working on and whose owner has no machine stay queued; that is fine.
  }

  async shutdown() {
    clearInterval(this.housekeeper);
    await this.backend?.shutdown?.();
  }
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function cleanLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((l) => l && l.score && (l.score.type === 'cp' || l.score.type === 'mate') && Number.isFinite(Number(l.score.value)) && Array.isArray(l.pv) && l.pv.length)
    .slice(0, 10)
    .map((l, i) => ({ multipv: i + 1, score: { type: l.score.type, value: Math.trunc(Number(l.score.value)) }, pv: l.pv.slice(0, 40).map(String) }));
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
