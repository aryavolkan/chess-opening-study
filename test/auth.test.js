import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { openDb } from '../server/db.js';
import { loadOpenings } from '../server/openings.js';
import { createApp } from '../server/app.js';
import { createAuth, SESSION_COOKIE } from '../server/auth.js';

// A stand-in for Google: /auth sends the browser back with a code, /token
// trades the code for an ID token signed with our test key (checking the
// client secret and the PKCE verifier), /certs serves the key as a JWKS.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const ISSUER = 'https://fake-google.example';
const codes = new Map();
let identity = {};
let fake;
let fakeBase;
let server;
let base;
let store;
let handler;

function signJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })}.${enc(payload)}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url');
  return `${data}.${sig}`;
}

function fakeGoogle(req, res) {
  const url = new URL(req.url, 'http://x');
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/auth') {
    const code = `code-${codes.size + 1}`;
    codes.set(code, { nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge'), redirect: url.searchParams.get('redirect_uri') });
    res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}` });
    res.end();
  } else if (url.pathname === '/token') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const c = codes.get(p.get('code'));
      if (!c || p.get('client_id') !== 'test-client' || p.get('client_secret') !== 'test-secret' || p.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant' });
      if (createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verifier does not match' });
      codes.delete(p.get('code'));
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: ISSUER, aud: 'test-client', sub: identity.sub, email: identity.email, email_verified: identity.verified !== false, name: identity.name, picture: identity.picture || null, nonce: c.nonce, iat: now, exp: now + 3600, ...identity.override };
      json(200, { id_token: signJwt(claims), access_token: 'x', token_type: 'Bearer' });
    });
  } else if (url.pathname === '/certs') {
    json(200, { keys: [jwk] });
  } else {
    json(404, { error: 'nope' });
  }
}

before(async () => {
  fake = createServer(fakeGoogle);
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  store = openDb();
  const book = loadOpenings();
  server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const auth = createAuth({
    store,
    config: {
      clientId: 'test-client',
      clientSecret: 'test-secret',
      baseUrl: base,
      adminEmails: ['admin@example.com'],
      secret: null,
      endpoints: { authorization: `${fakeBase}/auth`, token: `${fakeBase}/token`, jwks: `${fakeBase}/certs`, issuers: [ISSUER] },
    },
  });
  const deepener = { targetDepth: 20, status: () => ({ running: false }), start: async () => ({ running: true }), stop: async () => ({ running: false }), configure: () => {}, prioritize: () => 0, nextPositions: () => [] };
  handler = createApp({ store, book, deepener, auth });
});

after(() => {
  server.close();
  fake.close();
  store.close();
});

const cookieOf = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

/** Run the whole redirect dance for an identity; returns the session cookie. */
async function login(who, next = '/') {
  identity = who;
  const r1 = await fetch(`${base}/auth/google?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  const state = cookieOf(r1, 'ost_oauth');
  assert.ok(state, 'state cookie set');
  assert.match(state, /HttpOnly/);
  const toGoogle = r1.headers.get('location');
  assert.ok(toGoogle.startsWith(`${fakeBase}/auth?`));
  const q = new URL(toGoogle).searchParams;
  assert.equal(q.get('client_id'), 'test-client');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('redirect_uri'), `${base}/auth/google/callback`);
  const r2 = await fetch(toGoogle, { redirect: 'manual' });
  assert.equal(r2.status, 302);
  const r3 = await fetch(r2.headers.get('location'), { redirect: 'manual', headers: { cookie: state.split(';')[0] } });
  assert.equal(r3.status, 302, await r3.text());
  assert.equal(r3.headers.get('location'), next);
  const session = cookieOf(r3, SESSION_COOKIE);
  assert.ok(session);
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  assert.doesNotMatch(session, /Secure/, 'plain http in tests');
  return session.split(';')[0];
}

const me = async (cookie) => (await fetch(`${base}/auth/me`, { headers: cookie ? { cookie } : {} })).json();
const api = (method, path, body, cookie, extra = {}) => fetch(base + path, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra },
  body: body ? JSON.stringify(body) : undefined,
});

const PGN = (site, white, black) => `[Site "${site}"]\n[White "${white}"]\n[Black "${black}"]\n[Result "1-0"]\n\n1. e4 c5 2. Nf3 1-0\n\n`;

test('anonymous visitors can read but not write', async () => {
  assert.deepEqual(await me(), { mode: 'on', user: null, admin: false });
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.signIn, 'on');
  assert.equal((await fetch(`${base}/api/openings`)).status, 200);
  const study = await (await fetch(`${base}/api/study`)).json();
  assert.deepEqual(study.lines, []);
  assert.equal(study.signInRequired, true);
  let r = await api('POST', '/api/study', { san: ['e4'], color: 'white' });
  assert.equal(r.status, 401);
  r = await api('POST', '/api/analysis', { epd: 'x', depth: 5, lines: [{ score: { type: 'cp', value: 1 }, pv: ['e2e4'] }] });
  assert.equal(r.status, 401);
  r = await api('POST', '/api/deepen/start', {});
  assert.equal(r.status, 401);
  r = await api('POST', '/api/explore/jobs', { color: 'white' });
  assert.equal(r.status, 401);
  r = await fetch(`${base}/api/games/import`, { method: 'POST', body: PGN('s', 'a', 'b') });
  assert.equal(r.status, 401);
  const imports = await (await fetch(`${base}/api/games/imports`)).json();
  assert.equal(imports.canImport, false);
  assert.equal(imports.total.games, 0);
  assert.equal((await fetch(`${base}/auth/google/callback?code=x&state=y`)).status, 400, 'no state cookie');
});

test('sign in with Google: session, per-user study set, admin flag, logout', async () => {
  const alice = await login({ sub: 'sub-alice', email: 'Alice@Example.com', name: 'Alice', picture: 'https://p/alice.png' }, '/?moves=e4');
  let m = await me(alice);
  assert.equal(m.user.name, 'Alice');
  assert.equal(m.user.email, 'alice@example.com');
  assert.equal(m.admin, false);
  assert.equal(m.user.picture, 'https://p/alice.png');

  let r = await api('POST', '/api/study', { san: ['e4', 'c5'], color: 'black', name: 'Sicilian' }, alice);
  assert.equal(r.status, 200);
  const { line } = await r.json();
  assert.equal((await (await api('GET', '/api/study', null, alice)).json()).lines.length, 1);

  const bob = await login({ sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' });
  assert.equal((await (await api('GET', '/api/study', null, bob)).json()).lines.length, 0, 'study sets are per user');
  r = await api('POST', '/api/study', { san: ['e4', 'c5'], color: 'black', name: 'Sicilian' }, bob);
  assert.equal((await r.json()).created, true, 'the same line can be in two users\' sets');
  r = await api('DELETE', `/api/study/${line.id}`, null, bob);
  assert.equal((await r.json()).removed, false, 'not Bob\'s line');
  r = await api('POST', `/api/study/${line.id}/result`, { correct: true }, bob);
  assert.equal(r.status, 404);
  r = await api('POST', `/api/study/${line.id}/result`, { correct: true }, alice);
  assert.equal((await r.json()).line.box, 1);
  r = await api('DELETE', `/api/study/${line.id}`, null, alice);
  assert.equal((await r.json()).removed, true);

  // Users may save analysis and pull positions to deepen, but not run the server engines
  r = await api('POST', '/api/analysis', { epd: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -', depth: 5, lines: [{ score: { type: 'cp', value: 1 }, pv: ['c7c5'] }] }, alice);
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/api/deepen/next?count=1', null, alice)).status, 200);
  assert.equal((await api('POST', '/api/deepen/start', {}, alice)).status, 403);
  assert.equal((await api('POST', '/api/explore/start', {}, alice)).status, 403);

  // Logging in again with the same Google account is the same user
  const aliceAgain = await login({ sub: 'sub-alice', email: 'alice@example.com', name: 'Alice Renamed' });
  m = await me(aliceAgain);
  assert.equal(m.user.name, 'Alice Renamed');
  assert.equal(store.listUsers().length, 2);

  // Logout ends the session; the old cookie is worthless
  r = await api('POST', '/auth/logout', null, alice);
  assert.equal((await r.json()).ok, true);
  assert.match(cookieOf(r, SESSION_COOKIE), /Max-Age=0/);
  assert.equal((await me(alice)).user, null);
  assert.equal((await me(aliceAgain)).user.name, 'Alice Renamed', 'other sessions of the same user stay');
});

test('imports are private until an admin shares them', async () => {
  const alice = await login({ sub: 'sub-alice', email: 'alice@example.com', name: 'Alice' });
  const admin = await login({ sub: 'sub-admin', email: 'admin@example.com', name: 'Admin' });
  assert.equal((await me(admin)).admin, true);

  let r = await fetch(`${base}/api/games/import?name=mine`, { method: 'POST', headers: { cookie: alice }, body: PGN('a1', 'alice', 'x') + PGN('a2', 'y', 'alice') });
  assert.equal(r.status, 200);
  const mine = (await r.json()).import;
  assert.equal(mine.games, 2);
  assert.equal(mine.own, true);
  assert.equal(mine.shared, false);
  r = await fetch(`${base}/api/games/import?name=olympiad`, { method: 'POST', headers: { cookie: admin }, body: PGN('o1', 'carlsen', 'caruana') + PGN('o2', 'ding', 'gukesh') + PGN('o3', 'nakamura', 'so') });
  const olympiad = (await r.json()).import;
  assert.equal(olympiad.games, 3);

  const sicilian = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -';
  const seen = async (cookie) => (await (await api('GET', `/api/games/position?epd=${encodeURIComponent(sicilian)}`, null, cookie)).json()).stats?.games ?? 0;
  assert.equal(await seen(alice), 2, 'Alice sees her own games');
  assert.equal(await seen(admin), 3, 'the admin sees their own, not Alice\'s');
  assert.equal(await seen(null), 0, 'nothing is shared yet');
  assert.equal((await (await fetch(`${base}/api/games/imports`)).json()).imports.length, 0);
  assert.equal((await (await api('GET', `/api/games/${mine.id}`, null, null)).status), 404, 'wrong id anyway; private games are not readable');

  // Only an admin can share, and only what they can see
  r = await api('POST', `/api/games/imports/${mine.id}/share`, { shared: true }, alice);
  assert.equal(r.status, 403);
  r = await api('POST', `/api/games/imports/${mine.id}/share`, { shared: true }, admin);
  assert.equal(r.status, 404, 'admins do not see users\' private imports');
  r = await api('POST', `/api/games/imports/${olympiad.id}/share`, { shared: true }, admin);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).import.shared, true);
  assert.equal(await seen(null), 3, 'visitors see the shared import');
  assert.equal(await seen(alice), 5, 'Alice sees hers plus the shared one');
  const visitorImports = await (await fetch(`${base}/api/games/imports`)).json();
  assert.equal(visitorImports.imports.length, 1);
  assert.equal(visitorImports.imports[0].own, false);
  assert.equal(visitorImports.total.games, 3);
  const list = await (await fetch(`${base}/api/games?epd=${encodeURIComponent(sicilian)}`)).json();
  assert.equal(list.total, 3);
  assert.equal((await fetch(`${base}/api/games/${list.games[0].id}`)).status, 200);
  const aliceList = await (await api('GET', `/api/games?epd=${encodeURIComponent(sicilian)}`, null, alice)).json();
  const aliceGame = aliceList.games.find((g) => g.white === 'alice');
  assert.equal((await fetch(`${base}/api/games/${aliceGame.id}`)).status, 404, 'Alice\'s game stays private');
  const summary = await (await fetch(`${base}/api/games/openings?by=family`)).json();
  assert.equal(summary.total.games, 3);

  // Removing: owner or admin, and only something they can see
  r = await api('DELETE', `/api/games/imports/${mine.id}`, null, admin);
  assert.equal(r.status, 404);
  r = await api('DELETE', `/api/games/imports/${olympiad.id}`, null, alice);
  assert.equal(r.status, 403);
  r = await api('DELETE', `/api/games/imports/${mine.id}`, null, alice);
  assert.equal((await r.json()).removed, true);
  r = await api('POST', `/api/games/imports/${olympiad.id}/share`, { shared: false }, admin);
  assert.equal(await seen(null), 0);
});

test('cross-site requests and bad tokens are refused', async () => {
  const alice = await login({ sub: 'sub-alice', email: 'alice@example.com', name: 'Alice' });
  let r = await api('POST', '/api/study', { san: ['d4'], color: 'white' }, alice, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await api('POST', '/api/study', { san: ['d4'], color: 'white' }, alice, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r.status, 403);
  r = await api('POST', '/api/study', { san: ['d4'], color: 'white' }, alice, { Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(r.status, 200);
  r = await api('POST', '/auth/logout', null, alice, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal((await me(alice)).user.name, 'Alice', 'still signed in');

  // A token for another client, or with the wrong nonce, is rejected
  for (const override of [{ aud: 'someone-else' }, { nonce: 'wrong' }, { iss: 'https://not-google.example' }, { exp: Math.floor(Date.now() / 1000) - 7200 }]) {
    identity = { sub: 'sub-eve', email: 'eve@example.com', name: 'Eve', override };
    const r1 = await fetch(`${base}/auth/google`, { redirect: 'manual' });
    const state = cookieOf(r1, 'ost_oauth').split(';')[0];
    const r2 = await fetch(r1.headers.get('location'), { redirect: 'manual' });
    const r3 = await fetch(r2.headers.get('location'), { redirect: 'manual', headers: { cookie: state } });
    assert.equal(r3.status, 401, JSON.stringify(override));
    assert.equal(cookieOf(r3, SESSION_COOKIE), undefined);
  }
  // A callback with a state that does not match the cookie
  identity = { sub: 'sub-eve', email: 'eve@example.com', name: 'Eve' };
  const r1 = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const state = cookieOf(r1, 'ost_oauth').split(';')[0];
  const r2 = await fetch(r1.headers.get('location'), { redirect: 'manual' });
  const cb = new URL(r2.headers.get('location'));
  cb.searchParams.set('state', 'forged');
  assert.equal((await fetch(cb, { redirect: 'manual', headers: { cookie: state } })).status, 400);
  // An unknown code is refused by the token endpoint
  cb.searchParams.set('state', new URL(r1.headers.get('location')).searchParams.get('state'));
  cb.searchParams.set('code', 'bogus');
  assert.equal((await fetch(cb, { redirect: 'manual', headers: { cookie: state } })).status, 401);
  // next must stay on this site
  const r4 = await fetch(`${base}/auth/google?next=https://evil.example/`, { redirect: 'manual' });
  const s4 = cookieOf(r4, 'ost_oauth').split(';')[0];
  const r5 = await fetch(r4.headers.get('location'), { redirect: 'manual' });
  const r6 = await fetch(r5.headers.get('location'), { redirect: 'manual', headers: { cookie: s4 } });
  assert.equal(r6.headers.get('location'), '/');
});

test('without Google credentials everything is open to the local user', async () => {
  const local = createAuth({ store: openDb() });
  assert.equal(local.mode, 'off');
  const user = local.userFromRequest({ headers: {} });
  assert.equal(user.admin, true);
  assert.equal(user.local, true);
  assert.equal(local.scopeFor(user).restrict, false);
  assert.equal(local.crossSite({ headers: { origin: 'https://anything' } }), false);
});
