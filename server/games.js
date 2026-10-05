// PGN import: streams a file (or an HTTP body) through the PGN reader,
// replays the opening of every game to find the positions it went through
// and where it left the opening book, and stores games and positions in
// batches. Built for large files: the input is read in chunks with
// backpressure, each batch is one SQLite transaction, and the event loop
// gets a turn between batches so the web app stays responsive while a
// hundred thousand games go in.
//
// Positions are computed with chessops (bitboards, ~20x faster than
// chess.js); chess.js is kept as a fallback for sloppy SAN that chessops
// rejects (`Pe4`, over-disambiguated moves). A trie of positions keyed by
// the moves that reach them is shared by all games of an import, so the
// first plies, which most games have in common, are replayed once.

import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { Chess as ChessOps } from 'chessops/chess';
import { parseSan, makeSan } from 'chessops/san';
import { makeFen, parseFen, INITIAL_FEN } from 'chessops/fen';
import { Chess } from 'chess.js';
import { PgnParser, normalizeDate } from '../shared/pgn.js';
import { epdOf } from '../shared/fen.js';
import { localScope } from './db.js';
import { nearestName, pathOf, walk } from '../shared/book.js';

export const DEFAULT_MAX_PLIES = 40;
export const MIN_MAX_PLIES = 10;
export const MAX_MAX_PLIES = 80;
const CACHE_PLIES = 24;
const CACHE_MAX_NODES = 300000;
const BATCH = 250;
export const DEFAULT_MAX_BYTES = Math.max(1, Number(process.env.MAX_IMPORT_MB) || 500) * 1e6;

export class Importer {
  constructor({ store, book }) {
    this.store = store;
    this.book = book;
    this.current = null; // progress of the running import, or null
    this.cache = null;
  }

  /** Progress of the running import for the UI, or null. */
  status() {
    if (!this.current) return null;
    const c = this.current;
    return { id: c.id, name: c.name, games: c.games, duplicates: c.duplicates, invalid: c.invalid, positions: c.positions, bytes: c.bytes, startedAt: c.startedAt };
  }

  /**
   * Import every game in `source` (a Readable of bytes, gzip detected
   * automatically) as one import. Resolves with the finished import record.
   */
  async importStream(source, { name = 'PGN import', player = null, maxPlies = DEFAULT_MAX_PLIES, gzip = false, onProgress, scope = localScope(), maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (this.current) {
      const err = new Error('an import is already running');
      err.status = 409;
      throw err;
    }
    const plies = clampPlies(maxPlies);
    const playerName = player && String(player).trim() ? String(player).trim().slice(0, 100) : null;
    const id = this.store.createImport({ name: String(name).slice(0, 200), player: playerName, plies }, scope);
    const owner = { userId: scope.user ?? 0, shared: false };
    const cur = { id, name, games: 0, duplicates: 0, invalid: 0, positions: 0, bytes: 0, startedAt: new Date().toISOString(), t0: Date.now() };
    this.current = cur;
    if (!this.cache) this.cache = makeCache(this.book);
    const parser = new PgnParser();
    const decoder = new TextDecoder('utf-8');
    let pending = [];
    let error = null;
    const flush = () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      this.store.transaction(() => {
        for (const game of batch) this.insertGame(game, id, plies, cur, owner);
      });
      onProgress?.(this.status());
    };
    try {
      for await (const chunk of bytes(source, gzip)) {
        cur.bytes += chunk.length;
        if (cur.bytes > maxBytes) throw new Error(`the file is larger than ${Math.round(maxBytes / 1e6)} MB; stopped there`);
        pending.push(...parser.push(decoder.decode(chunk, { stream: true })));
        while (pending.length >= BATCH) {
          const rest = pending.splice(BATCH);
          flush();
          pending = rest;
          await new Promise((r) => setImmediate(r));
        }
      }
      pending.push(...parser.push(decoder.decode()));
      pending.push(...parser.end());
      flush();
    } catch (err) {
      error = String(err?.message || err);
      try { flush(); } catch { /* keep what was stored */ }
    } finally {
      this.current = null;
    }
    const record = this.store.finishImport(id, {
      games: cur.games, positions: cur.positions, duplicates: cur.duplicates, invalid: cur.invalid,
      bytes: cur.bytes, ms: Date.now() - cur.t0, error,
    });
    if (error && cur.games === 0 && cur.duplicates === 0) {
      this.store.deleteImport(id);
      const err = new Error(`import failed: ${error}`);
      err.status = 400;
      throw err;
    }
    return record;
  }

  insertGame(game, importId, plies, cur, owner) {
    const h = game.headers;
    const result = game.result || '*';
    // Dedupe key from the headers and the moves as written, checked before
    // the (comparatively expensive) replay so re-importing a file is quick.
    const key = createHash('sha1').update([h.Site || '', h.White || '', h.Black || '', h.Date || h.UTCDate || '', h.Round || '', result, game.moves.join(' ')].join('\n')).digest('hex');
    if (this.store.hasGame(key)) {
      cur.duplicates++;
      return;
    }
    const r = replayGame(game.moves, { cache: this.cache, maxPlies: plies });
    if (r.invalidAt !== null) cur.invalid++;
    if (!r.sans.length) return;
    const moves = r.sans.concat(game.moves.slice(r.sans.length, r.invalidAt === null ? undefined : r.invalidAt));
    const named = r.bookNode ? nearestName(r.bookNode) : null;
    const namedNode = r.bookNode ? namedAncestor(r.bookNode) : null;
    const positions = r.epds.map((epd, ply) => ({ epd, ply, move: ply < r.sans.length && ply < plies ? r.sans[ply] : null }));
    const id = this.store.insertGame({
      importId,
      userId: owner.userId,
      shared: owner.shared,
      key,
      white: h.White || null,
      black: h.Black || null,
      result,
      date: normalizeDate(h),
      event: h.Event || null,
      site: h.Site || null,
      round: h.Round && h.Round !== '?' && h.Round !== '-' ? h.Round : null,
      whiteElo: intOrNull(h.WhiteElo),
      blackElo: intOrNull(h.BlackElo),
      eco: h.ECO && h.ECO !== '?' ? h.ECO : null,
      opening: h.Opening && h.Opening !== '?' ? h.Opening : null,
      timeControl: h.TimeControl && h.TimeControl !== '-' ? h.TimeControl : null,
      termination: h.Termination || null,
      plies: moves.length,
      moves,
      bookPath: namedNode ? pathOf(namedNode).join(' ') : null,
      bookPly: r.bookNode ? r.bookNode.ply : 0,
      bookEco: named?.eco ?? null,
      bookName: named?.name ?? null,
      bookFamily: named ? familyOf(named.name) : null,
    }, positions);
    if (id === null) {
      cur.duplicates++;
      return;
    }
    cur.games++;
    cur.positions += positions.length;
  }
}

/** "Sicilian Defense: Najdorf Variation" -> "Sicilian Defense" */
export function familyOf(name) {
  return name ? name.split(':')[0].trim() : null;
}

function namedAncestor(node) {
  for (let n = node; n; n = n.parent) if (n.name) return n;
  return null;
}

export function clampPlies(v) {
  const n = Number(v);
  if (!Number.isInteger(n)) return DEFAULT_MAX_PLIES;
  return Math.max(MIN_MAX_PLIES, Math.min(MAX_MAX_PLIES, n));
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Byte chunks of a Readable, gunzipped when asked or when the data starts
 * with the gzip magic number.
 */
async function* bytes(source, gzip) {
  const it = source[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return;
  let head = Buffer.isBuffer(first.value) ? first.value : Buffer.from(first.value);
  const isGzip = gzip || (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b);
  const rest = (async function* () {
    yield head;
    for (;;) {
      const n = await it.next();
      if (n.done) return;
      yield Buffer.isBuffer(n.value) ? n.value : Buffer.from(n.value);
    }
  })();
  if (!isGzip) {
    yield* rest;
    return;
  }
  const gunzip = createGunzip();
  const src = Readable.from(rest);
  src.on('error', (err) => gunzip.destroy(err));
  src.pipe(gunzip);
  try {
    for await (const chunk of gunzip) yield chunk;
  } finally {
    src.destroy();
  }
}

// ---------------------------------------------------------------------------
// position replay

/**
 * Shared state for replaying games: a trie of known positions keyed by the
 * move tokens that reach them, and the opening book indexed by position, so
 * a game that reaches a book position by a different move order (a
 * transposition) is still classified as that opening.
 */
export function makeCache(book) {
  const byEpd = new Map();
  if (book?.root) {
    walk(book.root, (node) => {
      if (!node.epd) return;
      const have = byEpd.get(node.epd);
      if (!have || (!have.name && node.name)) byEpd.set(node.epd, node);
    });
  }
  const root = { fen: INITIAL_FEN, epd: epdOf(INITIAL_FEN), book: book?.root ?? null, children: new Map() };
  return { root, byEpd, size: 0 };
}

/**
 * Replay `moves` (SAN tokens) from the starting position.
 * @returns {{ sans: string[], epds: string[], bookNode: object|null, invalidAt: number|null }}
 *   sans: normalised SAN of the first min(n, maxPlies) plies; epds: the
 *   positions before each of them plus the one after the last (length
 *   sans.length + 1); bookNode: the opening-book node of the last book
 *   position the game reached (by position, so transpositions count);
 *   invalidAt: index of the first illegal token, if any.
 */
export function replayGame(moves, { cache, maxPlies = DEFAULT_MAX_PLIES }) {
  let node = cache.root;
  let bookNode = cache.root.book;
  let pos = null;
  const sans = [];
  const epds = [node.epd];
  let invalidAt = null;
  const n = Math.min(moves.length, maxPlies);
  for (let i = 0; i < n; i++) {
    const tok = moves[i];
    if (!pos) {
      const child = node.children.get(tok);
      if (child) {
        node = child;
        if (child.book) bookNode = child.book;
        sans.push(child.san);
        epds.push(child.epd);
        continue;
      }
      pos = ChessOps.fromSetup(parseFen(node.fen).unwrap()).unwrap();
    }
    let move = parseSan(pos, tok);
    if (!move) {
      const alt = sloppySan(pos, tok);
      move = alt ? parseSan(pos, alt) : undefined;
    }
    if (!move) {
      invalidAt = i;
      break;
    }
    const san = makeSan(pos, move);
    pos.play(move);
    const fen = makeFen(pos.toSetup());
    const epd = epdOf(fen);
    const inBook = cache.byEpd.get(epd) ?? null;
    if (inBook) bookNode = inBook;
    sans.push(san);
    epds.push(epd);
    if (node && i < CACHE_PLIES && cache.size < CACHE_MAX_NODES) {
      const child = { san, fen, epd, book: inBook, children: new Map() };
      node.children.set(tok, child);
      cache.size++;
      node = child;
    } else {
      node = null;
    }
  }
  return { sans, epds, bookNode, invalidAt };
}

/** chess.js is more forgiving about SAN spelling; use it to normalise a token chessops rejects. */
function sloppySan(pos, tok) {
  try {
    return new Chess(makeFen(pos.toSetup())).move(tok.replace(/^P(?=[a-h])/, ''))?.san ?? null;
  } catch {
    return null;
  }
}
