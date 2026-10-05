import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgnParser, parsePgn, cleanSan, normalizeDate } from '../shared/pgn.js';

// Two games in the lichess export format: clock and eval comments, numbered
// Black moves, a result at the end.
const LICHESS = `[Event "Rated Blitz game"]
[Site "https://lichess.org/abcd1234"]
[Date "2024.03.05"]
[White "alice"]
[Black "bob"]
[Result "1-0"]
[UTCDate "2024.03.05"]
[UTCTime "18:02:11"]
[WhiteElo "2105"]
[BlackElo "2088"]
[Variant "Standard"]
[TimeControl "180+0"]
[ECO "B20"]
[Opening "Sicilian Defense"]
[Termination "Normal"]

1. e4 { [%eval 0.17] [%clk 0:03:00] } 1... c5 { [%eval 0.19] [%clk 0:03:00] } 2. Nf3 { [%eval 0.25] [%clk 0:02:59] } 2... d6 { [%eval 0.3] [%clk 0:02:58] } 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 1-0

[Event "Rated Blitz game"]
[Site "https://lichess.org/efgh5678"]
[Date "2024.03.06"]
[White "bob"]
[Black "alice"]
[Result "0-1"]

1. d4 d5 2. c4 e6 3. Nc3 Nf6 0-1
`;

test('parses lichess exports: headers, moves without comments, results', () => {
  const games = parsePgn(LICHESS);
  assert.equal(games.length, 2);
  const [a, b] = games;
  assert.equal(a.headers.White, 'alice');
  assert.equal(a.headers.Site, 'https://lichess.org/abcd1234');
  assert.deepEqual(a.moves, ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  assert.equal(a.result, '1-0');
  assert.deepEqual(b.moves, ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6']);
  assert.equal(b.result, '0-1');
  assert.equal(b.headers.ECO, undefined);
});

test('the same games come out whatever the chunking', () => {
  const whole = parsePgn(LICHESS);
  for (const size of [1, 2, 3, 7, 13, 64, 1000]) {
    const parser = new PgnParser();
    let games = [];
    for (let i = 0; i < LICHESS.length; i += size) games = games.concat(parser.push(LICHESS.slice(i, i + size)));
    games = games.concat(parser.end());
    assert.deepEqual(games, whole, `chunk size ${size}`);
  }
  // random chunking
  for (let round = 0; round < 20; round++) {
    const parser = new PgnParser();
    let games = [];
    let i = 0;
    while (i < LICHESS.length) {
      const n = 1 + Math.floor(Math.random() * 40);
      games = games.concat(parser.push(LICHESS.slice(i, i + n)));
      i += n;
    }
    games = games.concat(parser.end());
    assert.deepEqual(games, whole);
  }
});

test('comments, variations, NAGs, annotations, escape lines, CRLF and a BOM', () => {
  const text = '﻿%this is an escape line\r\n[Event "Annotated"]\r\n[White "He said \\"hi\\""]\r\n[Result "1/2-1/2"]\r\n\r\n'
    + '1. e4 $1 e5!? ; a line comment with 2. Nf3 in it\r\n'
    + '2. Nf3 {a comment\r\nspanning lines with (parens) and 3. Bc4 inside} 2... Nc6 (2... Nf6 {Petrov} 3. Nxe5 (3. Nc3 Nc6) d6) 3.Bb5 a6?? 4. Ba4 {[%clk 0:01:00]} 1/2\r\n';
  const games = parsePgn(text);
  assert.equal(games.length, 1);
  const g = games[0];
  assert.equal(g.headers.White, 'He said "hi"');
  assert.deepEqual(g.moves, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4']);
  assert.equal(g.result, '1/2-1/2');
});

test('games without headers, without results, and headers only', () => {
  const text = `1. e4 e5 2. Nf3 *
1. d4 d5 1-0

[White "x"]
[Black "y"]

1. c4 c5

[White "p"]
[Black "q"]
[Result "0-1"]

[White "r"]
[Black "s"]
[Result "*"]

1. f4
`;
  const games = parsePgn(text);
  assert.equal(games.length, 5);
  assert.deepEqual(games[0].moves, ['e4', 'e5', 'Nf3']);
  assert.equal(games[0].result, '*');
  assert.deepEqual(games[1].moves, ['d4', 'd5']);
  assert.equal(games[1].result, '1-0');
  assert.equal(games[2].headers.White, 'x');
  assert.deepEqual(games[2].moves, ['c4', 'c5']);
  assert.equal(games[2].result, null, 'no result token and no Result header');
  assert.equal(games[3].headers.White, 'p');
  assert.deepEqual(games[3].moves, []);
  assert.equal(games[3].result, '0-1', 'taken from the header when there is no result token');
  assert.equal(games[4].headers.White, 'r');
  assert.deepEqual(games[4].moves, ['f4']);
});

test('an unbalanced variation or comment does not swallow the next game', () => {
  const text = `[White "broken"]

1. e4 (1. d4 d5 2. c4 1-0

[White "fine"]

1. c4 e5 1-0

[White "unclosed comment"]

1. e4 { never closed
[White "after"]

1. g3 1-0
`;
  const games = parsePgn(text);
  assert.deepEqual(games.map((g) => g.headers.White), ['broken', 'fine', 'unclosed comment', 'after']);
  assert.deepEqual(games[0].moves, ['e4']);
  assert.deepEqual(games[1].moves, ['c4', 'e5']);
  assert.deepEqual(games[3].moves, ['g3']);
});

test('cleanSan normalises castling, glued move numbers and annotations', () => {
  assert.equal(cleanSan('0-0'), 'O-O');
  assert.equal(cleanSan('0-0-0+'), 'O-O-O+');
  assert.equal(cleanSan('O-O!'), 'O-O');
  assert.equal(cleanSan('12.Nf3'), 'Nf3');
  assert.equal(cleanSan('3...c5'), 'c5');
  assert.equal(cleanSan('12.'), '');
  assert.equal(cleanSan('...'), '');
  assert.equal(cleanSan('Qxf7#!!'), 'Qxf7#');
  assert.equal(cleanSan('e4!?$14'), 'e4');
  assert.equal(cleanSan('exd8=Q+'), 'exd8=Q+');
});

test('normalizeDate prefers a known UTCDate and drops unknown dates', () => {
  assert.equal(normalizeDate({ Date: '2024.03.05' }), '2024-03-05');
  assert.equal(normalizeDate({ Date: '????.??.??', UTCDate: '2024.03.05' }), '2024-03-05');
  assert.equal(normalizeDate({ Date: '2024.??.??' }), '2024-??-??');
  assert.equal(normalizeDate({ Date: '????.??.??' }), null);
  assert.equal(normalizeDate({}), null);
});
