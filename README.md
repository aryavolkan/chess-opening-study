# Chess Opening Study

[![test](https://github.com/aryavolkan/chess-opening-study/actions/workflows/test.yml/badge.svg)](https://github.com/aryavolkan/chess-opening-study/actions/workflows/test.yml)
[![publish](https://github.com/aryavolkan/chess-opening-study/actions/workflows/publish.yml/badge.svg)](https://github.com/aryavolkan/chess-opening-study/actions/workflows/publish.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hosted web app for exploring chess openings, drilling the variations
you choose, and building up an engine analysis of the whole opening book that
gets deeper the longer you run it.

![Explore view: board, engine lines, book moves and the variation tree](docs/screenshot.png)

## What it does

**Explore.** The full [lichess opening book](https://github.com/lichess-org/chess-openings)
(3,800 named openings, ECO A00 to E99) is loaded as a move tree. Search by
name, ECO code or moves, or click a cell in the ECO map. On the board every
book continuation is drawn as an arrow, listed with its stored engine
evaluation, and the variation tree below the board shows the lines that
branch out from the current position, coloured by evaluation. When any
server or browser engine is analysing a book position, a small pulsing dot
appears on that node so you can watch the shared CPU pool work. Click any
node to jump there; play any move on the board to leave the book and analyse
on your own.

**Study.** Add any line to the study set, to be played as White or as Black.
Drill mode plays the opponent's moves and waits for yours; one wrong move
fails the line for that round, and the expected move is shown as a hint.
Results feed a simple Leitner schedule (boxes with intervals of 1, 3, 7, 14,
30 and 60 days) so "Drill due" always gives you the lines you are most likely
to have forgotten. "All variations below…" adds every named line under a
position in one go.

**Engine analysis.** Stockfish 19 (WASM) runs in a Web Worker in the browser
and analyses whatever position is on the board, three lines at a time. Every
result that is deeper than what the server has stored is saved, so the
analysis you see is never shallower than the last time anyone looked at that
position.

**Stored, improving analysis.** Analysis lives in a SQLite database keyed by
position, so transpositions share it and nothing is ever overwritten by a
shallower result. Two things keep deepening it:

* The **server deepener** runs the same Stockfish build in Node and walks the
  book, shallowest positions first, until every position in scope reaches
  the target depth. Raise the target depth and it carries on from where it
  is. The scope can be the whole book or everything under one position, and
  "deepen from here" pushes the current variation to the front of the queue.
  It resumes automatically when the server restarts.
* Any browser tab can opt in to **also deepen**: a second engine worker pulls
  the shallowest positions from the server and pushes deeper results back.

The Analysis tab shows how much of the book is covered, the depth histogram
and the deepener's progress, and exports everything as JSON.

**Your games.** Import a PGN file on the Games tab (a lichess or chess.com
export, a tournament, a whole database; gzip is fine, and files with tens of
thousands of games are expected) and the app shows which openings it
contains and how they scored: a bar chart of the most played families,
variations or ECO codes with the result split in each bar, an ECO map
coloured by how often each code was played, and the games themselves. Give
your name as it appears in the PGN and every result is shown from your point
of view, as White, as Black or both. The imported games follow you through
the rest of the app: the book moves table shows how often each move was
played and how it went, and lists moves from your games that the book does
not have (so off book you still see what you and your opponents played), the
variation tree draws thicker branches for the lines you played more, and the
position header counts the games that reached the position on the board.
Transpositions count: a position reached by another move order still finds
its games and its opening name. Games are deduplicated across imports, and
each import can be removed again. Positions are indexed for the first 20
moves (configurable); the full game is kept so it can be put on the board.

**Public contributor workers.** On the Analysis tab, anyone can get a token
and run `server/public-worker.js` on their own computer. The worker connects
to the app, pulls the shallowest book positions, analyses them with its own
Stockfish, and pushes the results back into the shared store. No account is
needed; the worker stops itself when idle or after its lifetime. The site
never starts analysis workers of its own: more engine power comes from more
people running this worker.

**Opening explorer.** On the Study tab, queue a search for openings worth
playing: pick a colour, a scope (the whole book or everything under the
position on the board), how many engine workers to run, and the explorer
walks every named opening in scope with a pool of Stockfish processes.
For each one it builds the small repertoire you would actually need: where
it is your move, the engine's best move is the one to learn; where it is the
opponent's move, every reply the engine rates close to best, plus replies
that are common in your imported games, has to be answered. The result table
shows, for each opening, the evaluation and the worst case at the end of
those lines, how many positions you would have to learn, how many distinct
moves that is (system openings repeat the same moves against everything),
how forgiving the positions are (the cost of playing your second-best move),
how much theory the book has below it, how often opponents in your games let
you reach it, and a single 0 to 100 "fit" for "sound and little to learn".
Sort by any of these, click a row to put the line on the board, or add it to
the study set in one click. Jobs run in the background, survive a restart,
can be stopped and resumed, and everything they analyse is stored, so the
rest of the app gets deeper analysis for free.

**Sharing, theme and preferences.** The address bar always holds the
position on the board (`?moves=e4 c5 Nf3`), so a reload or a pasted link
lands on the same position; the copy buttons under the board give you that
link, the moves as PGN, or the position as FEN. The top bar has an
Auto / Light / Dark switch (Auto follows the operating system), and the
engine and book-arrow toggles and the tree depth are remembered by the
browser. Keys: ← → step through the line, Home/End jump to either end, `f`
flips the board.

## Try it in the browser

A browser-only build of the app is published to GitHub Pages
(`scripts/build-pages.js`): the book, board, tree, Stockfish in the browser
and the study set all work, with analysis and the study set kept in
localStorage. Games import, the opening explorer and server deepening need
the server below.

## Running it

Requires Node.js 22.5 or newer (for the built-in SQLite module).

```sh
npm install
npm start
# open http://127.0.0.1:3000
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (set `0.0.0.0` to reach it from another machine) |
| `DB_PATH` | `data/study.sqlite` | Where analysis and the study set are stored |
| `DEEPEN` | unset | `1` starts the server deepener on boot |
| `STOCKFISH_FLAVOR` | `lite-single` | Server engine build: `lite-single`, `lite`, `single`, `full` (the full nets are 94 MB and stronger) |
| `LOG_DEEPEN` | unset | `1` logs every position the deepener finishes |
| `EXPLORE` | unset | `1` starts the opening explorer's queued jobs on boot (they also resume by themselves if they were running) |
| `LOG_EXPLORE` | unset | `1` logs every opening the explorer scores |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BASE_URL`, `ADMIN_EMAILS` | unset | turn on Sign in with Google and accounts; see "Publishing it as a public site" |

Headless deepening without the web server, for example on a machine that is
left running overnight (it shares the database with the server):

```sh
npm run deepen -- --depth 24 --multipv 3 --scope "e4 c5"
```

Import a PGN file without the web server, for example a large archive on the
machine that hosts the app (it shares the database with the server; `.gz` is
detected automatically; `--plies` sets how deep positions are indexed, 40 by
default):

```sh
npm run import-pgn -- games.pgn.gz --name "lichess 2024" --player myname
```

The same import is available over HTTP, which is handy for scripting:

```sh
curl --data-binary @games.pgn 'http://127.0.0.1:3000/api/games/import?name=games&player=myname'
```

Import speed is around 1,300 games per second on one core (positions are
computed with chessops, and games sharing the same first moves share the
work), so a 50,000-game export takes under a minute; the database grows by
about 1.7 MB per 1,000 games with the default 40-ply index. Re-importing a
file is cheap: games that are already stored are skipped before being
replayed.

Refresh the vendored opening book from lichess:

```sh
npm run fetch-openings
```

Tests:

```sh
npm test
```

## Publishing it as a public site

Out of the box the app is a single-user tool: there is no sign-in, anyone
who can reach it owns the study set, the imports and the server engines.
That is right on a laptop or behind a VPN. To put it on the internet, turn
on **Sign in with Google** and it becomes a site with accounts:

| | visitors | signed-in users | admins |
|---|---|---|---|
| opening book, stored analysis, browser engine | yes | yes | yes |
| games and openings that the site shares | yes | yes | yes |
| their own study set and drills | | yes | yes |
| importing games (private to the account) | | yes | yes |
| saving browser analysis to the server, helping the deepener | | yes | yes |
| server deepener, explorer jobs and workers | | | yes |
| sharing an import with everyone | | | yes |

Admins are the Google accounts whose e-mail is in `ADMIN_EMAILS`. The
Olympiad database above, for example, is imported by an admin and then
"shared with everyone" from the Games tab; every visitor sees it, while a
user's own imports stay private (admins cannot see them either).

**1. Create the Google OAuth client.** In the
[Google Cloud console](https://console.cloud.google.com/apis/credentials),
create a project, configure the OAuth consent screen (external, the app
name and your e-mail are enough; the scopes are only `openid`, `email` and
`profile`), then create an OAuth client ID of type *Web application* with
the authorized redirect URI

```
https://<your host>/auth/google/callback
```

**2. Configure the server.** Sign-in is on as soon as these are set:

| Variable | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from the OAuth client |
| `BASE_URL` | the public origin, e.g. `https://study.example.com`; must match the redirect URI |
| `ADMIN_EMAILS` | comma-separated e-mails of the admins |
| `SESSION_SECRET` | optional; signs the short-lived sign-in state cookie (a random one is used otherwise) |
| `MAX_IMPORT_MB` | optional, default 500; an upload larger than this is cut off there |

Sessions are cookies (`HttpOnly`, `SameSite=Lax`, `Secure` on https) backed
by the database and last 30 days; the ID token Google returns is verified
locally against Google's published keys (issuer, audience, expiry, nonce,
PKCE), and cross-site requests to the API are refused. The server never
stores Google tokens, only the account's id, e-mail, name and picture. A
database from before sign-in is migrated in place: its study set, imports
and games belong to the local user, which admins also own, so an admin can
share the imports made before the site went public.

**3. Deploy.** Any host with a persistent disk will do. Run the container
image (see "Deploying without sign-in" below), or `npm start` with Node
22.5+ and `DB_PATH` on the disk, with the variables above, behind a reverse
proxy that terminates HTTPS. With Caddy, for example, `study.example.com { reverse_proxy
localhost:3000 }` is the whole configuration. With Docker Compose, add the
variables to the `environment` block of `docker-compose.yml`.

## Deploying without sign-in

The app is one Node process plus a SQLite file, so it needs a single machine
with a persistent disk; it is not a static site. Without the Google
variables it has no authentication: anyone who can reach it can edit the
study set and drive the server engine, so keep it on your own machine or
behind a VPN or Tailscale, or publish it with sign-in as above.

**Container image.** Every push to `main` runs the tests, builds the image,
starts a container and checks that `/api/health`, the page and the engine
WASM are served, then publishes it to GitHub Container Registry
(`.github/workflows/publish.yml`):

```
ghcr.io/aryavolkan/chess-opening-study:latest      # also :sha-<commit>, :<version> on v* tags
```

Run it anywhere with Docker; analysis and the study set live in the
`study-data` volume and survive upgrades:

```sh
docker compose up -d        # http://localhost:3000
```

`docker compose up -d --build` builds from the checkout instead of pulling.
The image binds to `0.0.0.0`, keeps the database at `/data/study.sqlite` and
takes the same environment variables as above (`DEEPEN=1` to keep the server
engine running, `STOCKFISH_FLAVOR=full` for the stronger nets). While the
repository is private, pulling needs `docker login ghcr.io` with a token that
has `read:packages`.

**Anything else.** Any host with Node 22.5+ or a container runtime and a
persistent disk works: set `HOST=0.0.0.0` and point `DB_PATH` at the disk.

## How it fits together

```
data/openings.tsv      lichess chess-openings (CC0), vendored
shared/book.js         TSV -> move trie; used by server and browser
shared/uci.js          UCI parsing, per-multipv accumulator, score helpers
shared/fen.js          EPD keys (FEN without move counters), 64-bit position hash
shared/pgn.js          streaming PGN reader: chunks in, games out
server/openings.js     loads the book, computes the position of every node
server/db.js           SQLite: analysis, study_lines, settings, imports, games, game_positions
server/games.js        PGN import: replay with chessops, classify by book position, index positions
scripts/import-pgn.js  the same import from the command line
server/engine.js       Stockfish in Node with analyse(fen, {depth, multipv})
server/deepener.js     background queue that raises stored depth
server/engine-pool.js  pool of engine worker processes (engine-worker.js) with a request queue
server/explorer.js     opening explorer: job queue, repertoire walk, scoring
server/public-worker-pool.js  contributor workers: tokens, shallow positions out, results in
server/public-worker.js the worker contributors run on their own computers
server/auth.js         Sign in with Google (OpenID Connect), sessions, access checks
server/app.js          static files + sign-in routes + JSON API with access levels
public/                the page: board (chessground), engine worker, tree, drill
public/games.js        Games tab: import, opening chart, ECO frequency map, game list
public/explorer.js     Study tab: explorer jobs, workers and the results table
public/theme.js        Auto / Light / Dark preference, applied before first paint
public/prefs.js        per-browser preferences in localStorage
Dockerfile             image used by docker-compose.yml and the publish workflow
```

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/openings` | the book as `{eco, name, pgn, san[]}` |
| GET | `/api/analysis?epd=` | stored analysis for a position |
| POST | `/api/analysis` | `{epd, depth, lines[]}` – stored only if deeper than what exists |
| POST | `/api/analysis/batch` | `{epds[]}` -> map of stored analysis |
| GET | `/api/analysis/stats` | counts, depth histogram, book coverage |
| GET | `/api/analysis/export` | everything, as JSON |
| GET | `/api/eco` | per-ECO-code coverage for the map |
| GET/POST | `/api/deepen`, `/start`, `/stop`, `/configure`, `/prioritize`, `/next` | server deepener |
| GET/POST/DELETE | `/api/study`, `/api/study/:id`, `/api/study/:id/result` | study set and drill results |
| POST | `/api/games/import?name=&player=&plies=` | body = the PGN (gzip detected); streams, one import at a time |
| GET/DELETE | `/api/games/imports`, `/api/games/imports/:id` | imports, totals and the running import's progress |
| POST | `/api/games/positions` | `{epds[], player?, color?}` -> games / results per position |
| GET | `/api/games/position?epd=` | one position with the moves played from it |
| GET | `/api/games/openings?by=opening\|family\|eco` | games grouped by opening, with results |
| GET | `/api/games?epd=&name=&family=&eco=&player=&color=` | games, most recent first (`atPly` with `epd`) |
| GET | `/api/games/:id` | one game with its moves |
| GET | `/api/explore` | explorer status: workers, current opening, jobs with progress |
| POST/DELETE | `/api/explore/jobs`, `/api/explore/jobs/:id` | queue `{color, scope[], depth, horizon, replies, minGames}`; remove a job and its results |
| POST | `/api/explore/start`, `/api/explore/stop` | start the worker pool (`{workers}`) or stop it; interrupted jobs resume where they were |
| GET | `/api/explore/results?job=` | scored openings, best fit first |
| GET | `/auth/me` | `{mode, user, admin}`; `/auth/google` starts sign-in, `/auth/google/callback` finishes it, `POST /auth/logout` ends the session |
| POST | `/api/games/imports/:id/share` | `{shared}`: make an import visible to everyone (admins) |
| GET/POST | `/api/public-workers`, `/api/public-workers/join` | contributor worker counts; get a worker token |
| POST | `/api/public-workers/worker/next`, `/progress`, `/result`, `/bye` | what a contributor worker calls, with its bearer token |

With sign-in on, routes that change per-user data need a session (401
otherwise), the engine routes need an admin (403), and `/api/games/imports`
answers with `canImport` and `canShare` for the viewer; game queries only
ever return games the viewer may see.

Game queries take `player=` (a name as it appears in the PGN, case-insensitive)
and `color=white|black`; results then come with `wins` and `losses` from that
player's point of view in addition to `white`, `draws` and `black`.

Explorer results carry, per opening: `eval` and `worst` (centipawns, your
point of view), `decisions` (positions to learn), `moves` (distinct moves of
yours), `forgiveness` (average centipawns lost by your second-best move),
`theory` (book nodes below), `reach` and `reachSamples` (from the imported
games, when any), and `fit`. Fit starts at 100 and loses up to 50 for a bad
evaluation (half a point per centipawn below zero, the worst case at half
weight), 4 per position to learn beyond the first, and up to 20 for
unforgiving positions (1 per 5 centipawns); a known reach then scales it
towards its square root. The engine workers are separate Node processes (the
WASM engine only initialises on a main thread), one Stockfish each, so set
the worker count to the cores you can spare.

Positions are keyed by EPD (the first four FEN fields). Scores are stored as
the engine reports them, from the side to move's point of view; the UI
converts to White's point of view for display.

## Licences

This project's own code is released under the MIT licence (see `LICENSE`).
It depends on GPL-licensed components that are installed from npm and served
to the browser at runtime: the engine is
[Stockfish.js](https://github.com/nmrugg/stockfish.js) (GPL-3.0) and the
board is [chessground](https://github.com/lichess-org/chessground)
(GPL-3.0-or-later). If you redistribute a bundle that includes them, their
licences apply to that bundle. Move generation uses
[chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause); the PGN
importer replays games with [chessops](https://github.com/niklasf/chessops)
(GPL-3.0-or-later), server side only. The opening
book is the lichess [chess-openings](https://github.com/lichess-org/chess-openings)
data (CC0).
