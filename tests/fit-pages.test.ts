import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_WORKER, SITE_HARNESS_WORKERS } from './workers';
import { mintToken, newJti, type Scope } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant';
import { BANNED_PATTERNS } from './candidacy-patterns';

// `/fit` (04 §2, 09 §1): the unlisted, grant-gated page.
//
// Everything asserted here is a property of the SURFACE rather than of the
// gate's implementation, and deliberately so -- the page has no gate of its
// own. It asks the MCP Worker over the `MCP` service binding which tools this
// bearer string unlocks, and `analyze_fit`'s presence in that answer IS the
// access check (src/lib/fit/client.ts). So these tests exercise the real
// boundary (src/lib/tier/grant.ts, workers/mcp/src/gated.ts) end to end rather
// than a second copy of it living on the site.

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });
let db: D1Database;

/**
 * The harness's own origin, sent as `Origin:` on every POST below.
 *
 * MEASURED, not decorative (day 5 Task 13). Astro's `security.checkOrigin` is
 * on by default and this repo does not turn it off, so a form-encoded POST
 * carrying no `Origin` header is answered `403 Cross-site POST form
 * submissions are forbidden` by Astro's own middleware. A browser submitting
 * this form sends the header, so a test that omits it is testing a client that
 * does not exist and never reaches the route it means to.
 *
 * A review argued that 403 was itself a route-existence oracle, on the reading
 * that Astro's `handleRequest` returns its 404 when `!state.routeData` before
 * any middleware, so only a path matching a real on-demand route could produce
 * it. RE-MEASURED in fix round 1, and that is not what this Astro version does:
 * with no `Origin` and no body, `/nope/nope`, `/also-not-a-route`,
 * `/resume.pdf` and `/fit/run` all returned the identical `403 Cross-site POST
 * form submissions are forbidden`, and `PROPFIND /nope` the same sentence with
 * the method substituted. The check runs before routing, on every path.
 *
 * It became an oracle anyway, by a different route, and only after this round
 * added `/fit` to `run_worker_first` (wrangler.jsonc): a path NOT in that list
 * never reaches src/worker.ts, so the Asset Worker answers it with 404.html and
 * the origin check never runs. A cross-site POST then gets a 404 page from
 * `/nope/nope` and a 403 from `/fit/run` -- "this path is Worker-first", which
 * for an unlisted route is as good as "this path is real". src/worker.ts now
 * flattens BOTH refusals to the site's own 404, and `an un-granted /fit is
 * indistinguishable from a path that does not exist` below is what holds it
 * there through whichever of these two mechanisms moves next.
 *
 * The harness artifact worth knowing about, because it is what made the first
 * reading of this look inconsistent: a refusal returned without reading the
 * request body poisons the keep-alive connection, and the IMMEDIATELY FOLLOWING
 * request on it fails with `500 Error: Network connection lost` from
 * miniflare's entry worker. It recovers after one request. That is why the
 * comparison test below sends no request body at all -- the origin check reads
 * headers, not bodies, so an empty POST exercises the same path with nothing
 * left unread.
 */
let origin = '';

beforeAll(async () => {
  const { url } = await server.listen();
  origin = url.origin;
  await server.update({
    workers: SITE_HARNESS_WORKERS.map((worker) =>
      worker === MCP_WORKER
        ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, SITE_ORIGIN: url.origin } }
        : worker,
    ),
  });
  const mcp = server.getWorker<{ DB: D1Database }>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  db = (await mcp.getEnv()).DB;
});
afterAll(async () => {
  await server.close();
});

async function grant(scopes: Scope[] = ['fit']): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1 as const,
    jti: newJti(),
    aud: 'fixture-audience',
    scopes,
    iat: now,
    exp: now + 3600,
  };
  await recordIssue(db, {
    jti: claims.jti,
    audience: claims.aud,
    scopes: claims.scopes,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    revokedAt: null,
    note: 'fit page suite',
  });
  return mintToken(TEST_SIGNING_KEY, claims);
}

test('/fit with no token is a 404, not a 403', async () => {
  // 404, deliberately. A 403 confirms the page exists, and an unlisted page's
  // whole guarantee (09 §1) is that it does not announce itself to anyone
  // holding the URL but not the token.
  const response = await server.fetch('/fit');
  expect(response.status).toBe(404);
});

test('/fit with a garbage token is the same 404', async () => {
  expect((await server.fetch('/fit?t=not-a-token')).status).toBe(404);
});

test('/fit with a token lacking the fit scope is the same 404', async () => {
  const response = await server.fetch(`/fit?t=${await grant(['profile'])}`);
  expect(response.status).toBe(404);
});

test('/fit with a granted token renders the form', async () => {
  const response = await server.fetch(`/fit?t=${await grant()}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('name="target_description"');
  expect(html).toContain('cf-turnstile');
  expect(html).toContain('0x4AAAAAAElhnY8ov3OYHN8m');
});

test('/fit carries its own noindex and a no-referrer policy', async () => {
  // Both survive day 7 removing the SITEWIDE noindex from Base.astro: the
  // meta tag is set by an explicit prop, and the headers are on the response.
  // The referrer policy is load-bearing rather than tidy -- the token is in
  // this page's URL, and the Turnstile widget below loads a script from
  // challenges.cloudflare.com, which without this would carry that URL in its
  // `Referer`.
  const response = await server.fetch(`/fit?t=${await grant()}`);
  expect(response.headers.get('x-robots-tag')).toMatch(/noindex/);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await response.text();
  expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
  // The SECOND delivery of the referrer policy, and the reason `Base.astro`
  // has a `referrer` prop at all: the header above is set in one line of
  // src/worker.ts whose reachability depends on asset routing config. The
  // token's confinement should not rest on one line.
  expect(html).toMatch(/<meta name="referrer" content="no-referrer"/);
});

test('the load-bearing headers are on the 303, not only on the rendered page', async () => {
  // MEASURED AS A GAP in fix round 1: moving both `headers.set` calls in
  // src/worker.ts into the page's success path left every other test green
  // while the 303 lost them. The redirect is a `/fit` response like any other
  // -- it is the one a browser follows straight back to a URL carrying the
  // token -- so it is asserted directly rather than assumed to be covered.
  //
  // The 404 is deliberately NOT in this list: it carries neither header, by
  // design, because carrying them would make it distinguishable from the
  // site's own 404. See the indistinguishability test below.
  const response = await server.fetch('/fit/run', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    redirect: 'manual',
    body: new URLSearchParams({
      t: await grant(),
      target_description: 'A generic description of a target, long enough for the schema. '.repeat(
        6,
      ),
    }).toString(),
  });
  expect(response.status).toBe(303);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-robots-tag')).toMatch(/noindex/);
});

test('an un-granted /fit is indistinguishable from a path that does not exist', async () => {
  // THE WHOLE POINT OF THE PAGE, and status alone does not establish it. Every
  // other refusal test here asserts `status === 404`, which stayed true while
  // the refusals carried a body (`'Not found'`, so `Content-Type:
  // text/plain;charset=UTF-8` and `Content-Length: 9`) and two headers nothing
  // else on this site sets, against a real 404 that is a 5 KB HTML page.
  // `curl -i /fit` against `curl -i /nope` told a prober holding the URL and a
  // dead token that the route was real, and no test noticed.
  //
  // So this compares the WHOLE observable response against the site's own 404.
  // Two different unrouted paths are used as the control on purpose: they must
  // agree with each other as well as with `/fit`, which is what pins
  // src/pages/404.astro rendering nothing derived from the request. Astro's
  // stock 404 -- the one that page replaced -- embeds the requested path, and
  // under it no `/fit` refusal could ever have matched.
  //
  // No request bodies: the origin check reads headers, and an unread body
  // poisons the next request on the connection (see `origin` above).
  // The harness's own init type, not the DOM's: `server.fetch` takes
  // workerd's `RequestInit`, and a DOM-typed literal fails `npm run check` on
  // an incompatible `body`.
  type FetchInit = Parameters<typeof server.fetch>[1];
  const observable = async (path: string, init?: FetchInit) => {
    const response = await server.fetch(path, { redirect: 'manual', ...init });
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length'),
      robots: response.headers.get('x-robots-tag'),
      referrer: response.headers.get('referrer-policy'),
    };
  };
  const control = await observable('/definitely-not-a-route');
  expect(control.status).toBe(404);
  expect(await observable('/nope/nope'), 'the control must not depend on the path').toEqual(
    control,
  );

  // A GET with no token, a GET with a malformed one, and a GET with a token
  // whose grant lacks the scope: the three ways in.
  expect(await observable('/fit')).toEqual(control);
  expect(await observable('/fit?t=not-a-token')).toEqual(control);
  expect(await observable(`/fit?t=${await grant(['profile'])}`)).toEqual(control);

  // And the POST, against an unrouted path taking the same request. This is
  // the pair that caught the second oracle: `/fit/run` is Worker-first and
  // `/nope/nope` is not, so one reached Astro's origin check and answered 403
  // while the other never left the Asset Worker and answered the 404 page.
  // What is asserted is that the two agree, whatever they are -- the day the
  // site stops answering them identically, this fails.
  const post: FetchInit = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  };
  expect(await observable('/fit/run', post)).toEqual(await observable('/nope/nope', post));
});

test('the page copy carries no search language', async () => {
  const html = await (await server.fetch(`/fit?t=${await grant()}`)).text();
  for (const pattern of BANNED_PATTERNS) expect(html).not.toMatch(pattern);
});

test('/fit is absent from every index the site publishes', async () => {
  // The invisibility half of 09 §1's table, asserted against the real
  // documents rather than against the code that builds them.
  for (const route of ['/llms.txt', '/llms-full.txt', '/rss.xml', '/feed.json', '/robots.txt']) {
    const body = await (await server.fetch(route)).text();
    expect(body, `${route} must not mention /fit`).not.toMatch(/\/fit\b/);
  }
  const home = await (await server.fetch('/')).text();
  expect(home).not.toMatch(/href="\/fit/);
});

test('POST /fit/run without a token is a 404', async () => {
  // `redirect: 'manual'`, and it is load-bearing rather than tidy. MEASURED by
  // deleting this route's grant check and re-running: without it the post falls
  // through to the bot check, which refuses and 303s back to `/fit?t=&error=…`
  // -- and `/fit` with an empty token is itself a 404. A following client would
  // therefore still see 404 and the assertion would pass with the gate gone.
  // Asserting on the UNFOLLOWED response is what makes this test a test.
  const response = await server.fetch('/fit/run', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    redirect: 'manual',
    body: new URLSearchParams({ target_description: 'x'.repeat(300) }).toString(),
  });
  expect(response.status).toBe(404);
});

test('POST /fit/run with a token lacking the fit scope is the same 404', async () => {
  // The POST's SCOPE gate, which the no-token test above does not reach.
  // MEASURED in fix round 1: deleting only `if (!tools.has('analyze_fit'))`
  // from src/pages/fit/run.ts left every test green -- one sent no token at
  // all and the other two sent valid `fit` grants, so nothing exercised the
  // difference between "has a grant" and "has THIS grant". This mirrors the
  // GET case, because the guarantee has to hold on both verbs or it is one
  // route wide.
  const response = await server.fetch('/fit/run', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    redirect: 'manual',
    body: new URLSearchParams({
      t: await grant(['profile']),
      target_description: 'A generic description of a target, long enough for the schema. '.repeat(
        6,
      ),
      turnstile_response: 'stubbed',
    }).toString(),
  });
  expect(response.status).toBe(404);
});

test('POST /fit/run without a bot-check response never reaches the engine', async () => {
  // The Turnstile refusal branch. It is reachable at all only because the
  // `'stub'` seam (src/lib/turnstile.ts) still enforces the LOCAL
  // missing-token check and skips only the Secrets Store read and the
  // network call -- which is what the real service does too, and what makes
  // this branch testable without either.
  //
  // The assertion that matters is the SENTENCE: a refusal here must be the
  // bot check's, not the engine's, because the order in src/pages/fit/run.ts
  // is what keeps a form post from spending a tool call it has not earned.
  const token = await grant();
  const response = await server.fetch('/fit/run', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    redirect: 'manual',
    body: new URLSearchParams({
      t: token,
      target_description: 'A generic description of a target, long enough for the schema. '.repeat(
        6,
      ),
    }).toString(),
  });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location')!, 'https://ryanlindsey.me');
  expect(location.pathname).toBe('/fit');
  expect(location.searchParams.get('error')).toMatch(/bot check/i);
  expect(location.searchParams.get('t')).toBe(token);
});

test('POST /fit/run with a grant reaches the engine and reports its refusal', async () => {
  // FIT_ENGINE is 'off' under the harness (tests/workers.ts), so the tool
  // refuses -- which is exactly the path worth testing here: the form's job is
  // to carry a refusal back to the page legibly rather than 500.
  const token = await grant();
  const response = await server.fetch('/fit/run', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    redirect: 'manual',
    body: new URLSearchParams({
      t: token,
      target_description:
        'A generic description of a role, long enough to satisfy the schema. '.repeat(6),
      turnstile_response: 'stubbed',
    }).toString(),
  });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location')!, 'https://ryanlindsey.me');
  expect(location.pathname).toBe('/fit');
  // The ENGINE'S OWN SENTENCE, verbatim. Asserting only that `error=` is
  // present would be satisfied by every `back()` call in the route -- the
  // bot-check refusal above, the storage failure, a transport error -- so the
  // test would pass with the engine never reached, which is the one thing its
  // name claims. This string is `FitUnavailable`'s, thrown by `analyzeFit` on
  // the `FIT_ENGINE` seam, carried through `fitToolError` as an `isError`
  // RESULT, read out of the result text by `callAnalyzeFit` (`instanceof` does
  // not survive the service binding) and put on the query string unaltered.
  // Its arrival here is the proof that the whole path ran.
  expect(location.searchParams.get('error')).toBe(
    'Fit analysis is not available in this environment.',
  );
  // The token is carried back so the page still renders; nothing else is.
  expect(location.searchParams.get('t')).toBe(token);
  expect([...location.searchParams.keys()].sort()).toEqual(['error', 't']);
});
