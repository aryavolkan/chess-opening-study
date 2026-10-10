// Games from a URL: a chess-results.com tournament, or any address that
// serves a PGN file. chess-results.com (the Swiss-Manager results server
// most over-the-board tournaments are published on) keeps the games of a
// tournament, when the organiser uploaded them, behind its game search page
// (`partieSuche.aspx?art=3&tnr=N`), an ASP.NET form whose "Download as
// PGN-File" button posts the form back. Nothing here knows the form's field
// names: the page's own form is replayed (every hidden and prefilled field,
// plus the button or postback link that mentions PGN), which survives the
// site renaming its controls. The tournament page gives the name.
//
// The server fetches on the user's behalf because browsers cannot read
// chess-results.com cross-origin. Only public hosts are fetched (no
// loopback, link-local or private addresses, and redirects are checked the
// same way), and the body is streamed into the importer, which caps its
// size.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export const CHESS_RESULTS_HOST = 'chess-results.com';
const CHESS_RESULTS_HOSTS = /^(?:[a-z0-9-]+\.)?chess-results\.com$/i;
const MAX_REDIRECTS = 5;
const PAGE_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60000;
const MAX_PAGE_BYTES = 4e6;
const USER_AGENT = 'chess-opening-study (+https://github.com/aryavolkan/chess-opening-study)';

/**
 * The tournament number of a chess-results.com link (`tnr123456.aspx`,
 * `?tnr=123456`, any of the site's hosts) or of a bare number; null for
 * anything else.
 */
export function chessResultsTournament(input) {
  const s = String(input ?? '').trim();
  if (/^\d{1,9}$/.test(s)) return Number(s);
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!CHESS_RESULTS_HOSTS.test(url.hostname)) return null;
  const m = /\/tnr(\d{1,9})\.aspx$/i.exec(url.pathname);
  if (m) return Number(m[1]);
  const q = url.searchParams.get('tnr');
  return q && /^\d{1,9}$/.test(q) ? Number(q) : null;
}

/** The chess-results.com page of a tournament. */
export function chessResultsUrl(tnr) {
  return `https://${CHESS_RESULTS_HOST}/tnr${tnr}.aspx?lan=1`;
}

/**
 * Open the games behind `input` for import. Resolves with
 * `{ name, source, body, tournament }`: a suggested import name, the address
 * to record, a Readable of the PGN bytes and, for chess-results.com, the
 * tournament number. Errors carry an HTTP status (400 for a bad address, 404
 * when the tournament has no games, 502 when the site fails).
 */
export async function openGamesUrl(input, { fetch = globalThis.fetch, lookup = dnsLookup } = {}) {
  const tnr = chessResultsTournament(input);
  if (tnr) return openChessResults(tnr, { fetch });
  const url = parseHttpUrl(input);
  const client = new Client({ fetch, lookup });
  const res = await client.get(url, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) throw httpError(502, `${url.hostname} answered ${res.status}`);
  if (isHtml(res)) throw httpError(400, 'that address serves a web page, not a PGN file');
  const file = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '').replace(/\.(pgn|txt)(\.gz)?$/i, '');
  return { name: file || url.hostname, source: url.href, body: Readable.fromWeb(res.body), tournament: null };
}

async function openChessResults(tnr, { fetch }) {
  const client = new Client({ fetch, lookup: null });
  const pageUrl = chessResultsUrl(tnr);
  const page = await client.text(pageUrl);
  const name = tournamentName(page) || `chess-results tournament ${tnr}`;
  const searchUrl = `https://${CHESS_RESULTS_HOST}/partieSuche.aspx?lan=1&art=3&tnr=${tnr}`;
  const search = await client.text(searchUrl);
  const form = findPgnForm(search);
  if (!form) throw httpError(404, `"${name}" has no games on chess-results.com (the organiser has not uploaded them)`);
  const action = new URL(form.action || '', searchUrl);
  const res = await client.request(action, {
    method: form.method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: searchUrl },
    body: form.body.toString(),
  }, DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) throw httpError(502, `chess-results.com answered ${res.status} to the games download`);
  if (isHtml(res)) throw httpError(404, `chess-results.com did not return the games of "${name}" as PGN`);
  return { name, source: pageUrl, body: Readable.fromWeb(res.body), tournament: tnr };
}

// ---------------------------------------------------------------------------
// chess-results.com pages

/** The tournament's name from its page: the title after the site's prefix, else the first heading. */
export function tournamentName(html) {
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  const fromTitle = title.replace(/^chess-results(?:\s+server)?(?:\s+chess-results\.com)?\s*-\s*/i, '').replace(/^chess-results\.com\s*-\s*/i, '');
  if (fromTitle && !/^chess-results/i.test(fromTitle)) return fromTitle.slice(0, 200);
  const h = clean(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(html)?.[1] || '');
  return h ? h.slice(0, 200) : null;
}

/**
 * The form on the game search page and what to post to press its PGN
 * button: `{ action, method, body: URLSearchParams }`, or null when the page
 * has no such button (no games).
 */
export function findPgnForm(html) {
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = formRe.exec(html))) {
    const fa = attrs(m[1]);
    const inner = m[2];
    const body = new URLSearchParams();
    let button = null;
    // Every input the browser would send: hidden fields (ASP.NET's view
    // state among them), prefilled text fields, checked boxes, selects.
    const inputRe = /<input\b([^>]*)>/gi;
    let im;
    while ((im = inputRe.exec(inner))) {
      const a = attrs(im[1]);
      const type = (a.type || 'text').toLowerCase();
      if (!a.name) continue;
      if (type === 'submit' || type === 'button' || type === 'image') {
        if (!button && /pgn/i.test(`${a.value || ''} ${a.name} ${a.id || ''} ${a.title || ''}`)) button = { name: a.name, value: a.value ?? '' };
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        if ('checked' in a) body.append(a.name, a.value ?? 'on');
        continue;
      }
      if (type === 'file' || type === 'reset') continue;
      body.append(a.name, a.value ?? '');
    }
    const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let sm;
    while ((sm = selectRe.exec(inner))) {
      const a = attrs(sm[1]);
      if (!a.name) continue;
      const options = [...sm[2].matchAll(/<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/select|$)/gi)].map((o) => {
        const oa = attrs(o[1]);
        return { value: oa.value ?? clean(o[2]), selected: 'selected' in oa };
      });
      const chosen = options.find((o) => o.selected) || options[0];
      if (chosen) body.append(a.name, chosen.value);
    }
    const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let bm;
    while (!button && (bm = buttonRe.exec(inner))) {
      const a = attrs(bm[1]);
      if (a.name && (a.type || 'submit').toLowerCase() === 'submit' && /pgn/i.test(`${clean(bm[2])} ${a.value || ''} ${a.name} ${a.id || ''}`)) button = { name: a.name, value: a.value ?? '' };
    }
    if (button) {
      body.append(button.name, button.value);
    } else {
      // A LinkButton: <a href="javascript:__doPostBack('ctl00$x','')">Download as PGN-File</a>
      const postRe = /__doPostBack\(\s*(['"])([^'"]*)\1\s*,\s*(['"])([^'"]*)\3\s*\)[^>]*>([\s\S]{0,200}?)<\/a>/gi;
      let pm;
      while ((pm = postRe.exec(inner))) {
        if (/pgn/i.test(clean(pm[5])) || /pgn/i.test(pm[2])) {
          body.set('__EVENTTARGET', pm[2]);
          body.set('__EVENTARGUMENT', pm[4]);
          button = { name: '__EVENTTARGET', value: pm[2] };
          break;
        }
      }
    }
    if (!button) continue;
    return { action: fa.action ? decodeEntities(fa.action) : '', method: (fa.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST', body };
  }
  return null;
}

/** Attributes of one tag, entity-decoded; a bare attribute (`checked`) maps to ''. */
function attrs(s) {
  const out = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const v = m[2] ?? m[3] ?? m[4];
    out[m[1].toLowerCase()] = v === undefined ? '' : decodeEntities(v);
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function isHtml(res) {
  return /text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '');
}

// ---------------------------------------------------------------------------
// HTTP

/** A fetch wrapper that keeps the site's cookies, follows redirects by hand and refuses private hosts. */
class Client {
  constructor({ fetch, lookup }) {
    this.fetch = fetch;
    this.lookup = lookup; // null: the host is fixed and known to be public
    this.cookies = new Map();
  }

  async text(url) {
    const res = await this.get(new URL(url), PAGE_TIMEOUT_MS);
    if (!res.ok) throw httpError(502, `${new URL(url).hostname} answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PAGE_BYTES) throw httpError(502, 'the page is unexpectedly large');
    return buf.toString('utf8');
  }

  get(url, timeoutMs) {
    return this.request(url, { method: 'GET' }, timeoutMs);
  }

  async request(url, init, timeoutMs) {
    let current = url;
    let method = init.method;
    let body = init.body;
    for (let hop = 0; ; hop++) {
      if (this.lookup) await assertPublicHost(current.hostname, { lookup: this.lookup });
      const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', ...(init.headers || {}) };
      if (body === undefined) delete headers['Content-Type'];
      const cookie = this.cookieHeader();
      if (cookie) headers.Cookie = cookie;
      const res = await this.fetch(current.href, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
        .catch((err) => { throw httpError(502, `could not reach ${current.hostname}: ${err?.cause?.message || err?.message || err}`); });
      this.storeCookies(res);
      const location = res.headers.get('location');
      if (location && res.status >= 300 && res.status < 400) {
        if (hop >= MAX_REDIRECTS) throw httpError(502, 'too many redirects');
        try { await res.body?.cancel(); } catch { /* ignore */ }
        current = new URL(location, current);
        if (current.protocol !== 'http:' && current.protocol !== 'https:') throw httpError(400, 'redirected to a non-http address');
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
        continue;
      }
      return res;
    }
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const m = /^([^=;\s]+)=([^;]*)/.exec(c);
      if (m) this.cookies.set(m[1], m[2]);
    }
  }
}

/** An http(s) URL from user input, or a 400. */
export function parseHttpUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw httpError(400, 'enter a chess-results.com tournament link or the address of a PGN file');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, 'only http and https addresses can be fetched');
  if (url.username || url.password) throw httpError(400, 'addresses with credentials are not fetched');
  return url;
}

/** Refuse hosts that resolve to loopback, link-local, private or reserved addresses. */
export async function assertPublicHost(hostname, { lookup = dnsLookup } = {}) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || (!isIP(h) && !h.includes('.'))) {
    throw httpError(400, 'only public internet addresses can be fetched');
  }
  let addresses;
  if (isIP(h)) addresses = [h];
  else {
    try {
      addresses = (await lookup(h, { all: true })).map((a) => a.address);
    } catch {
      throw httpError(400, `${hostname} could not be resolved`);
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw httpError(400, 'only public internet addresses can be fetched');
}

export function isPrivateAddress(ip) {
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (v4) return isPrivateAddress(v4[1]);
    if (low === '::' || low === '::1') return true;
    if (/^f[cd]/.test(low)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(low)) return true; // fe80::/10 link-local
    if (/^ff/.test(low)) return true; // multicast
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // carrier NAT
  if (p[0] === 192 && p[1] === 0 && (p[2] === 0 || p[2] === 2)) return true; // IETF, documentation
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // benchmarking
  if (p[0] >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
