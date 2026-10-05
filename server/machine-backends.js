// Where dedicated analysis machines come from. Both backends run the same
// worker (remote-worker.js), which talks back to the app over HTTP:
//   FlyBackend    one Fly Machine per request, created through the Machines
//                 API from the app's own image, destroyed when the worker exits
//   LocalBackend  one child process per request on the app's own host (a
//                 self-hosted instance, or development)

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
export const WORKER_SCRIPT = join(here, 'remote-worker.js');
const WORKER_CMD = ['node', '--disable-warning=ExperimentalWarning', 'server/remote-worker.js'];

/** Fly Machines API client for one app. */
export class FlyBackend extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.token    a deploy token for the app (fly tokens create deploy)
   * @param {string} o.app      the Fly app name
   * @param {string} o.image    image to run (FLY_IMAGE_REF of the app itself)
   * @param {string} [o.region] region for new machines (FLY_REGION of the app)
   * @param {string} [o.apiUrl]
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor({ token, app, image, region = null, apiUrl = 'https://api.machines.dev', fetchImpl = fetch }) {
    super();
    if (!token || !app || !image) throw new Error('FlyBackend needs a token, an app name and an image');
    this.kind = 'fly';
    this.token = token;
    this.app = app;
    this.image = image;
    this.region = region;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async call(method, path, body) {
    const r = await this.fetchImpl(`${this.apiUrl}/v1/apps/${this.app}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!r.ok) throw new Error(`Fly Machines API ${method} ${path}: HTTP ${r.status}${data?.error ? ` ${data.error}` : ''}`);
    return data;
  }

  /** Create and start a machine running the worker; resolves with its id. */
  async create({ name, cpus, memoryMb, env }) {
    const m = await this.call('POST', '/machines', {
      name,
      region: this.region || undefined,
      config: {
        image: this.image,
        env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
        guest: { cpu_kind: 'shared', cpus, memory_mb: memoryMb },
        auto_destroy: true,
        restart: { policy: 'no' },
        metadata: { fly_process_group: 'engine' },
        init: { cmd: WORKER_CMD },
      },
    });
    return { remoteId: m.id, state: m.state };
  }

  async status(remoteId) {
    try {
      const m = await this.call('GET', `/machines/${remoteId}`);
      return { created: 'starting', starting: 'starting', started: 'running', stopping: 'stopping', stopped: 'stopped', destroying: 'stopped', destroyed: 'stopped' }[m.state] || 'unknown';
    } catch (err) {
      if (/HTTP 404/.test(err.message)) return 'stopped';
      throw err;
    }
  }

  /** Stop and remove a machine (idempotent). */
  async stop(remoteId) {
    try {
      await this.call('POST', `/machines/${remoteId}/stop`, { signal: 'SIGTERM', timeout: '20s' });
    } catch (err) {
      if (!/HTTP (404|412)/.test(err.message)) throw err;
    }
    try {
      await this.call('DELETE', `/machines/${remoteId}?force=true`);
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) throw err;
    }
  }

  async shutdown() {}
}

/** Worker processes on this host. */
export class LocalBackend extends EventEmitter {
  constructor({ script = WORKER_SCRIPT, spawn = null } = {}) {
    super();
    this.kind = 'local';
    this.script = script;
    this.spawn = spawn || ((s, env) => fork(s, [], { execArgv: ['--disable-warning=ExperimentalWarning'], env: { ...process.env, ...env }, stdio: 'inherit' }));
    this.children = new Map();
    this.next = 1;
  }

  async create({ env }) {
    const remoteId = `local-${this.next++}`;
    const child = this.spawn(this.script, Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])));
    this.children.set(remoteId, child);
    child.on('exit', (code) => {
      this.children.delete(remoteId);
      this.emit('exit', { remoteId, code });
    });
    child.on('error', () => {});
    return { remoteId, state: 'starting' };
  }

  async status(remoteId) {
    return this.children.has(remoteId) ? 'running' : 'stopped';
  }

  async stop(remoteId) {
    const child = this.children.get(remoteId);
    if (!child) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10000);
    timer.unref?.();
  }

  async shutdown() {
    for (const id of [...this.children.keys()]) await this.stop(id);
  }
}

/** Pick the backend from the environment: Fly when the app runs there with a token, else local processes, or none. */
export function backendFromEnv(env = process.env, port = 3000) {
  if (env.MACHINES === 'off') return null;
  if (env.FLY_API_TOKEN && env.FLY_APP_NAME) {
    if (!env.FLY_IMAGE_REF) throw new Error('FLY_IMAGE_REF is not set; dedicated machines need the app image (Fly sets it on deployed machines)');
    return new FlyBackend({ token: env.FLY_API_TOKEN, app: env.FLY_APP_NAME, image: env.FLY_IMAGE_REF, region: env.FLY_REGION || null, apiUrl: env.FLY_MACHINES_API || undefined });
  }
  if (env.FLY_APP_NAME && !env.FLY_API_TOKEN) return null; // on Fly without a token: no machines rather than local processes on the app machine
  return new LocalBackend();
}

/** Where workers reach the app: the private network on Fly, localhost otherwise. */
export function workerApiUrlFromEnv(env = process.env, port = 3000) {
  if (env.WORKER_API_URL) return env.WORKER_API_URL;
  if (env.FLY_APP_NAME) return `http://app.process.${env.FLY_APP_NAME}.internal:${port}`;
  return `http://127.0.0.1:${port}`;
}
