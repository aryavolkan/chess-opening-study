// Streaming PGN reader. Text is fed in chunks of any size (a file read from
// disk, an HTTP body, a File in the browser) and complete games come out as
// `{ headers, moves, result }`, where `moves` is the main line as SAN tokens
// with annotations stripped. Comments, variations, NAGs and move numbers are
// skipped. Nothing here validates moves; that is the importer's job.
//
// Deliberately tolerant: games without headers, games without a result token,
// `1/2` for a draw, `0-0` for castling, `\r\n` line endings, a BOM, `%`
// escape lines, `;` comments, comments spanning lines and tokens glued to
// move numbers (`12.Nf3`) are all accepted. An unbalanced `(` or `{` in one
// game does not swallow the rest of the file: a header line always starts a
// new game.

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);
const RESULT_ALIASES = { '1/2': '1/2-1/2', '½-½': '1/2-1/2', '½': '1/2-1/2' };
const TAG_RE = /^\s*\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/;

export class PgnParser {
  constructor() {
    this.rest = '';
    this.inComment = false;
    this.depth = 0; // variation nesting
    this.game = null;
    this.first = true;
    this.lineNo = 0;
  }

  /** Feed a chunk of text; returns the games completed by it. */
  push(text) {
    const out = [];
    if (this.first) {
      this.first = false;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    const data = this.rest ? this.rest + text : text;
    let start = 0;
    for (;;) {
      const nl = data.indexOf('\n', start);
      if (nl < 0) break;
      this.line(data.slice(start, nl), out);
      start = nl + 1;
    }
    this.rest = start < data.length ? data.slice(start) : '';
    return out;
  }

  /** Flush the last line and the last game. */
  end() {
    const out = [];
    if (this.rest) {
      this.line(this.rest, out);
      this.rest = '';
    }
    this.finish(out);
    return out;
  }

  line(raw, out) {
    this.lineNo++;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let i = 0;
    const tag = TAG_RE.exec(line);
    if (tag) {
      // A header line always starts (or continues) a header section, even if
      // a previous game left a comment or variation open.
      this.inComment = false;
      this.depth = 0;
      this.header(tag[1], unescapeTag(tag[2]), out);
      i = tag[0].length;
      // Several tags on one line, or a tag followed by movetext
      let more;
      while ((more = TAG_RE.exec(line.slice(i)))) {
        this.header(more[1], unescapeTag(more[2]), out);
        i += more[0].length;
      }
      if (i >= line.length) return;
    } else if (this.inComment) {
      const close = line.indexOf('}');
      if (close < 0) return;
      this.inComment = false;
      i = close + 1;
    } else {
      const first = line.trimStart()[0];
      if (first === '%' || first === '[') return; // escape line, or a malformed tag
    }
    this.movetext(line, i, out);
  }

  header(name, value, out) {
    const g = this.game;
    // Movetext already seen, or the same tag again: this header belongs to the next game.
    if (g && (g.moves.length || g.result !== null || name in g.headers)) this.finish(out);
    this.ensureGame();
    this.game.headers[name] = value;
  }

  movetext(line, i, out) {
    const n = line.length;
    let tok = '';
    for (; i < n; i++) {
      const c = line[i];
      if (c === '{') {
        if (tok) { this.token(tok, out); tok = ''; }
        const close = line.indexOf('}', i + 1);
        if (close < 0) { this.inComment = true; return; }
        i = close;
      } else if (c === ';') {
        if (tok) { this.token(tok, out); tok = ''; }
        return;
      } else if (c === '(') {
        if (tok) { this.token(tok, out); tok = ''; }
        this.depth++;
      } else if (c === ')') {
        if (tok) { this.token(tok, out); tok = ''; }
        if (this.depth > 0) this.depth--;
      } else if (c === ' ' || c === '\t') {
        if (tok) { this.token(tok, out); tok = ''; }
      } else {
        tok += c;
      }
    }
    if (tok) this.token(tok, out);
  }

  token(tok, out) {
    if (this.depth > 0) return;
    let result = RESULTS.has(tok) ? tok : RESULT_ALIASES[tok];
    // A double forfeit is written as a result of "0-0" (lichess broadcasts do
    // this), which would otherwise read as castling.
    if (!result && tok === '0-0' && this.game?.headers.Result === '0-0') result = '*';
    if (result) {
      this.ensureGame();
      this.game.result = result;
      this.finish(out);
      return;
    }
    if (tok[0] === '$') return;
    const san = cleanSan(tok);
    if (!san) return;
    this.ensureGame();
    this.game.moves.push(san);
  }

  ensureGame() {
    if (!this.game) this.game = { headers: {}, moves: [], result: null };
  }

  finish(out) {
    const g = this.game;
    if (!g) return;
    this.game = null;
    this.depth = 0;
    if (!g.moves.length && !Object.keys(g.headers).length) return;
    if (g.result === null) {
      const h = g.headers.Result;
      g.result = RESULTS.has(h) ? h : RESULT_ALIASES[h] || null;
    }
    out.push(g);
  }
}

/**
 * Normalise one movetext token: drop a glued move number (`12.Nf3`, `3...c5`),
 * trailing `!?` annotations and glued NAGs, and write castling with letters.
 * Returns '' for tokens that are not moves (bare move numbers, `...`).
 */
export function cleanSan(tok) {
  let t = tok.replace(/^\d+\.+/, '').replace(/^\.+/, '');
  t = t.replace(/[!?]+$/, '').replace(/\$\d+$/, '').replace(/[!?]+$/, '');
  if (!t) return '';
  if (/^[0oO]-[0oO](-[0oO])?/.test(t)) {
    const long = t.replace(/[+#]+$/, '').length > 3;
    const suffix = /[+#]+$/.exec(t)?.[0] || '';
    return (long ? 'O-O-O' : 'O-O') + suffix;
  }
  return t;
}

function unescapeTag(value) {
  return value.replace(/\\(["\\])/g, '$1');
}

/** Parse a whole PGN string at once. */
export function parsePgn(text) {
  const parser = new PgnParser();
  const games = parser.push(text);
  return games.concat(parser.end());
}

/** "2024.03.05" (PGN) -> "2024-03-05"; unknown parts (`??`) are kept. */
export function normalizeDate(headers) {
  const raw = headers.UTCDate && !/^\?/.test(headers.UTCDate) ? headers.UTCDate : headers.Date || headers.UTCDate || '';
  if (!raw || /^\?+\.\?+\.\?+$/.test(raw)) return null;
  return raw.replace(/\./g, '-');
}
