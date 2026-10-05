import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { openDb } from '../server/db.js';
import { loadOpenings } from '../server/openings.js';
import { Importer, replayGame, makeCache, familyOf, clampPlies } from '../server/games.js';
import { findNode } from '../shared/book.js';
import { epdOf } from '../shared/fen.js';

let book;
before(() => { book = loadOpenings(); });

const game = (white, black, result, moves, extra = '') => `[Event "Test"]
[Site "https://example.org/${white}-${black}-${moves.length}"]
[Date "2024.01.${String(1 + (moves.length % 28)).padStart(2, '0')}"]
[White "${white}"]
[Black "${black}"]
[Result "${result}"]
${extra}
${moves} ${result}

`;

const NAJDORF = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3 Be6 8. f3 Be7';
const DRAGON = '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6 6. Be3 Bg7';
const QGD = '1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7';
const TRANSPOSED_NAJDORF = '1. e4 c5 2. Nf3 d6 3. Nc3 Nf6 4. d4 cxd4 5. Nxd4 a6'; // same position as the Najdorf after 5...a6

const PGN = game('me', 'opp1', '1-0', NAJDORF, '[WhiteElo "2000"]\n[BlackElo "1950"]\n[ECO "B90"]')
  + game('opp2', 'me', '0-1', DRAGON)
  + game('me', 'opp3', '1/2-1/2', QGD)
  + game('opp4', 'Me', '1-0', TRANSPOSED_NAJDORF)
  + game('x', 'y', '*', '1. e4 e5 2. Nf3 Nc6 3. Bb5');

async function importText(importer, text, opts = {}) {
  return importer.importStream(Readable.from([Buffer.from(text)]), { name: 'test', ...opts });
}

test('replayGame follows the book, normalises SAN and reports where the game left the book', () => {
  const cache = makeCache(book);
  const r = replayGame(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'h3', 'e5'], { cache, maxPlies: 40 });
  assert.equal(r.invalidAt, null);
  assert.equal(r.sans.length, 12);
  assert.equal(r.epds.length, 13);
  const najdorf = findNode(book.root, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  assert.equal(r.epds[10], najdorf.epd, 'positions agree with the book (computed by chess.js)');
  assert.match(r.bookNode.name, /Najdorf/);
  // sloppy input: zeros for castling were normalised by the parser, but chessops also gets `+` wrong-free SAN
  // a transposition reaches a named book position by another move order
  const rt = replayGame(['e4', 'c5', 'Nf3', 'd6', 'Nc3', 'Nf6', 'd4', 'cxd4', 'Nxd4', 'a6'], { cache, maxPlies: 40 });
  assert.equal(rt.bookNode.name, 'Sicilian Defense: Najdorf Variation');
  assert.equal(rt.bookNode.ply, 10);
  const r2 = replayGame(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ngf3'], { cache, maxPlies: 40 });
  assert.equal(r2.invalidAt, 6, 'the over-disambiguated knight move is illegal here (the knight is already on f3)');
  const r3 = replayGame(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O'], { cache, maxPlies: 40 });
  assert.deepEqual(r3.sans.slice(-1), ['O-O']);
  // the cache now holds the shared prefix, and a game that reuses it gets the same positions
  const r4 = replayGame(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'], { cache, maxPlies: 40 });
  assert.deepEqual(r4.epds, r.epds.slice(0, 11));
  assert.ok(cache.size > 0);
  // maxPlies caps the replay
  const r5 = replayGame(r.sans, { cache, maxPlies: 10 });
  assert.equal(r5.sans.length, 10);
  assert.equal(r5.epds.length, 11);
  // chess.js fallback for SAN chessops rejects
  const r6 = replayGame(['Pe4', 'e5'], { cache: makeCache(book), maxPlies: 40 });
  assert.deepEqual(r6.sans, ['e4', 'e5']);
  // invalid first move
  const r7 = replayGame(['Z0', 'e5'], { cache: makeCache(book), maxPlies: 40 });
  assert.equal(r7.invalidAt, 0);
  assert.equal(r7.sans.length, 0);
});

test('import stores games, classifies them by the book and indexes positions', async () => {
  const store = openDb();
  const importer = new Importer({ store, book });
  const progress = [];
  const record = await importText(importer, PGN, { player: 'me', onProgress: (p) => progress.push(p) });
  assert.equal(record.games, 5);
  assert.equal(record.duplicates, 0);
  assert.equal(record.invalid, 0);
  assert.equal(record.player, 'me');
  assert.equal(record.finished, true);
  assert.ok(record.positions > 5 * 6);
  assert.ok(progress.length >= 1);
  assert.equal(importer.status(), null);

  const total = store.gamesTotal();
  assert.equal(total.games, 5);
  assert.equal(total.plies, 40, 'depth of the position index');

  // position counts, with transpositions merged by position
  const najdorf = findNode(book.root, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  let s = store.positionStats(najdorf.epd);
  assert.deepEqual(s, { games: 2, white: 2, draws: 0, black: 0 });
  const sicilian = findNode(book.root, ['e4', 'c5']);
  s = store.positionStats(sicilian.epd);
  assert.deepEqual(s, { games: 3, white: 2, draws: 0, black: 1 });
  assert.equal(store.positionStats('8/8/8/8/8/8/8/8 w - -'), null);
  const start = epdOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(store.positionStats(start).games, 5);
  const many = store.positionStatsMany([start, sicilian.epd, 'nope']);
  assert.deepEqual(Object.keys(many).sort(), [sicilian.epd, start].sort());

  // the player's perspective, case-insensitive, and per colour
  s = store.positionStats(start, { player: 'ME' });
  assert.deepEqual(s, { games: 4, white: 2, draws: 1, black: 1, wins: 2, losses: 1 }, 'the transposed Najdorf was lost as Black');
  s = store.positionStats(start, { player: 'me', color: 'black' });
  assert.deepEqual(s, { games: 2, white: 1, draws: 0, black: 1, wins: 1, losses: 1 });

  // moves played from a position
  const after4 = findNode(book.root, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3']);
  const moves = store.positionMoves(after4.epd);
  assert.deepEqual(moves.map((m) => [m.san, m.games]), [['a6', 2], ['g6', 1]]);
  assert.equal(store.positionMoves(start).length, 2);

  // games at a position, with the ply at which each reached it
  const at = store.listGames({ epd: najdorf.epd });
  assert.equal(at.total, 2);
  assert.deepEqual(at.games.map((g) => g.atPly).sort(), [10, 10]);
  assert.ok(at.games.every((g) => /Najdorf/.test(g.book.name)));
  const atWhite = store.listGames({ epd: najdorf.epd, player: 'me', color: 'white' });
  assert.equal(atWhite.total, 1);
  assert.equal(atWhite.games[0].whiteElo, 2000);
  assert.equal(atWhite.games[0].eco, 'B90');

  // full game
  const g = store.getGame(atWhite.games[0].id);
  assert.equal(g.moves.length, 16);
  assert.deepEqual(g.moves.slice(0, 3), ['e4', 'c5', 'Nf3']);
  assert.equal(g.result, '1-0');
  assert.equal(store.getGame(9999), null);

  // openings summary
  const byOpening = store.openingsSummary({ by: 'opening' });
  assert.equal(byOpening.total.games, 5);
  assert.equal(byOpening.groups.length, 5);
  const naj = byOpening.groups.find((g) => g.name === 'Sicilian Defense: Najdorf Variation');
  assert.equal(naj.games, 1, 'the transposed game');
  assert.equal(naj.eco, 'B90');
  assert.deepEqual(naj.path, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  assert.ok(byOpening.groups.find((g) => /Najdorf Variation, English Attack/.test(g.name)), 'the longer game is classified by the deepest named position it reached');
  const byFamily = store.openingsSummary({ by: 'family', player: 'me' });
  assert.equal(byFamily.total.games, 4);
  assert.equal(byFamily.groups[0].name, 'Sicilian Defense');
  assert.equal(byFamily.groups[0].games, 3);
  assert.equal(byFamily.groups[0].wins, 2);
  assert.equal(byFamily.groups[0].losses, 1);
  assert.deepEqual(byFamily.groups[0].path, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'], 'the shortest book line among the games of the group');
  const byEco = store.openingsSummary({ by: 'eco' });
  assert.ok(byEco.groups.find((g) => g.eco === 'B90'));
  assert.ok(byEco.groups.find((g) => g.eco === 'D37' || /Queen's Gambit/.test(g.name)));
  assert.throws(() => store.openingsSummary({ by: 'nope' }));

  // list games by classification
  const fam = store.listGames({ family: 'Sicilian Defense' });
  assert.equal(fam.total, 3);
  assert.equal(store.listGames({ name: naj.name }).total, 1);
  assert.equal(store.listGames({ eco: 'B90' }).total, 2);
  assert.equal(store.listGames({ limit: 2 }).games.length, 2);
  assert.equal(store.listGames({ limit: 2, offset: 4 }).games.length, 1);

  // importing the same file again adds nothing
  const again = await importText(importer, PGN);
  assert.equal(again.games, 0);
  assert.equal(again.duplicates, 5);
  assert.equal(store.gamesTotal().games, 5);
  assert.equal(store.listImports().length, 2);

  // delete the empty import, then the real one
  assert.deepEqual(store.deleteImport(again.id), { removed: true, games: 0 });
  assert.deepEqual(store.deleteImport(record.id), { removed: true, games: 5 });
  assert.equal(store.gamesTotal().games, 0);
  assert.equal(store.positionStats(start), null);
  assert.equal(store.deleteImport(999).removed, false);
  store.close();
});

test('gzip input, chunked input, illegal moves, maxPlies and one import at a time', async () => {
  const store = openDb();
  const importer = new Importer({ store, book });
  const text = game('a', 'b', '1-0', NAJDORF) + game('c', 'd', '0-1', '1. e4 e5 2. Qh5 Ke7 3. Qxe5#') + game('e', 'f', '1-0', '1. e4 Z0 2. d4') + game('g', 'h', '*', '1. Z0');
  const gz = gzipSync(Buffer.from(text));
  const chunks = [];
  for (let i = 0; i < gz.length; i += 7) chunks.push(gz.subarray(i, i + 7));
  const r = await importer.importStream(Readable.from(chunks), { name: 'gz', maxPlies: 10 });
  assert.equal(r.games, 3, 'the game whose first move is illegal is dropped');
  assert.equal(r.invalid, 2);
  assert.equal(r.plies, 10);
  assert.equal(r.bytes, Buffer.byteLength(text), 'bytes are counted after decompression');
  const g = store.listGames({ player: 'e' }).games[0];
  assert.equal(g.plies, 1, 'truncated at the illegal move');
  const full = store.listGames({ player: 'a' }).games[0];
  assert.equal(full.plies, 16, 'moves beyond maxPlies are kept on the game');
  assert.equal(store.getGame(full.id).moves.length, 16);
  const najdorf = findNode(book.root, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  assert.equal(store.positionStats(najdorf.epd).games, 1, 'ply 10 is the last indexed position');
  assert.deepEqual(store.positionMoves(najdorf.epd), [], 'no move is recorded from the last indexed ply');
  const ply12 = findNode(book.root, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Be3', 'e5']);
  assert.ok(ply12);
  assert.equal(store.positionStats(ply12.epd), null, 'beyond maxPlies, not indexed');
  const ply6 = findNode(book.root, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4']);
  assert.equal(store.positionStats(ply6.epd).games, 1);
  assert.deepEqual(store.positionMoves(ply6.epd).map((m) => m.san), ['Nxd4']);

  // only one import at a time
  let release;
  const slow = new Readable({ read() {} });
  const running = importer.importStream(slow, { name: 'slow' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(importer.status());
  assert.equal(importer.status().name, 'slow');
  await assert.rejects(importText(importer, text), /already running/);
  slow.push(Buffer.from(game('p', 'q', '1-0', '1. d4 d5')));
  slow.push(null);
  const done = await running;
  assert.equal(done.games, 1);
  assert.equal(importer.status(), null);
  void release;

  // a stream that errors keeps what was imported and records the error
  const bad = new Readable({ read() {} });
  const p = importer.importStream(bad, { name: 'bad' });
  bad.push(Buffer.from(game('r', 's', '1-0', '1. c4 c5')));
  await new Promise((r) => setTimeout(r, 10));
  bad.destroy(new Error('boom'));
  const partial = await p;
  assert.equal(partial.games, 1);
  assert.match(partial.error, /boom/);
  // a stream that errors before any game is a failure
  const empty = new Readable({ read() {} });
  const p2 = importer.importStream(empty, { name: 'empty' });
  empty.destroy(new Error('nothing'));
  await assert.rejects(p2, /nothing/);
  assert.equal(store.listImports().filter((i) => i.name === 'empty').length, 0);
  // no games at all is fine: an empty import
  const none = await importText(importer, '\n\n');
  assert.equal(none.games, 0);
  store.close();
});

test('helpers', () => {
  assert.equal(familyOf('Sicilian Defense: Najdorf Variation'), 'Sicilian Defense');
  assert.equal(familyOf('Sicilian Defense'), 'Sicilian Defense');
  assert.equal(familyOf(null), null);
  assert.equal(clampPlies(40), 40);
  assert.equal(clampPlies(5), 10);
  assert.equal(clampPlies(500), 80);
  assert.equal(clampPlies('x'), 40);
});
