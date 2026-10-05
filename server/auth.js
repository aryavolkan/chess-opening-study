// Sign in with Google (OpenID Connect, authorization code flow with PKCE)
// and cookie sessions, on Node's own crypto and fetch. Enabled by setting
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (and BASE_URL, the public origin
// Google redirects back to); without them the app runs as before, a single
// local user with every right.
//
//   GET  /auth/google            start the flow (optional ?next=/path)
//   GET  /auth/google/callback   Google returns here; sets the session cookie
//   GET  /auth/me                { mode, user, admin }
//   POST /auth/logout            end the session
//
// Admins are the accounts whose e-mail is listed in ADMIN_EMAILS; they may
// run the server engines and share imports with everyone.

import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, createHash, constants } from 'node:crypto';
import { localScope, userScope } from './db.js';

export const SESSION_COOKIE = 'ost_session';
const STATE_COOKIE = 'ost_oauth';
const SESSION_DAYS = 30;

export const GOOGLE = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

/** The virtual user of an instance without sign-in. */
export const LOCAL_USER = Object.freeze({ id: 0, name: 'local', email: null, picture: null, admin: true, local: true });

/** Read the configuration from the environment; null when sign-in is not configured. */
export function authConfigFromEnv(env = process.env) {
  if (!env.GOOGLE_CLIENT_ID) return null;
  if (!env.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set');
  if (!env.BASE_URL) throw new Error('BASE_URL (the public origin, e.g. https://study.example.com) is required when sign-in is enabled');
  let endpoints = GOOGLE;
  if (env.GOOGLE_OIDC_ENDPOINTS) endpoints = { ...GOOGLE, ...JSON.parse(env.GOOGLE_OIDC_ENDPOINTS) };
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    baseUrl: env.BASE_URL.replace(/\/+$/, ''),
    adminEmails: (env.ADMIN_EMAILS || '').split(/[,\s]+/).filter(Boolean).map((e) => e.toLowerCase()),
    secret: env.SESSION_SECRET || null,
    endpoints,
  };
}

/**
 * @param {object} o
 * @param {import('./db.js').Store} o.store
 * @param {object|null} [o.config]  from authConfigFromEnv(); null = sign-in off
 * @param {typeof fetch} [o.fetchImpl]
 */
export function createAuth({ store, config = null, fetchImpl = fetch }) {
  const mode = config ? 'on' : 'off';
  const secret = config?.secret ? Buffer.from(config.secret) : randomBytes(32);
  const secure = Boolean(config && config.baseUrl.startsWith('https://'));
  const jwks = { keys: new Map(), fetchedAt: 0 };
  const buckets = new Map(); // rate limiting

  function userFromRequest(req) {
    if (mode === 'off') return LOCAL_USER;
    const sid = cookies(req)[SESSION_COOKIE];
    return sid ? store.sessionUser(sid) : null;
  }

  function scopeFor(user) {
    if (mode === 'off') return localScope();
    return userScope(user);
  }

  /** Allow `limit` events per `windowMs` for a key; false when exceeded. */
  function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
      if (buckets.size > 10000) for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
    }
    b.count++;
    return b.count <= limit;
  }

  /** True when the request is a cross-site request that must not act on the session. */
  function crossSite(req) {
    if (mode === 'off') return false;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const origin = req.headers.origin;
    if (origin && origin !== config.baseUrl) return true;
    return false;
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (path === '/auth/me') {
      const user = userFromRequest(req);
      return send(res, 200, { mode, user: publicUser(user), admin: Boolean(user?.admin) });
    }
    if (mode === 'off') return send(res, 404, { error: 'sign-in is not enabled on this server' });
    const ip = clientIp(req);
    if (path === '/auth/google' && req.method === 'GET') {
      if (!rateLimit(`login:${ip}`, 20, 60000)) return send(res, 429, { error: 'too many sign-in attempts, try again in a minute' });
      const state = randomBytes(16).toString('base64url');
      const nonce = randomBytes(16).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const next = safeNext(url.searchParams.get('next'));
      setCookie(res, STATE_COOKIE, sign({ state, nonce, verifier, next, exp: Date.now() + 10 * 60000 }), { maxAge: 600, secure });
      const q = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${config.baseUrl}/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'online',
        prompt: 'select_account',
      });
      res.writeHead(302, { Location: `${config.endpoints.authorization}?${q}`, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (path === '/auth/google/callback' && req.method === 'GET') {
      if (!rateLimit(`callback:${ip}`, 30, 60000)) return send(res, 429, { error: 'too many sign-in attempts, try again in a minute' });
      const saved = unsign(cookies(req)[STATE_COOKIE]);
      clearCookie(res, STATE_COOKIE, { secure });
      if (url.searchParams.get('error')) return send(res, 400, { error: `Google refused the sign-in: ${url.searchParams.get('error')}` });
      const code = url.searchParams.get('code');
      if (!saved || saved.exp < Date.now() || !code || url.searchParams.get('state') !== saved.state) {
        return send(res, 400, { error: 'sign-in state is missing or expired; start again from /auth/google' });
      }
      let claims;
      try {
        const token = await exchangeCode(code, saved.verifier);
        claims = await verifyIdToken(token.id_token, saved.nonce);
      } catch (err) {
        return send(res, 401, { error: `sign-in failed: ${err.message}` });
      }
      const email = claims.email && claims.email_verified ? String(claims.email).toLowerCase() : null;
      const user = store.upsertUser({
        sub: claims.sub,
        email,
        name: claims.name || email || 'Google user',
        picture: claims.picture || null,
        admin: Boolean(email && config.adminEmails.includes(email)),
      });
      const sid = store.createSession(user.id, { ttlMs: SESSION_DAYS * 86400000, userAgent: req.headers['user-agent'] });
      setCookie(res, SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400, secure });
      res.writeHead(302, { Location: saved.next || '/', 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      if (crossSite(req)) return send(res, 403, { error: 'cross-site request' });
      const sid = cookies(req)[SESSION_COOKIE];
      if (sid) store.deleteSession(sid);
      clearCookie(res, SESSION_COOKIE, { secure });
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  async function exchangeCode(code, verifier) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: `${config.baseUrl}/auth/google/callback`,
      code_verifier: verifier,
    });
    const r = await fetchImpl(config.endpoints.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.id_token) throw new Error(data.error_description || data.error || `token endpoint answered ${r.status}`);
    return data;
  }

  async function jwk(kid) {
    if (!jwks.keys.has(kid) || Date.now() - jwks.fetchedAt > 3600000) {
      const r = await fetchImpl(config.endpoints.jwks);
      if (!r.ok) throw new Error(`could not fetch Google's signing keys (${r.status})`);
      const data = await r.json();
      jwks.keys = new Map((data.keys || []).map((k) => [k.kid, k]));
      jwks.fetchedAt = Date.now();
    }
    const k = jwks.keys.get(kid);
    if (!k) throw new Error('ID token signed with an unknown key');
    return k;
  }

  /** Verify signature, issuer, audience, expiry and nonce of a Google ID token; returns its claims. */
  async function verifyIdToken(idToken, nonce) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('malformed ID token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (header.alg !== 'RS256') throw new Error(`unsupported ID token algorithm ${header.alg}`);
    const key = createPublicKey({ key: await jwk(header.kid), format: 'jwk' });
    const ok = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new Error('ID token signature does not verify');
    if (!config.endpoints.issuers.includes(claims.iss)) throw new Error('ID token issuer is not Google');
    if (claims.aud !== config.clientId) throw new Error('ID token is for another client');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() - 60000) throw new Error('ID token has expired');
    if (claims.nonce !== nonce) throw new Error('ID token nonce does not match');
    if (!claims.sub) throw new Error('ID token has no subject');
    return claims;
  }

  function sign(obj) {
    const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
    const mac = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  function unsign(value) {
    if (!value || !value.includes('.')) return null;
    const [body, mac] = value.split('.');
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }

  return { mode, config, userFromRequest, scopeFor, handle, rateLimit, crossSite, secure };
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, picture: user.picture, admin: Boolean(user.admin), local: Boolean(user.local) };
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, { maxAge, secure }) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) attrs.push('Secure');
  appendHeader(res, 'Set-Cookie', attrs.join('; '));
}

function clearCookie(res, name, { secure }) {
  setCookie(res, name, '', { maxAge: 0, secure });
}

function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  res.setHeader(name, prev ? [].concat(prev, value) : value);
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
  return true;
}

/** Only same-site paths may be used as the post-login destination. */
function safeNext(next) {
  return next && /^\/(?!\/)/.test(next) ? next.slice(0, 500) : '/';
}

function clientIp(req) {
  const fwd = req.headers['fly-client-ip'] || req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : req.socket?.remoteAddress) || 'unknown';
}
