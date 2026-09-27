// Chessground board bound to a chess.js game. The app owns the move list;
// the board only renders a position and reports the user's moves.

import { Chessground } from '/vendor/chessground/chessground.min.js';

export function createBoard(el, { onMove }) {
  const cg = Chessground(el, {
    coordinates: true,
    animation: { duration: 150 },
    movable: { free: false, color: undefined, showDests: true },
    draggable: { showGhost: true },
    drawable: { enabled: true, visible: true },
    highlight: { lastMove: true, check: true },
    premovable: { enabled: false },
  });

  function destsFor(chess) {
    const dests = new Map();
    for (const m of chess.moves({ verbose: true })) {
      if (!dests.has(m.from)) dests.set(m.from, []);
      dests.get(m.from).push(m.to);
    }
    return dests;
  }

  return {
    cg,
    /** Render `chess` (a chess.js instance). */
    set(chess, { lastMove = null, orientation = 'white', movable = true, shapes = [] } = {}) {
      const turn = chess.turn() === 'w' ? 'white' : 'black';
      cg.set({
        fen: chess.fen(),
        orientation,
        turnColor: turn,
        check: chess.inCheck(),
        lastMove: lastMove ? [lastMove.from, lastMove.to] : undefined,
        movable: {
          free: false,
          color: movable ? turn : undefined,
          dests: movable ? destsFor(chess) : new Map(),
          events: {
            after: (orig, dest) => onMove(orig, dest),
          },
        },
      });
      cg.setAutoShapes(shapes);
    },
    setShapes(shapes) {
      cg.setAutoShapes(shapes);
    },
    shake() {
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
    },
  };
}
