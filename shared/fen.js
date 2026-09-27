// Position keys. Analysis is stored per EPD (the first four FEN fields), so
// transpositions and positions reached at different move numbers share it.

export function epdOf(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function sideToMove(fenOrEpd) {
  return fenOrEpd.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** Full FEN from an EPD, with zeroed clocks, for feeding to an engine. */
export function fenFromEpd(epd) {
  const fields = epd.split(' ');
  return fields.slice(0, 4).join(' ') + ' 0 1';
}
