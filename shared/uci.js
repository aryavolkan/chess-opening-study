// Helpers for talking to a UCI engine. Shared by the browser worker wrapper
// and the server-side deepener, so it must stay free of Node and DOM APIs.

/** Parse one `info ...` line from a UCI engine into an object, or null. */
export function parseInfo(line) {
  if (!line.startsWith('info ')) return null;
  const tokens = line.trim().split(/\s+/);
  const out = {};
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case 'depth': out.depth = Number(tokens[++i]); break;
      case 'seldepth': out.seldepth = Number(tokens[++i]); break;
      case 'multipv': out.multipv = Number(tokens[++i]); break;
      case 'nodes': out.nodes = Number(tokens[++i]); break;
      case 'nps': out.nps = Number(tokens[++i]); break;
      case 'time': out.time = Number(tokens[++i]); break;
      case 'hashfull': out.hashfull = Number(tokens[++i]); break;
      case 'score': {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        if (kind === 'cp' || kind === 'mate') {
          out.score = { type: kind, value };
          // optional bound flags
          if (tokens[i + 1] === 'lowerbound' || tokens[i + 1] === 'upperbound') {
            out.score.bound = tokens[++i];
          }
        }
        break;
      }
      case 'pv':
        out.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      case 'string':
        out.string = tokens.slice(i + 1).join(' ');
        i = tokens.length;
        break;
      case 'currmove': out.currmove = tokens[++i]; break;
      case 'currmovenumber': out.currmovenumber = Number(tokens[++i]); break;
      default: break;
    }
  }
  return out;
}

/** Parse a `bestmove x ponder y` line. */
export function parseBestMove(line) {
  const m = /^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/.exec(line);
  if (!m) return null;
  return { bestmove: m[1] === '(none)' ? null : m[1], ponder: m[2] || null };
}

/**
 * Accumulates `info` lines from a single search into a per-multipv snapshot.
 * Only lines that carry a pv and a score are kept; the newest line for each
 * multipv slot wins, and a new (higher) depth clears older slots so the
 * snapshot always describes one depth.
 */
export class SearchAccumulator {
  constructor() {
    this.depth = 0;
    this.lines = new Map();
    this.nodes = 0;
    this.nps = 0;
    this.time = 0;
  }

  /** @returns {boolean} true if the snapshot changed */
  push(line) {
    const info = parseInfo(line);
    if (!info || !info.pv || !info.score || info.depth === undefined) return false;
    if (info.score.bound) return false; // partial result from aspiration window
    const mpv = info.multipv || 1;
    if (info.depth > this.depth) {
      // Keep lines from the previous depth for slots not yet reported at
      // the new depth; they are replaced as they arrive.
      this.depth = info.depth;
    } else if (info.depth < this.depth) {
      return false;
    }
    this.lines.set(mpv, { multipv: mpv, depth: info.depth, score: info.score, pv: info.pv, seldepth: info.seldepth });
    if (info.nodes) this.nodes = info.nodes;
    if (info.nps) this.nps = info.nps;
    if (info.time) this.time = info.time;
    return true;
  }

  /** Snapshot usable as an analysis record (lines ordered by multipv). */
  snapshot() {
    const lines = [...this.lines.values()].sort((a, b) => a.multipv - b.multipv);
    // The recorded depth is the shallowest depth among the lines, so we
    // never claim a depth some slot has not reached.
    const depth = lines.length ? Math.min(...lines.map((l) => l.depth)) : 0;
    return { depth, lines, nodes: this.nodes, nps: this.nps, time: this.time };
  }
}

/**
 * Convert a score from the side-to-move point of view (as UCI reports it)
 * into White's point of view.
 */
export function scoreForWhite(score, sideToMove) {
  if (!score) return null;
  if (sideToMove === 'w') return { ...score };
  return { ...score, value: -score.value };
}

/** Human readable score, from White's point of view. */
export function formatScore(score) {
  if (!score) return '–';
  if (score.type === 'mate') {
    if (score.value === 0) return '#';
    return (score.value > 0 ? '#' : '#-') + Math.abs(score.value);
  }
  const pawns = score.value / 100;
  return (pawns > 0 ? '+' : '') + pawns.toFixed(2);
}

/**
 * Winning chances for White in [-1, 1], using lichess's logistic curve.
 * Useful for colouring and for the eval bar.
 */
export function winningChances(score) {
  if (!score) return 0;
  if (score.type === 'mate') {
    return score.value > 0 ? 1 : score.value < 0 ? -1 : 0;
  }
  const cp = Math.max(-1000, Math.min(1000, score.value));
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}
