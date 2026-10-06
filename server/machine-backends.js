// Where dedicated analysis machines come from: one worker process
// (remote-worker.js) per machine on the app's own host. The worker talks
// back to the app over HTTP with the token it was started with, so another
// backend only has to start the same script somewhere that can reach the app.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
export const WORKER_SCRIPT = join(here, 'remote-worker.js');

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

/** Pick the backend from the environment: worker processes on this host, or none with MACHINES=off. */
export function backendFromEnv(env = process.env) {
  if (env.MACHINES === 'off') return null;
  return new LocalBackend();
}

/** Where workers reach the app: WORKER_API_URL, or this host's port. */
export function workerApiUrlFromEnv(env = process.env, port = 3000) {
  return env.WORKER_API_URL || `http://127.0.0.1:${port}`;
}
