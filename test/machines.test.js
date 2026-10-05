import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { openDb, LOCAL_USER_ID } from '../server/db.js';
import { loadOpenings } from '../server/openings.js';
import { createApp } from '../server/app.js';
import { Machines, machinesConfigFromEnv } from '../server/machines.js';
import { FlyBackend, LocalBackend, backendFromEnv, workerApiUrlFromEnv } from '../server/machine-backends.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -';
const line = (cp, pv) => ({ score: { type: 'cp', value: cp }, pv });

/** A backend that records what it was asked and reports what the test tells it. */
function fakeBackend() {
  const b = new EventEmitter();
  b.kind = 'local';
  b.created = [];
  b.stopped = [];
  b.statuses = new Map();
  b.create = async ({ name, env, cpus }) => {
    const remoteId = `m${b.created.length + 1}`;
    b.created.push({ name, env, cpus, remoteId });
    b.statuses.set(remoteId, 'running');
    return { remoteId, state: 'starting' };
  };
  b.stop = async (id) => { b.stopped.push(id); b.statuses.set(id, 'stopped'); };
  b.status = async (id) => b.statuses.get(id) || 'stopped';
  b.shutdown = async () => {};
  return b;
}

test('machines: limits, queue, worker protocol, stop and housekeeping', async () => {
  const store = openDb();
  const backend = fakeBackend();
  let clock = Date.parse('2026-10-05T10:00:00Z');
  const config = { ...machinesConfigFromEnv({ MACHINES_PER_USER: '1', MACHINES_TOTAL: '2', MACHINE_CPUS: '2', MACHINE_MAX_MINUTES: '60', MACHINE_IDLE_SECONDS: '60', MACHINE_MAX_DEPTH: '40', WORKER_API_URL: 'http://app.test:3000' }) };
  const machines = new Machines({ store, backend, config, now: () => clock });
  const alice = { id: 1, admin: false };
  const bob = { id: 2, admin: false };
  const admin = { id: 3, admin: true };
  const scopeOf = (u) => ({ user: u.id, admin: u.admin, restrict: true });

  // requests are validated and deduplicated; already-deep positions are answered at once
  await assert.rejects(async () => machines.request(alice, { epd: 'bad', depth: 20 }), /epd/);
  await assert.rejects(async () => machines.request(alice, { epd: E4, depth: 99 }), /depth/);
  store.saveAnalysis({ epd: START, depth: 30, lines: [{ multipv: 1, ...line(20, ['e2e4']) }, { multipv: 2, ...line(10, ['d2d4']) }] });
  assert.equal(machines.request(alice, { epd: START, depth: 20, multipv: 2 }).done, true);
  const q1 = machines.request(alice, { epd: E4, depth: 20, multipv: 3, label: '1. e4' });
  assert.equal(q1.created, true);
  assert.equal(q1.done, false);
  assert.equal(q1.machines, 0, 'no machine yet');
  assert.equal(machines.request(alice, { epd: E4, depth: 25 }).created, false, 'the same position is already queued');
  const q2 = machines.request(alice, { epd: START, depth: 35, multipv: 3 });
  assert.equal(q2.created, true, 'deeper than what is stored');

  // machines are per user and capped
  const m1 = await machines.create(alice, { cpus: 9 });
  assert.equal(m1.state, 'starting');
  assert.equal(m1.cpus, 2, 'capped at the configured size');
  assert.equal(backend.created.length, 1);
  const env = backend.created[0].env;
  assert.equal(env.WORKER_API_URL, 'http://app.test:3000');
  assert.equal(env.WORKER_CPUS, 2);
  assert.equal(env.WORKER_IDLE_SECONDS, 60);
  assert.ok(env.WORKER_TOKEN.length > 20);
  await assert.rejects(machines.create(alice), /already have 1 machine/);
  const m2 = await machines.create(bob);
  await assert.rejects(machines.create(admin), /limit of 2 machines/);
  let s = machines.status(alice, scopeOf(alice));
  assert.equal(s.enabled, true);
  assert.equal(s.allowed, true);
  assert.equal(s.machines.length, 1, 'own machines only');
  assert.equal(s.activeTotal, 2);
  assert.equal(s.activeOwn, 1);
  assert.equal(s.requests.length, 2);
  assert.equal(machines.status(null, { user: null, admin: false, restrict: true }).allowed, false);
  assert.equal(machines.status(null, { user: null, admin: false, restrict: true }).machines.length, 0);

  // the worker side: token, claiming, progress, result
  assert.equal(machines.machineForToken('nope'), null);
  const aliceMachine = machines.machineForToken(env.WORKER_TOKEN);
  assert.equal(aliceMachine.id, m1.id);
  let next = machines.workerNext(aliceMachine, { busy: 0 });
  assert.equal(next.request.id, q1.request.id, 'oldest first');
  assert.equal(next.request.fen, E4 + ' 0 1');
  assert.equal(next.request.depth, 20);
  assert.equal(store.getMachine(m1.id).state, 'running');
  assert.equal(store.getRequest(q1.request.id).status, 'running');
  const bobMachine = machines.machineForToken(backend.created[1].env.WORKER_TOKEN);
  assert.equal(machines.workerNext(bobMachine).request, null, 'Bob has nothing queued');
  assert.equal(store.getMachine(m2.id).state, 'idle');
  // progress keeps the store current, but only when it is deeper
  assert.equal(machines.workerProgress(aliceMachine, { id: q1.request.id, depth: 12, lines: [line(30, ['c7c5', 'g1f3'])] }).ok, true);
  assert.equal(store.getAnalysis(E4).depth, 12);
  assert.equal(store.getAnalysis(E4).source, 'machine');
  assert.equal(machines.status(alice, scopeOf(alice)).requests.find((r) => r.id === q1.request.id).live.depth, 12);
  assert.equal(machines.workerProgress(bobMachine, { id: q1.request.id, depth: 13, lines: [line(0, ['a7a6'])] }).ok, false, 'not Bob\'s request');
  assert.equal(machines.workerResult(aliceMachine, { id: q1.request.id, depth: 20, lines: [line(25, ['c7c5']), line(20, ['e7e5'])], nodes: 5, engine: 'sf' }).stored, true);
  assert.equal(store.getRequest(q1.request.id).status, 'done');
  assert.equal(store.getAnalysis(E4).depth, 20);
  assert.equal(store.getAnalysis(E4).multipv, 2);
  assert.equal(store.getMachine(m1.id).positions, 1);
  next = machines.workerNext(aliceMachine);
  assert.equal(next.request.id, q2.request.id);
  assert.equal(machines.workerResult(aliceMachine, { id: q2.request.id, error: 'engine crashed' }).ok, true);
  assert.equal(store.getRequest(q2.request.id).status, 'failed');
  assert.equal(machines.workerNext(aliceMachine).request, null);
  assert.equal(store.getMachine(m1.id).state, 'idle');

  // cancelling, and a running request going back to the queue when its machine stops
  const q3 = machines.request(alice, { epd: E4, depth: 30 });
  assert.equal(q3.created, true, 'a finished request does not block a new one');
  assert.equal(machines.workerNext(aliceMachine).request.id, q3.request.id);
  await assert.rejects(async () => machines.cancel(bob, q3.request.id), /no such request/);
  const stopped = await machines.stop(alice, m1.id);
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(backend.stopped, ['m1']);
  assert.equal(store.getRequest(q3.request.id).status, 'queued', 'requeued');
  assert.equal(store.getRequest(q3.request.id).machineId, null);
  assert.equal(machines.machineForToken(env.WORKER_TOKEN), null, 'a stopped machine\'s token is dead');
  assert.equal(machines.workerNext(store.getMachine(m1.id)).stop, true, 'a stopped machine is told to stop');
  await assert.rejects(machines.stop(bob, m2.id).then(() => machines.stop(alice, m2.id)), /not your machine/);
  assert.equal(machines.cancel(alice, q3.request.id).cancelled, true);
  assert.equal(store.getRequest(q3.request.id).status, 'cancelled');

  // housekeeping writes off a machine the backend no longer knows, enforces lifetimes
  const m3 = await machines.create(alice);
  const m3Row = machines.machineForToken(backend.created[2].env.WORKER_TOKEN);
  machines.workerNext(m3Row);
  clock += 6 * 60000; // silent for six minutes
  backend.statuses.set(m3Row.remoteId, 'stopped');
  await machines.housekeeping();
  assert.equal(store.getMachine(m3.id).state, 'failed');
  assert.match(store.getMachine(m3.id).error, /went away/);
  const m4 = await machines.create(alice);
  const m4Row = machines.machineForToken(backend.created[3].env.WORKER_TOKEN);
  machines.workerNext(m4Row);
  clock += 75 * 60000; // past the lifetime
  assert.equal(machines.workerNext(machines.machineForToken(backend.created[3].env.WORKER_TOKEN)).stop, true);
  assert.equal(store.getMachine(m4.id).state, 'stopped');

  // a backend 'exit' event (local worker process ended) stops the machine
  const m5 = await machines.create(alice);
  backend.emit('exit', { remoteId: backend.created[4].remoteId, code: 0 });
  assert.equal(store.getMachine(m5.id).state, 'stopped');
  backend.emit('exit', { remoteId: 'unknown', code: 1 });

  // admins-only mode
  const strict = new Machines({ store: openDb(), backend: fakeBackend(), config: { ...config, users: 'admins' } });
  assert.equal(strict.allowed(alice), false);
  assert.equal(strict.allowed(admin), true);
  assert.equal(strict.allowed({ id: LOCAL_USER_ID, local: true, admin: true }), true);
  await assert.rejects(strict.create(alice), /reserved for the admins/);
  const off = new Machines({ store: openDb(), backend: null, config });
  assert.equal(off.enabled, false);
  await assert.rejects(off.create(alice), /not available/);
  store.close();
});

test('backends: Fly Machines API client against a fake API, and the local process backend', async () => {
  const calls = [];
  const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && req.url === '/v1/apps/study/machines') return json(200, { id: 'd8dd9ee2f', state: 'created' });
      if (req.method === 'GET' && req.url === '/v1/apps/study/machines/d8dd9ee2f') return json(200, { id: 'd8dd9ee2f', state: 'started' });
      if (req.method === 'GET' && req.url === '/v1/apps/study/machines/gone') return json(404, { error: 'machine not found' });
      if (req.method === 'POST' && req.url === '/v1/apps/study/machines/d8dd9ee2f/stop') return json(200, { ok: true });
      if (req.method === 'DELETE' && req.url === '/v1/apps/study/machines/d8dd9ee2f?force=true') return json(200, { ok: true });
      if (req.method === 'POST' && req.url === '/v1/apps/study/machines/gone/stop') return json(404, { error: 'machine not found' });
      if (req.method === 'DELETE' && req.url === '/v1/apps/study/machines/gone?force=true') return json(404, { error: 'machine not found' });
      json(500, { error: 'unexpected' });
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${fake.address().port}`;
  try {
    const fly = new FlyBackend({ token: 'tok', app: 'study', image: 'registry.fly.io/study:deployment-1', region: 'ams', apiUrl });
    const created = await fly.create({ name: 'engine-u1-abc', cpus: 2, memoryMb: 1024, env: { WORKER_TOKEN: 't', WORKER_CPUS: 2 } });
    assert.deepEqual(created, { remoteId: 'd8dd9ee2f', state: 'created' });
    const c = calls[0];
    assert.equal(c.auth, 'Bearer tok');
    assert.equal(c.body.name, 'engine-u1-abc');
    assert.equal(c.body.region, 'ams');
    assert.equal(c.body.config.image, 'registry.fly.io/study:deployment-1');
    assert.deepEqual(c.body.config.env, { WORKER_TOKEN: 't', WORKER_CPUS: '2' }, 'env values are strings');
    assert.deepEqual(c.body.config.guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 1024 });
    assert.equal(c.body.config.auto_destroy, true);
    assert.deepEqual(c.body.config.restart, { policy: 'no' });
    assert.deepEqual(c.body.config.init.cmd, ['node', '--disable-warning=ExperimentalWarning', 'server/remote-worker.js']);
    assert.equal(await fly.status('d8dd9ee2f'), 'running');
    assert.equal(await fly.status('gone'), 'stopped');
    await fly.stop('d8dd9ee2f');
    assert.deepEqual(calls.slice(-2).map((x) => `${x.method} ${x.url}`), ['POST /v1/apps/study/machines/d8dd9ee2f/stop', 'DELETE /v1/apps/study/machines/d8dd9ee2f?force=true']);
    await fly.stop('gone');
    await assert.rejects(fly.call('POST', '/machines/x/unknown'), /HTTP 500/);
    assert.throws(() => new FlyBackend({ token: 't', app: 'a' }), /image/);
  } finally {
    fake.close();
  }

  // the local backend forks a child and reports its exit
  const spawned = [];
  const local = new LocalBackend({ spawn: (script, env) => { const child = new EventEmitter(); child.kill = (sig) => { child.killed = sig; setImmediate(() => child.emit('exit', 0)); }; spawned.push({ script, env, child }); return child; } });
  const exits = [];
  local.on('exit', (e) => exits.push(e));
  const r = await local.create({ env: { WORKER_TOKEN: 'x', WORKER_CPUS: 1 } });
  assert.equal(r.remoteId, 'local-1');
  assert.match(spawned[0].script, /remote-worker\.js$/);
  assert.equal(spawned[0].env.WORKER_CPUS, '1');
  assert.equal(await local.status('local-1'), 'running');
  await local.stop('local-1');
  await new Promise((res) => setImmediate(res));
  assert.equal(spawned[0].child.killed, 'SIGTERM');
  assert.deepEqual(exits, [{ remoteId: 'local-1', code: 0 }]);
  assert.equal(await local.status('local-1'), 'stopped');

  // backend selection from the environment
  assert.equal(backendFromEnv({ MACHINES: 'off' }), null);
  assert.equal(backendFromEnv({}).kind, 'local');
  assert.equal(backendFromEnv({ FLY_APP_NAME: 'study' }), null, 'on Fly without a token: no local processes on the app machine');
  assert.equal(backendFromEnv({ FLY_APP_NAME: 'study', FLY_API_TOKEN: 't', FLY_IMAGE_REF: 'img' }).kind, 'fly');
  assert.throws(() => backendFromEnv({ FLY_APP_NAME: 'study', FLY_API_TOKEN: 't' }), /FLY_IMAGE_REF/);
  assert.equal(workerApiUrlFromEnv({ FLY_APP_NAME: 'study' }, 3000), 'http://app.process.study.internal:3000');
  assert.equal(workerApiUrlFromEnv({}, 3123), 'http://127.0.0.1:3123');
  assert.equal(workerApiUrlFromEnv({ WORKER_API_URL: 'https://x' }), 'https://x');
});

test('end to end: a local worker process analyses a queued position and reports back', { timeout: 120000 }, async () => {
  const store = openDb();
  const book = loadOpenings();
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const backend = new LocalBackend();
  const config = machinesConfigFromEnv({ MACHINE_CPUS: '1', MACHINE_IDLE_SECONDS: '10', MACHINE_MAX_MINUTES: '5', WORKER_API_URL: base, STOCKFISH_FLAVOR: 'lite-single' });
  const machines = new Machines({ store, backend, config });
  const events = [];
  machines.on('machine', (e) => events.push(`${e.event}:${e.machine.state}`));
  const deepener = { targetDepth: 20, status: () => ({ running: false }), start: async () => ({}), stop: async () => ({}), configure: () => {}, prioritize: () => 0, nextPositions: () => [] };
  handler = createApp({ store, book, deepener, machines });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let r = await post('/api/machines/requests', { epd: E4, depth: 10, multipv: 2, label: '1. e4' });
    assert.equal(r.status, 200);
    const q = await r.json();
    assert.equal(q.created, true);
    r = await post('/api/machines', {});
    assert.equal(r.status, 200);
    const { machine } = await r.json();
    assert.equal(machine.state, 'starting');
    assert.equal(machine.backend, 'local');
    // worker calls without a token are refused
    assert.equal((await post('/api/machines/worker/next', {})).status, 401);
    // wait for the worker to pick it up and finish
    let status;
    for (let i = 0; i < 120; i++) {
      await new Promise((res) => setTimeout(res, 500));
      status = await (await fetch(base + '/api/machines')).json();
      if (status.requests[0]?.status === 'done') break;
    }
    assert.equal(status.requests[0].status, 'done', JSON.stringify(status));
    assert.ok(status.requests[0].progress >= 10);
    const a = store.getAnalysis(E4);
    assert.ok(a.depth >= 10, `stored depth ${a.depth}`);
    assert.equal(a.source, 'machine');
    assert.equal(a.multipv, 2);
    assert.match(a.lines[0].pv[0], /^[a-h][1-8][a-h][1-8]$/);
    const m = status.machines[0];
    assert.equal(m.positions, 1);
    assert.ok(['running', 'idle'].includes(m.state), m.state);
    // stop it; the process goes away
    r = await fetch(`${base}/api/machines/${machine.id}`, { method: 'DELETE' });
    assert.equal((await r.json()).machine.state, 'stopped');
    for (let i = 0; i < 40 && backend.children.size; i++) await new Promise((res) => setTimeout(res, 250));
    assert.equal(backend.children.size, 0, 'worker process exited');
    assert.ok(events.includes('created:starting'));
  } finally {
    await machines.shutdown();
    server.close();
    store.close();
  }
});
