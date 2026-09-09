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
 * submissions are forbidden` by Astro's own middleware -- before routing, and
 * so before any code in src/pages/fit/run.ts runs. A browser submitting this
 * form sends the header, so a test that omits it is testing a client that does
 * not exist and never reaches the route it means to.
 *
 * That 403 leaks nothing about `/fit`, which is the property that matters
 * here: measured against `/nope/nope` (no route at all), `/resume.pdf` (a real
 * on-demand route) and `/fit/run`, the refusal and its body are byte-identical
 * on all three. The unlisted guarantee is a statement about what a token gets,
 * and this refusal happens with no token read on any path.
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
  // this page's URL, and a default policy would send it to every host the
  // page links to.
  const response = await server.fetch(`/fit?t=${await grant()}`);
  expect(response.headers.get('x-robots-tag')).toMatch(/noindex/);
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.text()).toMatch(/<meta name="robots" content="noindex, nofollow"/);
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
  const location = response.headers.get('location')!;
  expect(location).toContain('/fit?');
  expect(location).toContain('error=');
  // The token is carried back so the page still renders; nothing else is.
  expect(location).toContain('t=');
});
