// Opening explorer: a queue of jobs, each asking "which openings under this
// position are worth playing as White / as Black, and how much is there to
// learn?". A pool of engine workers does the analysis; this module walks
// the resulting lines and scores every named opening in scope.
//
// For a candidate opening and a colour, a small repertoire tree is built:
// where our side is to move, the engine's best move is the one to learn;
// where the opponent is to move, every reply the engine rates close to best
// (plus replies that are common in the imported games) must be answered.
// From that tree:
//   eval        engine evaluation at the opening's position, our point of view
//   worst       the worst evaluation among the lines' end positions
//   decisions   positions where we must know a move (what has to be memorised)
//   moves       distinct moves of ours in the tree (a "system" opening repeats
//               the same moves against everything, so this stays small)
//   forgiveness average loss, in centipawns, of playing our second-best move
//               instead of the best one (small = the position plays itself)
//   theory      named lines in the book below the opening (how much theory exists)
//   reach       how often opponents in the imported games let us get there
//   fit         0-100, a single number for "sound, little to learn"; see fitScore()
// Analysis goes through the shared store, so everything the explorer looks
// at is available to the rest of the app and nothing is analysed twice.

import { EventEmitter } from 'node:events';
import { Chess } from 'chess.js';
import { EnginePool, clampWorkers } from './engine-pool.js';
import { epdOf, sideToMove } from '../shared/fen.js';
import { findNode, walk, pathOf, nearestName, subtreeSize } from '../shared/book.js';

export const DEFAULTS = { depth: 14, horizon: 6, replies: 3, window: 60, minGames: 0, workers: 2 };
const LIMITS = { depth: [6, 30], horizon: [2, 12], replies: [1, 5], window: [0, 300], minGames: [0, 100000] };
const MATE_CP = 10000;

export class Explorer extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./db.js').Store} o.store
   * @param {object} o.book      loaded book (root nodes carry fen/epd)
   * @param {(size:number) => {start, stop, analyse, resize, status}} [o.createPool]
   */
  constructor({ store, book, createPool = (size) => new EnginePool({ size }) }) {
    super();
    this.store = store;
    this.book = book;
    this.createPool = createPool;
    this.pool = null;
    this.running = false;
    this.stopping = false;
    this.workers = DEFAULTS.workers;
    this.current = null; // { jobId, candidate, done, total }
    this.pending = new Map(); // epd -> Promise of analysis in flight
    this.analysed = 0;
    this.lastError = null;
    this.loop = null;
    this.removed = new Set();
    const saved = store.getSetting('explorer');
    if (saved) {
      this.workers = clampWorkers(saved.workers ?? this.workers);
      this.autoResume = Boolean(saved.running);
    }
  }

  persist() {
    this.store.setSetting('explorer', { workers: this.workers, running: this.running });
  }

  status() {
    return {
      running: this.running,
      stopping: this.stopping,
      workers: this.workers,
      pool: this.pool ? this.pool.status() : null,
      current: this.current,
      analysed: this.analysed,
      lastError: this.lastError,
      jobs: this.store.listExploreJobs(),
    };
  }

  /** Validate and queue a job. */
  addJob(opts = {}) {
    const color = opts.color === 'black' ? 'black' : opts.color === 'white' ? 'white' : null;
    if (!color) throw httpError(400, 'color must be white or black');
    const scope = Array.isArray(opts.scope) ? opts.scope.map(String) : [];
    const node = findNode(this.book.root, scope);
    if (!node) throw httpError(400, 'scope is not a book line');
    const params = {};
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      const v = opts[k] === undefined || opts[k] === null || opts[k] === '' ? DEFAULTS[k] : Number(opts[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) throw httpError(400, `${k} must be an integer between ${lo} and ${hi}`);
      params[k] = v;
    }
    const named = nearestName(node);
    const name = String(opts.name || (scope.length ? `${named ? named.name : scope.join(' ')} as ${color}` : `whole book as ${color}`)).slice(0, 200);
    const total = this.candidates(node, params).length;
    const job = this.store.createExploreJob({ name, color, scope, params, total });
    this.emit('job', job);
    return job;
  }

  removeJob(id) {
    this.removed.add(id);
    return this.store.deleteExploreJob(id);
  }

  /** Named book nodes under `node` (shallowest first), filtered by minGames when games exist. */
  candidates(node, params) {
    const out = [];
    walk(node, (n) => { if (n.name) out.push(n); });
    out.sort((a, b) => a.ply - b.ply);
    if (params.minGames > 0 && this.store.gamesTotal().games > 0) {
      return out.filter((n) => (this.store.positionStats(n.epd)?.games ?? 0) >= params.minGames);
    }
    return out;
  }

  async start({ workers } = {}) {
    if (workers !== undefined) this.workers = clampWorkers(workers);
    if (this.running) {
      if (this.pool) await this.pool.resize(this.workers);
      this.persist();
      return this.status();
    }
    this.running = true;
    this.stopping = false;
    this.lastError = null;
    this.persist();
    try {
      this.pool = this.createPool(this.workers);
      await this.pool.start();
    } catch (err) {
      this.running = false;
      this.pool = null;
      this.lastError = String(err?.message || err);
      this.persist();
      throw err;
    }
    this.loop = this.run().catch((err) => {
      this.lastError = String(err?.message || err);
      this.emit('error', err);
    }).finally(async () => {
      this.running = false;
      this.current = null;
      await this.pool?.stop();
      this.pool = null;
      this.persist();
    });
    return this.status();
  }

  async stop() {
    if (!this.running) return this.status();
    this.stopping = true;
    this.running = false;
    this.persist();
    await this.pool?.stop();
    await this.loop;
    this.stopping = false;
    return this.status();
  }

  async run() {
    while (this.running) {
      const job = this.store.nextExploreJob();
      if (!job) {
        this.emit('idle');
        return;
      }
      await this.runJob(job);
    }
  }

  async runJob(job) {
    const node = findNode(this.book.root, job.scope);
    if (!node) {
      this.store.updateExploreJob(job.id, { status: 'done', error: 'scope is no longer in the book' });
      return;
    }
    const all = this.candidates(node, job.params);
    const have = new Set(this.store.exploreResultPaths(job.id));
    const todo = all.filter((n) => !have.has(pathOf(n).join(' ')));
    this.store.updateExploreJob(job.id, { status: 'running', total: all.length, done: all.length - todo.length, startedAt: true });
    let done = all.length - todo.length;
    for (const candidate of todo) {
      if (!this.running || this.removed.has(job.id)) break;
      this.current = { jobId: job.id, candidate: candidate.name, eco: candidate.eco, path: pathOf(candidate), done, total: all.length };
      let metrics;
      try {
        metrics = await this.exploreCandidate(candidate, job.color, job.params);
      } catch (err) {
        if (!this.running) break;
        throw err;
      }
      if (this.removed.has(job.id)) break;
      this.store.saveExploreResult(job.id, { path: pathOf(candidate), ply: candidate.ply, eco: candidate.eco, name: candidate.name, color: job.color, metrics });
      done++;
      this.store.updateExploreJob(job.id, { done });
      this.emit('result', { jobId: job.id, name: candidate.name, metrics });
    }
    this.current = null;
    if (this.removed.has(job.id)) {
      this.removed.delete(job.id);
      return;
    }
    if (this.running) this.store.updateExploreJob(job.id, { status: 'done', done, finishedAt: true });
    else this.store.updateExploreJob(job.id, { status: 'queued', done });
  }

  /** Stored analysis if deep enough, else from the pool (and stored). */
  async analyse(fen, params) {
    const epd = epdOf(fen);
    const legal = new Chess(fen).moves().length;
    if (legal === 0) return { epd, depth: 0, lines: [], terminal: true };
    const stored = this.store.getAnalysis(epd);
    // Enough lines: as many as we want, or as many as the position has
    if (stored && stored.depth >= params.depth && stored.multipv >= Math.min(Math.max(2, params.replies), legal)) return stored;
    let p = this.pending.get(epd);
    if (!p) {
      p = this.pool.analyse(fen, { depth: params.depth, multipv: Math.max(2, params.replies) }).then((r) => {
        this.analysed++;
        if (!r.lines.length) return { epd, depth: r.depth, lines: [], terminal: true };
        const saved = this.store.saveAnalysis({ epd, depth: r.depth, lines: r.lines, nodes: r.nodes, engine: r.engine, source: 'explorer' });
        return saved.analysis;
      }).finally(() => this.pending.delete(epd));
      this.pending.set(epd, p);
    }
    return p;
  }

  /** Walk the repertoire tree of one opening and measure it. */
  async exploreCandidate(node, color, params) {
    const us = color === 'white' ? 'w' : 'b';
    const seen = new Set();
    const m = { decisions: 0, moves: new Set(), forgiveness: [], worst: Infinity, positions: 0, leaves: 0 };
    const useGames = this.store.gamesTotal().games > 0;

    const visit = async (fen, depthFromRoot) => {
      const epd = epdOf(fen);
      if (seen.has(epd)) return;
      seen.add(epd);
      const a = await this.analyse(fen, params);
      m.positions++;
      const stm = sideToMove(epd);
      if (!a.lines.length) {
        // Checkmate or stalemate: no continuation to learn
        const chess = new Chess(fen);
        const cp = chess.isCheckmate() ? (stm === us ? -MATE_CP : MATE_CP) : 0;
        m.worst = Math.min(m.worst, cp);
        m.leaves++;
        return;
      }
      const ours = (score) => cpFor(score, stm, us);
      if (stm === us) {
        m.decisions++;
        const best = a.lines[0];
        const chess = new Chess(fen);
        const mv = playUci(chess, best.pv[0]);
        if (!mv) return;
        m.moves.add(mv.san);
        if (a.lines[1]) m.forgiveness.push(Math.max(0, ours(best.score) - ours(a.lines[1].score)));
        if (depthFromRoot + 1 >= params.horizon) {
          m.worst = Math.min(m.worst, ours(best.score));
          m.leaves++;
          return;
        }
        await visit(chess.fen(), depthFromRoot + 1);
        return;
      }
      // Opponent to move: every plausible reply needs an answer
      const bestOpp = a.lines[0].score;
      const replies = a.lines
        .filter((l) => cpFor(bestOpp, stm, stm) - cpFor(l.score, stm, stm) <= params.window)
        .slice(0, params.replies)
        .map((l) => ({ uci: l.pv[0], score: l.score }));
      if (useGames) {
        const played = this.store.positionMoves(epd);
        const total = played.reduce((n, p) => n + p.games, 0);
        if (total >= 5) {
          for (const p of played) {
            if (p.games / total < 0.15 || replies.length >= params.replies + 1) break;
            const chess = new Chess(fen);
            const mv = tryMove(chess, p.san);
            if (!mv) continue;
            const uci = mv.from + mv.to + (mv.promotion || '');
            if (!replies.some((r) => r.uci === uci)) replies.push({ uci, score: a.lines.find((l) => l.pv[0] === uci)?.score ?? null });
          }
        }
      }
      if (depthFromRoot + 1 >= params.horizon) {
        for (const r of replies) {
          if (r.score) m.worst = Math.min(m.worst, ours(r.score));
          m.leaves++;
        }
        return;
      }
      await Promise.all(replies.map((r) => {
        const chess = new Chess(fen);
        if (!playUci(chess, r.uci)) return null;
        return visit(chess.fen(), depthFromRoot + 1);
      }));
    };

    const rootAnalysis = await this.analyse(node.fen, params);
    const rootStm = sideToMove(node.epd);
    const evalRoot = rootAnalysis.lines.length ? cpFor(rootAnalysis.lines[0].score, rootStm, us) : 0;
    await visit(node.fen, 0);
    const forgiveness = m.forgiveness.length ? Math.round(m.forgiveness.reduce((a, b) => a + b, 0) / m.forgiveness.length) : null;
    const theory = subtreeSize(node) - 1;
    let games = null;
    let reach = null;
    let reachSamples = null;
    if (useGames) {
      const s = this.store.positionStats(node.epd);
      games = s ? { games: s.games, white: s.white, draws: s.draws, black: s.black } : { games: 0, white: 0, draws: 0, black: 0 };
      ({ reach, samples: reachSamples } = this.reachability(node, us));
    }
    const worst = Number.isFinite(m.worst) ? m.worst : evalRoot;
    const metrics = {
      eval: evalRoot,
      worst,
      decisions: m.decisions,
      moves: m.moves.size,
      forgiveness,
      theory,
      positions: m.positions,
      leaves: m.leaves,
      games,
      reach,
      reachSamples,
      depth: params.depth,
      horizon: params.horizon,
    };
    metrics.fit = fitScore(metrics);
    return metrics;
  }

  /**
   * How often the opponents in the imported games played into this opening:
   * the product, over the opponent's moves on the way there, of how often
   * that move was chosen from that position (steps with fewer than 5 games
   * are skipped). `samples` is the smallest sample along the way.
   */
  reachability(node, us) {
    let reach = 1;
    let samples = Infinity;
    let any = false;
    for (let n = node; n && n.parent; n = n.parent) {
      const parent = n.parent;
      if (sideToMove(parent.epd) === us) continue; // our own move, our own choice
      const played = this.store.positionMoves(parent.epd);
      const total = played.reduce((s, p) => s + p.games, 0);
      if (total < 5) continue;
      const hit = played.find((p) => p.san === n.san)?.games ?? 0;
      reach *= hit / total;
      samples = Math.min(samples, total);
      any = true;
    }
    return any ? { reach: Math.round(reach * 1000) / 1000, samples } : { reach: null, samples: null };
  }
}

/** Score in centipawns from the point of view of `us`, given the side to move it was reported for. */
export function cpFor(score, stm, us) {
  if (!score) return 0;
  let cp = score.type === 'mate' ? (score.value > 0 ? MATE_CP - Math.abs(score.value) : -MATE_CP + Math.abs(score.value)) : score.value;
  if (score.type === 'mate' && score.value === 0) cp = -MATE_CP;
  return stm === us ? cp : -cp;
}

/**
 * 0-100: how well an opening fits "sound and little to learn". Starts from
 * 100, loses up to 50 for a bad evaluation (10 per 20 cp below 0, worst-case
 * line counted at half weight), 4 per position to learn beyond the first,
 * and up to 20 for unforgiving positions (1 per 5 cp lost by the second-best
 * move). A reachability figure, when known, scales the result towards its
 * square root so rare lines are penalised but not erased.
 */
export function fitScore(m) {
  let fit = 100;
  const bad = Math.max(0, -m.eval) + Math.max(0, -m.worst) / 2;
  fit -= Math.min(50, bad / 2);
  fit -= Math.min(40, Math.max(0, m.decisions - 1) * 4);
  if (m.forgiveness !== null && m.forgiveness !== undefined) fit -= Math.min(20, m.forgiveness / 5);
  if (m.reach !== null && m.reach !== undefined) fit *= 0.5 + 0.5 * Math.sqrt(m.reach);
  return Math.max(0, Math.round(fit));
}

function playUci(chess, uci) {
  if (!uci) return null;
  return tryMove(chess, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

function tryMove(chess, move) {
  try {
    return chess.move(move);
  } catch {
    return null;
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
