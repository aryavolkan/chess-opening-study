import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chessResultsTournament, chessResultsUrl, tournamentName, findPgnForm, openGamesUrl, isPrivateAddress, assertPublicHost, parseHttpUrl } from '../server/chess-results.js';

const TOURNAMENT_PAGE = `<!DOCTYPE html><html><head><title>Chess-Results Server Chess-results.com - 23rd Dubai Open 2023 &amp; Festival</title></head>
<body><h2>23rd Dubai Open 2023 &amp; Festival</h2><a href="tnr37569.aspx?lan=1&amp;art=1">Final Ranking</a></body></html>`;

const SEARCH_PAGE = `<html><head><title>Chess-Results.com - Partien</title></head><body>
<form method="post" action="./partieSuche.aspx?lan=1&amp;art=3&amp;tnr=37569" id="F1">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="/wEPDwUKMTIz+abc==" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="/wEdAAx=" />
<table><tr><td>Round from</td><td><input name="ctl00$P1$txt_von" type="text" value="1" id="P1_txt_von" /></td>
<td>to</td><td><input name="ctl00$P1$txt_bis" type="text" value="9" /></td></tr>
<tr><td><select name="ctl00$P1$cb_sort" id="P1_cb_sort"><option value="0">Board</option><option selected="selected" value="1">Round</option></select></td></tr>
<tr><td><input id="P1_chk" type="checkbox" name="ctl00$P1$chk_all" checked="checked" /><input type="checkbox" name="ctl00$P1$chk_other" /></td></tr>
</table>
<input type="submit" name="ctl00$P1$cb_anzeigen" value="Show games" id="P1_cb_anzeigen" />
<input type="submit" name="ctl00$P1$cb_download" value="Download as PGN-File" id="P1_cb_download" />
<input type="reset" name="ctl00$P1$reset" value="Reset" />
</form>176 games found</body></html>`;

const PGN = `[Event "23rd Dubai Open 2023"]
[Site "Dubai"]
[Date "2023.05.20"]
[Round "1.1"]
[White "Müller, Jürgen"]
[Black "Pérez, José"]
[Result "1-0"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 1-0

`;

/** A fetch that serves the fixtures and records what it was asked. */
function fakeChessResults({ search = SEARCH_PAGE, download = () => new Response(Buffer.from(PGN, 'latin1'), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=37569.pgn' } }) } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    assert.equal(init.redirect, 'manual');
    if (u.pathname === '/tnr37569.aspx' && init.method === 'GET') {
      return new Response(TOURNAMENT_PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'ASP.NET_SessionId=abc123; path=/; HttpOnly' } });
    }
    if (u.pathname === '/partieSuche.aspx' && init.method === 'GET') {
      return new Response(search, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (u.pathname === '/partieSuche.aspx' && init.method === 'POST') return download(init);
    return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html' } });
  };
  return { fetch, calls };
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

test('chess-results.com links, numbers and other addresses', () => {
  assert.equal(chessResultsTournament('https://chess-results.com/tnr37569.aspx?lan=1'), 37569);
  assert.equal(chessResultsTournament('http://www.chess-results.com/tnr37569.aspx?lan=1&art=4&turdet=YES'), 37569);
  assert.equal(chessResultsTournament('https://s2.chess-results.com/TNR37569.aspx'), 37569);
  assert.equal(chessResultsTournament('chess-results.com/tnr37569.aspx?lan=1'), 37569, 'without a scheme');
  assert.equal(chessResultsTournament('https://chess-results.com/partieSuche.aspx?lan=1&art=3&tnr=37569'), 37569);
  assert.equal(chessResultsTournament(' 37569 '), 37569);
  assert.equal(chessResultsTournament('https://chess-results.com/fed.aspx?lan=1&fed=ENG'), null);
  assert.equal(chessResultsTournament('https://example.org/tnr37569.aspx'), null, 'another host');
  assert.equal(chessResultsTournament('https://evil-chess-results.com/tnr1.aspx'), null);
  assert.equal(chessResultsTournament('https://lichess.org/api/games.pgn'), null);
  assert.equal(chessResultsTournament(''), null);
  assert.equal(chessResultsUrl(37569), 'https://chess-results.com/tnr37569.aspx?lan=1');
  assert.equal(parseHttpUrl('https://lichess.org/x.pgn').href, 'https://lichess.org/x.pgn');
  assert.throws(() => parseHttpUrl('ftp://x/y'), /http/);
  assert.throws(() => parseHttpUrl('not a url'), /chess-results/);
  assert.throws(() => parseHttpUrl('https://user:pw@example.org/x.pgn'), /credentials/);
});

test('tournament name and the PGN form of the game search page', () => {
  assert.equal(tournamentName(TOURNAMENT_PAGE), '23rd Dubai Open 2023 & Festival');
  assert.equal(tournamentName('<title>Chess-results.com - Partien</title><h2>Name &#39;Here&#39;</h2>'), 'Partien');
  assert.equal(tournamentName('<title>Chess-Results Server Chess-results.com</title><h2>From the <b>heading</b></h2>'), 'From the heading');
  assert.equal(tournamentName('<p>nothing</p>'), null);

  const form = findPgnForm(SEARCH_PAGE);
  assert.ok(form);
  assert.equal(form.action, './partieSuche.aspx?lan=1&art=3&tnr=37569');
  assert.equal(form.method, 'POST');
  const b = form.body;
  assert.equal(b.get('__VIEWSTATE'), '/wEPDwUKMTIz+abc==');
  assert.equal(b.get('__EVENTVALIDATION'), '/wEdAAx=');
  assert.equal(b.get('ctl00$P1$txt_von'), '1');
  assert.equal(b.get('ctl00$P1$txt_bis'), '9');
  assert.equal(b.get('ctl00$P1$cb_sort'), '1', 'the selected option');
  assert.equal(b.get('ctl00$P1$chk_all'), 'on', 'checked boxes are sent');
  assert.equal(b.has('ctl00$P1$chk_other'), false);
  assert.equal(b.get('ctl00$P1$cb_download'), 'Download as PGN-File', 'the PGN button is pressed');
  assert.equal(b.has('ctl00$P1$cb_anzeigen'), false, 'the other button is not');
  assert.equal(b.has('ctl00$P1$reset'), false);

  // a LinkButton (javascript postback) instead of a submit button
  const link = findPgnForm(`<form action="x.aspx"><input type="hidden" name="__VIEWSTATE" value="v"><input type="hidden" name="__EVENTTARGET" value="">
    <a id="P1_lnk" href="javascript:__doPostBack('ctl00$P1$lnk_pgn','')">Download as <b>PGN</b>-File</a></form>`);
  assert.equal(link.body.get('__EVENTTARGET'), 'ctl00$P1$lnk_pgn');
  assert.equal(link.body.get('__EVENTARGUMENT'), '');
  // a <button>
  const btn = findPgnForm('<form><button type="submit" name="dl" value="pgn">Download</button></form>');
  assert.equal(btn.body.get('dl'), 'pgn');
  // no games: nothing to press
  assert.equal(findPgnForm('<form><input type="hidden" name="__VIEWSTATE" value="v"><input type="submit" name="show" value="Show games"></form>'), null);
  assert.equal(findPgnForm('<p>Keine Partien</p>'), null);
});

test('a tournament is fetched by replaying the game search form with its cookies', async () => {
  const { fetch, calls } = fakeChessResults();
  const opened = await openGamesUrl('https://chess-results.com/tnr37569.aspx?lan=1&art=1', { fetch });
  assert.equal(opened.name, '23rd Dubai Open 2023 & Festival');
  assert.equal(opened.source, 'https://chess-results.com/tnr37569.aspx?lan=1');
  assert.equal(opened.tournament, 37569);
  const bytes = await readAll(opened.body);
  assert.deepEqual(bytes, Buffer.from(PGN, 'latin1'), 'the body is streamed as served');
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url}`), [
    'GET https://chess-results.com/tnr37569.aspx?lan=1',
    'GET https://chess-results.com/partieSuche.aspx?lan=1&art=3&tnr=37569',
    'POST https://chess-results.com/partieSuche.aspx?lan=1&art=3&tnr=37569',
  ]);
  const post = calls[2].init;
  assert.equal(post.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(post.headers.Cookie, 'ASP.NET_SessionId=abc123', 'the session cookie from the first page is sent back');
  assert.equal(calls[1].init.headers.Cookie, 'ASP.NET_SessionId=abc123');
  const body = new URLSearchParams(post.body);
  assert.equal(body.get('__VIEWSTATE'), '/wEPDwUKMTIz+abc==');
  assert.equal(body.get('ctl00$P1$cb_download'), 'Download as PGN-File');
  assert.ok(/chess-opening-study/.test(post.headers['User-Agent']));

  // a bare number is the same tournament
  const again = await openGamesUrl('37569', { fetch: fakeChessResults().fetch });
  assert.equal(again.tournament, 37569);
  again.body.destroy();
});

test('tournaments without games, and a site that answers with a page instead of a PGN', async () => {
  const noGames = fakeChessResults({ search: SEARCH_PAGE.replace(/<input type="submit" name="ctl00\$P1\$cb_download"[^>]*>/, '') });
  await assert.rejects(openGamesUrl('https://chess-results.com/tnr37569.aspx', { fetch: noGames.fetch }), (err) => {
    assert.equal(err.status, 404);
    assert.match(err.message, /23rd Dubai Open 2023 & Festival.*no games/);
    return true;
  });
  const html = fakeChessResults({ download: () => new Response('<html>error</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(openGamesUrl('https://chess-results.com/tnr37569.aspx', { fetch: html.fetch }), /did not return the games/);
  const down = fakeChessResults({ download: () => new Response('', { status: 500, headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(openGamesUrl('https://chess-results.com/tnr37569.aspx', { fetch: down.fetch }), (err) => err.status === 502 && /answered 500/.test(err.message));
  const unreachable = async () => { throw new TypeError('fetch failed', { cause: new Error('ENOTFOUND') }); };
  await assert.rejects(openGamesUrl('https://chess-results.com/tnr1.aspx', { fetch: unreachable }), /could not reach chess-results.com: ENOTFOUND/);
});

test('any other address is fetched as a PGN file, following redirects, public hosts only', async () => {
  const lookup = async (host) => {
    if (host === 'files.example.org' || host === 'cdn.example.org') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'intranet.example.org') return [{ address: '10.1.2.3', family: 4 }];
    throw new Error('ENOTFOUND');
  };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    if (url === 'https://files.example.org/open/round-3.pgn.gz') return new Response(null, { status: 302, headers: { Location: 'https://cdn.example.org/r3.pgn' } });
    if (url === 'https://cdn.example.org/r3.pgn') return new Response(PGN, { status: 200, headers: { 'Content-Type': 'application/x-chess-pgn' } });
    if (url === 'https://files.example.org/page') return new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    if (url === 'https://files.example.org/inside') return new Response(null, { status: 302, headers: { Location: 'http://intranet.example.org/x.pgn' } });
    if (url === 'https://files.example.org/loop') return new Response(null, { status: 302, headers: { Location: 'https://files.example.org/loop' } });
    return new Response('nope', { status: 404 });
  };
  const opened = await openGamesUrl('https://files.example.org/open/round-3.pgn.gz', { fetch, lookup });
  assert.equal(opened.name, 'round-3', 'named after the file');
  assert.equal(opened.source, 'https://files.example.org/open/round-3.pgn.gz');
  assert.equal(opened.tournament, null);
  assert.equal((await readAll(opened.body)).toString(), PGN);
  assert.deepEqual(calls, ['https://files.example.org/open/round-3.pgn.gz', 'https://cdn.example.org/r3.pgn']);

  await assert.rejects(openGamesUrl('https://files.example.org/page', { fetch, lookup }), /web page, not a PGN/);
  await assert.rejects(openGamesUrl('https://files.example.org/inside', { fetch, lookup }), /public internet addresses/);
  await assert.rejects(openGamesUrl('https://files.example.org/loop', { fetch, lookup }), /too many redirects/);
  await assert.rejects(openGamesUrl('https://files.example.org/missing', { fetch, lookup }), /answered 404/);
  await assert.rejects(openGamesUrl('https://intranet.example.org/x.pgn', { fetch, lookup }), /public internet addresses/);
  await assert.rejects(openGamesUrl('https://nowhere.example.org/x.pgn', { fetch, lookup }), /could not be resolved/);
  await assert.rejects(openGamesUrl('http://127.0.0.1:3000/api/games', { fetch, lookup }), /public internet addresses/);
  await assert.rejects(openGamesUrl('http://localhost/x.pgn', { fetch, lookup }), /public internet addresses/);
  await assert.rejects(openGamesUrl('http://[::1]/x.pgn', { fetch, lookup }), /public internet addresses/);
  await assert.rejects(openGamesUrl('http://169.254.169.254/latest/meta-data', { fetch, lookup }), /public internet addresses/);
  await assert.rejects(openGamesUrl('file:///etc/passwd', { fetch, lookup }), /http/);
  assert.ok(!calls.some((u) => /intranet|127\.0\.0\.1|localhost|::1|169\.254/.test(u)), 'nothing was fetched from the refused addresses');
});

test('private and reserved addresses', async () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'ff02::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  await assert.rejects(assertPublicHost('localhost'), /public/);
  await assert.rejects(assertPublicHost('db.internal'), /public/);
  await assert.rejects(assertPublicHost('server'), /public/, 'a bare host name');
  await assertPublicHost('93.184.216.34');
  await assertPublicHost('example.org', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  await assert.rejects(assertPublicHost('example.org', { lookup: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }] }), /public/, 'every address must be public');
  await assert.rejects(assertPublicHost('example.org', { lookup: async () => [] }), /public/);
});
