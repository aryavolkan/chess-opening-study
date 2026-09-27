import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpeningsTsv, pgnToSan, sanToPgn, buildBook, findNode, pathOf, leafCount, nearestName, searchOpenings, serialize, ecoIndex } from '../shared/book.js';
import { loadOpenings, positionsUnderPrefix } from '../server/openings.js';

const TSV = `eco\tname\tpgn
B20\tSicilian Defense\t1. e4 c5
B21\tSicilian Defense: Smith-Morra Gambit\t1. e4 c5 2. d4 cxd4 3. c3
B27\tSicilian Defense: Hyperaccelerated Dragon\t1. e4 c5 2. Nf3 g6
C20\tKing's Pawn Game\t1. e4 e5
`;

test('pgnToSan strips move numbers', () => {
  assert.deepEqual(pgnToSan('1. e4 c5 2. Nf3 d6 3. d4 cxd4'), ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4']);
  assert.deepEqual(pgnToSan('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4'), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4']);
});

test('parseOpeningsTsv and buildBook create a trie with names on the right nodes', () => {
  const openings = parseOpeningsTsv(TSV);
  assert.equal(openings.length, 4);
  const root = buildBook(openings);
  assert.equal(root.children.size, 1);
  const sicilian = findNode(root, ['e4', 'c5']);
  assert.equal(sicilian.name, 'Sicilian Defense');
  assert.equal(sicilian.eco, 'B20');
  assert.equal(sicilian.children.size, 2);
  const d4 = findNode(root, ['e4', 'c5', 'd4']);
  assert.equal(d4.name, null);
  assert.deepEqual(nearestName(d4), { name: 'Sicilian Defense', eco: 'B20' });
  assert.deepEqual(pathOf(findNode(root, ['e4', 'c5', 'd4', 'cxd4', 'c3'])), ['e4', 'c5', 'd4', 'cxd4', 'c3']);
  assert.equal(leafCount(root), 3);
  assert.equal(findNode(root, ['d4']), null);
  const ser = serialize(sicilian, 1);
  assert.equal(ser.children.length, 2);
  assert.equal(ser.children[0].children.length, 0);
  assert.equal(ecoIndex(openings).get('B20').length, 1);
});

test('searchOpenings matches every word against eco, name and moves', () => {
  const openings = parseOpeningsTsv(TSV);
  assert.deepEqual(searchOpenings(openings, 'smith'), [1]);
  assert.deepEqual(searchOpenings(openings, 'b2 sicilian').length, 3);
  assert.deepEqual(searchOpenings(openings, 'c5 nf3'), [2]);
  assert.deepEqual(searchOpenings(openings, ''), []);
});

test('the vendored book loads, every move is legal and positions are keyed by EPD', () => {
  const book = loadOpenings();
  assert.ok(book.openings.length > 3000);
  assert.ok(book.positions.length > book.openings.length);
  const start = book.positions.find((p) => p.ply === 0);
  assert.equal(start.epd, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -');
  const najdorf = findNode(book.root, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  assert.ok(najdorf);
  assert.match(najdorf.name, /Najdorf/);
  assert.equal(najdorf.uci, 'a7a6');
  const under = positionsUnderPrefix(book.root, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  assert.ok(under.length > 5);
  assert.ok(under.every((p) => p.san.slice(0, 10).join(' ') === 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'));
  assert.deepEqual(positionsUnderPrefix(book.root, ['h4', 'h5', 'h6']), []);
});

test('sanToPgn numbers White moves and is the inverse of pgnToSan', () => {
  assert.equal(sanToPgn(['e4', 'c5', 'Nf3', 'd6', 'd4']), '1. e4 c5 2. Nf3 d6 3. d4');
  assert.equal(sanToPgn([]), '');
  const pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6';
  assert.equal(sanToPgn(pgnToSan(pgn)), pgn);
});
