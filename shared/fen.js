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

/**
 * 64-bit hash of an EPD as a signed BigInt, the key of the imported-game
 * position index (an 8-byte integer instead of a 60-character string per
 * row). Two mixed 32-bit hashes (cyrb53's construction, both halves kept).
 */
export function epdHash(epd) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < epd.length; i++) {
    const ch = epd.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return BigInt.asIntN(64, (BigInt(h2 >>> 0) << 32n) | BigInt(h1 >>> 0));
}
