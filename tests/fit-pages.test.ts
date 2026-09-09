import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_WORKER, SITE_HARNESS_WORKERS } from './workers';
import { mintToken, newJti, type Scope } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant';
import { BANNED_PATTERNS } from './candidacy-patterns';
import { NOT_FOUND_PROBE } from '../src/lib/not-found-probe';
import { fitErrorCopy, FIT_ERROR_COPY } from '../src/lib/fit/errors';

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
 * It is an oracle anyway, because the check does not run for every path. FIX
 * ROUND 2 CORRECTION: this comment previously blamed `run_worker_first`, saying
 * a path outside that list never reaches the Worker so the check never runs.
 * Measured false -- `POST /work/nope-nope` IS matched by that list, reaches the
 * Worker (`GET /work/nope-nope` carries `Vary: Accept`, which only
 * src/worker.ts adds) and still answers the 404 page. The variable is whether
 * the path resolves to a ROUTE: an unrouted path lands on the PRERENDERED
 * src/pages/404.astro, so Astro's `renderDefaultError` fetches it as an asset
 * and skips middleware; a matched on-demand route still reaches the check
 * (`POST /resume.pdf` with no `Origin` answers 403). So `/fit/run` answering
 * 403 where a dead path answers the page says "this is a real on-demand route".
 *
 * The correction matters in a specific direction: believing the
 * `run_worker_first` story, a maintainer could delete `/fit` from that list
 * expecting the asymmetry to go with it, and would lose the `Referrer-Policy`
 * header instead. src/worker.ts flattens the 403 -- and the 404, and the 500 --
 * to the site's own 404, and `an un-granted /fit is indistinguishable from a
 * path that does not exist` below is what holds that through whichever of these
 * mechanisms moves next.
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

test('a successful /fit/run response sets no cookie', async () => {
  // Fix round (Task 16, finding 5): tests/tier-invisibility.test.ts's cookie
  // tests are a SOURCE scan (grep src/pages/fit/run.ts for `set-cookie`),
  // which is fast but proves nothing about a real response -- a header set
  // through a helper, a framework default, or a Response constructed
  // elsewhere would pass that scan and still ship a cookie. This is the
  // runtime half of the same invariant: `allowedOriginHostnames: '*'`
  // (workers/mcp/src/index.ts) is safe only because nothing this system ever
  // sends is ambient, and a cookie is the canonical ambient credential.
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
  expect(response.headers.get('set-cookie')).toBeNull();
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
  //
  // EVERY header, not a named few (fix round 2). The first version of this
  // compared six fields, which is exactly the shape of assertion that let the
  // original defect through -- a difference the test does not name is a
  // difference the test cannot see, and `Referrer-Policy` on a refusal is a
  // one-header tell.
  const observable = async (path: string, init?: FetchInit) => {
    const response = await server.fetch(path, { redirect: 'manual', ...init });
    return {
      status: response.status,
      body: await response.text(),
      headers: Object.fromEntries([...response.headers.entries()].sort()),
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

  // The probe path src/worker.ts fetches to BUILD that refusal. Nothing else
  // makes it keep not matching a route, and a route added there later would
  // serve its own page to every un-granted caller of `/fit`. Imported rather
  // than retyped, so the assertion is about the value the worker actually uses.
  expect(await observable(NOT_FOUND_PROBE)).toEqual(control);

  // And the POSTs, against the same control. A dead path answers a POST with
  // exactly what it answers a GET with -- measured, headers and all -- because
  // the 404 page is prerendered and reached before any method-specific
  // handling, so `control` is the right comparison for these too.
  //
  // Three content types, because each refusal shape this page has had was
  // found on a different one:
  //
  //   form-encoded -- Astro's origin-check 403, for a path that is a route
  //   json         -- `request.formData()` throwing, a 500 with an empty body
  //   multipart    -- the same throw, from a content type it cannot parse
  //
  // The json case is the one that was open until fix round 2: `/fit/run`
  // answered 500 and empty, with both headers attached, while every dead path
  // answered the 404 page -- with no token, and invisible to a test that only
  // ever posted form-encoded.
  //
  // NO REQUEST BODIES, and that is not a weaker test: `formData()` refuses on
  // the CONTENT TYPE ("Unrecognized Content-Type header value. FormData can
  // only parse..."), so the throw is reached with or without one. Sending a
  // body would leave it unread on the dead-path side and poison the next
  // request on the connection (see `origin` above), making the comparison
  // depend on test order. The bodied form was measured by hand at this commit
  // and answers identically.
  const contentTypes = [
    'application/x-www-form-urlencoded',
    'application/json',
    'multipart/form-data; boundary=nope',
  ];
  for (const contentType of contentTypes) {
    const post: FetchInit = { method: 'POST', headers: { 'content-type': contentType } };
    expect(await observable('/fit/run', post), `POST ${contentType}`).toEqual(control);
  }
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
  // The CODE, not the sentence (final-review Important 7). `fitErrorCopy` is
  // what turns it into the sentence, on the page, from a table the page owns.
  expect(location.searchParams.get('error')).toBe('bot-check');
  expect(fitErrorCopy('bot-check')).toMatch(/bot check/i);
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
  // `refused` is the code ONLY the tool-refusal branch produces, and keeping
  // that discrimination is the point of asserting it rather than merely
  // asserting `error=` is present: the bot-check refusal above, the storage
  // failure and a transport error each carry a different code, so a test that
  // accepted any of them would pass with the engine never reached -- the one
  // thing this test's name claims.
  //
  // What it no longer proves, deliberately: that `FitUnavailable`'s own
  // sentence ("Fit analysis is not available in this environment.", thrown by
  // `analyzeFit` on the `FIT_ENGINE` seam) survives to the page. It no longer
  // does, and must not -- the query string is forgeable by anyone holding a
  // `/fit?t=...` link. The sentence still crosses the service binding as an
  // `isError` result and is read by `callAnalyzeFit` into `outcome.message`,
  // where `/fit/run` logs it; `tests/fit-client.test.ts` is where that half is
  // pinned.
  expect(location.searchParams.get('error')).toBe('refused');
  // The token is carried back so the page still renders; nothing else is.
  expect(location.searchParams.get('t')).toBe(token);
  expect([...location.searchParams.keys()].sort()).toEqual(['error', 't']);
});

// `/fit/r/<id>` (04 §2): the report permalink. THE ID IS THE CAPABILITY --
// unlike every other `/fit` route above, these tests send no token at all,
// because requiring one here would make the permalink the same gated thing
// it exists to replace.

/** A stored report, inserted directly -- the render path is what is under test. */
async function storeReport(id: string) {
  await db
    .prepare(
      `INSERT INTO fit_reports (id, created_at, audience, model, target_description,
         report_json, citations_checked, citations_dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      '2026-09-08T00:00:00.000Z',
      'web',
      'anthropic/claude-opus-5',
      'A generic description of a role.',
      JSON.stringify({
        overall_read: 'A generic read of the comparison.',
        requirement_map: [
          {
            requirement: 'Runs platform teams',
            strength: 'strong',
            evidence: [
              { claim: 'Led a platform group', citation_url: 'https://ryanlindsey.me/resume' },
            ],
          },
        ],
        gaps: [{ requirement: 'Field service', why: 'Not evidenced in the corpus.' }],
        questions_to_ask: ['How is the on-call rotation staffed?'],
      }),
      1,
      0,
    )
    .run();
}

test('a stored report renders at its permalink with no token', async () => {
  // The id IS the capability (04 §2): the permalink is meant to be circulated
  // by whoever received it, so it must not require the token they were given.
  await storeReport('fixture-report-id');
  const response = await server.fetch('/fit/r/fixture-report-id');
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('A generic read of the comparison.');
  expect(html).toContain('Runs platform teams');
  expect(html).toContain('Field service');
  expect(html).toContain('https://ryanlindsey.me/resume');
});

test('an unknown permalink id is indistinguishable from a path that does not exist', async () => {
  // FIX ROUND 1, FINDING 3: this used to sit alongside a standalone
  // `expect(status).toBe(404)` test for an unknown id, and that test could
  // not fail -- with no route file at all, `/fit/r/*` already 404s (there is
  // nothing to distinguish it from a dead path), which is exactly the state
  // this suite was in the first time it ran. Folded in here rather than kept
  // separate, because THIS is the assertion an unknown id actually needs:
  // not merely 404, but the SAME 404 a path that was never routed gets. This
  // route sits under src/worker.ts's `/fit` prefix match, so its 404 is
  // supposed to be REPLACED by the site's own 404 page rather than answered
  // by this route at all. That is only true because the page returns a BARE
  // `new Response(null, { status: 404 })` -- no body, no headers -- leaving
  // nothing for the worker to flatten around. Compared here against the same
  // control the `/fit` test uses, so a regression in either surface shows up
  // as a mismatch rather than a passing status check.
  const control = await server.fetch('/definitely-not-a-route', { redirect: 'manual' });
  const observed = await server.fetch('/fit/r/never-stored', { redirect: 'manual' });
  expect(observed.status).toBe(control.status);
  expect(await observed.text()).toBe(await control.text());
  expect(Object.fromEntries([...observed.headers.entries()].sort())).toEqual(
    Object.fromEntries([...control.headers.entries()].sort()),
  );
});

test('the permalink carries noindex and no-referrer too', async () => {
  await storeReport('fixture-headers-id');
  const response = await server.fetch('/fit/r/fixture-headers-id');
  expect(response.headers.get('x-robots-tag')).toMatch(/noindex/);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  // FIX ROUND 1, FINDING 2: the two header checks above cannot fail from
  // anything this PAGE does -- src/worker.ts sets both headers
  // unconditionally on every non-refusal `/fit*` response, so they would
  // still pass with `robots`/`referrer` deleted from the `<Base>` call
  // entirely. The meta tags are the SECOND, independent delivery, and
  // Base.astro's own prop comment calls that delivery load-bearing precisely
  // because the header one depends on routing config
  // (`run_worker_first`/the worker's `/fit` prefix match) that can regress
  // without this page changing at all. The permalink id is bearer-equivalent
  // to the token on `/fit` -- it IS the capability -- and a citation URL is
  // an unrestricted `z.string().url()` (src/lib/fit/schema.ts), so any
  // external citation could otherwise carry this URL off in a `Referer`.
  const html = await response.text();
  expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
  expect(html).toMatch(/<meta name="referrer" content="no-referrer"/);
});

test('the report page states its provenance, dropped citations included', async () => {
  // 03 §4's honesty contract is only verifiable by a reader if the reader can
  // see the numbers -- especially the DROPPED count, which is the one that
  // says whether the analyser was caught inventing a source. FIX ROUND 1,
  // FINDING 1: `storeReport`'s fixture hardcodes `citations_dropped: 0`, and
  // this test used to assert only the generic `/1 citation/i`, which stays
  // true even with the "... dropped as unresolvable" clause deleted from the
  // template entirely. So this uses its own fixture with a NONZERO dropped
  // count and asserts on that number directly.
  await db
    .prepare(
      `INSERT INTO fit_reports (id, created_at, audience, model, target_description,
         report_json, citations_checked, citations_dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      'fixture-provenance-id',
      '2026-09-08T00:00:00.000Z',
      'web',
      'anthropic/claude-opus-5',
      'A generic description of a role.',
      JSON.stringify({
        overall_read: 'A generic read of the comparison.',
        requirement_map: [
          {
            requirement: 'Runs platform teams',
            strength: 'strong',
            evidence: [
              { claim: 'Led a platform group', citation_url: 'https://ryanlindsey.me/resume' },
            ],
          },
        ],
        gaps: [],
        questions_to_ask: [],
      }),
      4,
      3,
    )
    .run();
  const html = await (await server.fetch('/fit/r/fixture-provenance-id')).text();
  expect(html).toContain('anthropic/claude-opus-5');
  expect(html).toMatch(/4 citations checked/i);
  expect(html).toMatch(/3 dropped as unresolvable/i);
});

test('a stored report that no longer matches the schema renders a notice, not a crash', async () => {
  await db
    .prepare(
      `INSERT INTO fit_reports (id, created_at, audience, model, target_description,
         report_json, citations_checked, citations_dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind('fixture-stale-id', '2026-09-08T00:00:00.000Z', 'web', 'm', 'd', '{"nope":true}', 0, 0)
    .run();
  const response = await server.fetch('/fit/r/fixture-stale-id');
  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(/cannot be displayed/i);
});

test('a stored report whose JSON will not even parse renders the same notice', async () => {
  // Adjacent to the stale-schema case above but a different failure mode:
  // `JSON.parse` itself throwing rather than merely producing something
  // `FitReport.safeParse` rejects. The rule that binds this task (task-14
  // brief, adjustment 2) is that a reader-actionable failure must render as
  // 200, never throw into the worker's 500-to-404 flattening -- and an
  // uncaught SyntaxError here would do exactly that, silently.
  await db
    .prepare(
      `INSERT INTO fit_reports (id, created_at, audience, model, target_description,
         report_json, citations_checked, citations_dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      'fixture-unparseable-id',
      '2026-09-08T00:00:00.000Z',
      'web',
      'm',
      'd',
      'not json at all',
      0,
      0,
    )
    .run();
  const response = await server.fetch('/fit/r/fixture-unparseable-id');
  expect(response.status).toBe(200);
  expect(await response.text()).toMatch(/cannot be displayed/i);
});

test('a stored report with an unparseable created_at does not crash', async () => {
  // FIX ROUND 1, FINDING 4: `generated` (the page's lead line AND the
  // provenance footer read from it) is computed from `row.created_at`
  // BEFORE the `report === null` branch above decides whether to render the
  // report or the stale-schema notice. `created_at` is written by this build
  // alone and carries no schema-versioning story the way `report_json` does
  // -- but `new Date(bad).toISOString()` THROWS a RangeError rather than
  // degrading, unlike `JSON.parse`, which at least fails in a way a
  // try/catch expects. Uncaught, that throw is a 500 that src/worker.ts's
  // flattening turns into a silent 404 -- on the stale-schema path too,
  // which is the one adjustment 2 exists to keep alive. This report is
  // otherwise well-formed (a valid `report_json`), so a failure here is
  // specifically about the date guard and nothing else.
  await db
    .prepare(
      `INSERT INTO fit_reports (id, created_at, audience, model, target_description,
         report_json, citations_checked, citations_dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      'fixture-bad-date-id',
      'not a date',
      'web',
      'anthropic/claude-opus-5',
      'A generic description of a role.',
      JSON.stringify({
        overall_read: 'A generic read of the comparison.',
        requirement_map: [{ requirement: 'Runs platform teams', strength: 'strong', evidence: [] }],
        gaps: [],
        questions_to_ask: [],
      }),
      0,
      0,
    )
    .run();
  const response = await server.fetch('/fit/r/fixture-bad-date-id');
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('A generic read of the comparison.');
});

test('the permalink page copy carries no search language', async () => {
  // 09 §2's discipline applies to every user-facing surface, not only the
  // gated form -- this page is reachable with no token at all, so it is
  // read by more strangers than /fit itself.
  //
  // The fixture id is deliberately NOT "...candidacy..." (an earlier version
  // of this test used one): Task 16 added `/\bcandidac(y|ies)\b/i` to
  // BANNED_PATTERNS, and [id].astro's own Base layout renders the current
  // path into a `<link rel="canonical">` -- so an id containing that word,
  // hyphen-delimited on both sides, would trip the pattern against its OWN
  // URL rather than against anything the page actually says. That is a
  // fixture-naming collision, not a leak, and the fix is to pick an id that
  // cannot spell a banned word by accident.
  await storeReport('fixture-scan-fixture-id');
  const html = await (await server.fetch('/fit/r/fixture-scan-fixture-id')).text();
  for (const pattern of BANNED_PATTERNS) expect(html).not.toMatch(pattern);
});

test('a forged ?error= renders nothing on the form', async () => {
  // The phish final-review Important 7 named, run end to end: a `/fit?t=...`
  // link is handed out and meant to be forwarded, so whoever holds one can
  // append whatever they like. Before the code table, the page rendered it.
  const token = await grant();
  const phish = 'Your token expired. Send your details to someone-else.example to renew.';
  const response = await server.fetch(
    `/fit?t=${encodeURIComponent(token)}&error=${encodeURIComponent(phish)}`,
    { headers: { origin } },
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  // Neither the sentence nor any fragment a reader would act on. Checked on
  // the rendered HTML rather than on `fitErrorCopy` alone, because the page
  // is the surface that mattered -- a second reader of the query parameter
  // added later would fail this and pass a unit test of the lookup.
  expect(html).not.toContain('someone-else.example');
  expect(html).not.toContain('Your token expired');
});

test('every code /fit/run can emit has copy, and the page renders it', async () => {
  // The two halves cannot drift: `FitErrorCode` is what `back()` accepts and
  // `FIT_ERROR_COPY` is what the page can show, so a code added to one and
  // not the other would either be unrenderable or unreachable. TypeScript
  // pins the table's completeness (`Record<FitErrorCode, string>`); this pins
  // that the page actually reaches the table.
  const token = await grant();
  for (const [code, copy] of Object.entries(FIT_ERROR_COPY)) {
    expect(fitErrorCopy(code)).toBe(copy);
    const response = await server.fetch(
      `/fit?t=${encodeURIComponent(token)}&error=${encodeURIComponent(code)}`,
      { headers: { origin } },
    );
    expect(response.status, `${code} must still render the form`).toBe(200);
    expect(await response.text()).toContain(copy);
  }
});
