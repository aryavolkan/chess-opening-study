// Drill controller: plays through study lines, the app supplies the board.
// The user plays their colour; the opponent's book moves are played
// automatically. One wrong move marks the line as failed for this round but
// the drill continues after showing the right move.

export class Drill {
  /**
   * @param {object} hooks
   * @param {(line) => void} hooks.onLineStart
   * @param {(san) => void} hooks.playMove      play a move on the board
   * @param {(san[]) => void} hooks.setLine      reset the board to these moves
   * @param {(msg, kind) => void} hooks.onMessage
   * @param {(line, correct) => Promise<void>} hooks.onLineDone
   * @param {(summary) => void} hooks.onFinish
   * @param {(san|null) => void} hooks.showHint  arrow for the expected move
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.lines = [];
    this.index = -1;
    this.line = null;
    this.ply = 0;
    this.mistakes = 0;
    this.results = [];
    this.active = false;
    this.timer = null;
  }

  start(lines) {
    this.lines = lines;
    this.index = -1;
    this.results = [];
    this.active = true;
    this.next();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    this.line = null;
  }

  next() {
    clearTimeout(this.timer);
    this.index++;
    if (this.index >= this.lines.length) {
      this.active = false;
      this.hooks.onFinish({ results: this.results });
      return;
    }
    this.line = this.lines[this.index];
    this.ply = 0;
    this.mistakes = 0;
    this.hooks.setLine([]);
    this.hooks.onLineStart(this.line, this.index, this.lines.length);
    this.hooks.showHint(null);
    this.maybeAutoPlay();
  }

  /** Whose turn is it at the current ply: 'white' or 'black'. */
  turn() {
    return this.ply % 2 === 0 ? 'white' : 'black';
  }

  userToMove() {
    return this.active && this.line && this.ply < this.line.san.length && this.turn() === this.line.color;
  }

  maybeAutoPlay() {
    if (!this.active || !this.line) return;
    if (this.ply >= this.line.san.length) return this.finishLine();
    if (this.turn() !== this.line.color) {
      this.timer = setTimeout(() => {
        if (!this.active) return;
        this.hooks.playMove(this.line.san[this.ply]);
        this.ply++;
        this.hooks.onMessage(this.ply >= this.line.san.length ? '' : 'Your move', '');
        this.maybeAutoPlay();
      }, 500);
    } else {
      this.hooks.onMessage('Your move', '');
    }
  }

  /** The user played `san`. Returns true if the move was accepted. */
  userMoved(san) {
    if (!this.userToMove()) return false;
    const expected = this.line.san[this.ply];
    if (san === expected) {
      this.ply++;
      this.hooks.showHint(null);
      this.hooks.onMessage(this.ply >= this.line.san.length ? 'Line complete' : 'Correct', 'ok');
      this.maybeAutoPlay();
      return true;
    }
    this.mistakes++;
    this.hooks.onMessage(`Not ${san}. The line continues ${expected}.`, 'bad');
    this.hooks.showHint(expected);
    return false;
  }

  async finishLine() {
    const correct = this.mistakes === 0;
    this.results.push({ line: this.line, correct, mistakes: this.mistakes });
    this.hooks.onMessage(correct ? 'Line complete, no mistakes.' : `Line complete with ${this.mistakes} mistake${this.mistakes > 1 ? 's' : ''}.`, correct ? 'ok' : 'bad');
    await this.hooks.onLineDone(this.line, correct);
    this.timer = setTimeout(() => this.next(), 1400);
  }
}
