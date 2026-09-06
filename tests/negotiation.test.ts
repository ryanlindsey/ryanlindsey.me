import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';

// Day 3 Task 8 (02 §3): `Accept: text/markdown` content negotiation, on top
// of Task 7's `.md`-suffix routes. See src/worker.ts's `negotiateMarkdown`
// and wrangler.jsonc's `assets.run_worker_first` -- both are load-bearing
// here, and the latter is why this suite boots the site from the ADAPTER'S
// BUILD OUTPUT (./workers.ts's SITE_WORKER, `dist/server/wrangler.json`)
// rather than any hand-rolled config: that is the only config the deployed
// Worker actually ships, `run_worker_first` included.
//
// See ./workers.ts for why the site Worker is booted from the build output
// and why the MCP Worker is always listed with it.
const server = createTestHarness({
  workers: SITE_HARNESS_WORKERS,
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

const fetchWith = async (path: string, accept?: string) =>
  server.fetch(path, { headers: accept === undefined ? {} : { Accept: accept } });

/**
 * A handful of real content routes, deliberately spanning all three cases
 * `markdownAssetPathFor` special-cases: the `/resume` singular page and one
 * slugged entry each from `/writing` and `/work`. `type-specimen` and
 * `shape-specimen` are both `draft: true` (see tests/pages.test.ts) -- using
 * them here is itself a small assertion that negotiation does not add a
 * second, easy-to-forget place the "drafts get a detail route AND its
 * format siblings" rule has to hold, since these are the same specimens
 * Task 7's own tests exercise for exactly that reason.
 */
const CONTENT_ROUTES = ['/resume', '/writing/type-specimen', '/work/shape-specimen'];

for (const route of CONTENT_ROUTES) {
  test(`${route}: Accept: text/markdown negotiates the exact .md asset, with Vary: Accept`, async () => {
    const negotiated = await fetchWith(route, 'text/markdown');
    expect(negotiated.status, `${route} with Accept: text/markdown should be 200`).toBe(200);
    expect(
      negotiated.headers.get('content-type'),
      `${route} should serve text/markdown when negotiated`,
    ).toMatch(/^text\/markdown\b/);
    expect(
      negotiated.headers.get('vary'),
      `${route}'s negotiated markdown response must carry Vary: Accept -- without it, ` +
        'a cache could later serve this markdown body to a browser asking for HTML',
    ).toBe('Accept');

    // Reuse, not re-derivation (task-8-brief.md Step 2): the negotiated body
    // must be byte-for-byte the SAME prerendered `.md` asset Task 7's own
    // suffix route serves, not a second, independently-rendered copy that
    // could silently drift from it.
    const direct = await server.fetch(`${route}.md`);
    expect(direct.status, `${route}.md should itself resolve`).toBe(200);
    await expect(negotiated.text()).resolves.toBe(await direct.text());
  });

  test(`${route}: Accept: text/html returns HTML, unVaried`, async () => {
    const response = await fetchWith(route, 'text/html');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html\b/);
    const body = await response.text();
    expect(body).toContain('<!DOCTYPE html>');
  });

  // THE critical guard (task-8-brief.md, top instructions): `Accept: */*` is
  // what curl, most HTTP libraries and most crawlers actually send, and it
  // is NOT a request for markdown. An HTML page is served by default, so if
  // the negotiation branch were removed entirely, ALL of the assertions in
  // this file that check for text/markdown above would go red immediately
  // -- see task-8-report.md's "removing the branch" verification for the
  // observed failure.
  test(`${route}: Accept: */* returns HTML, not markdown`, async () => {
    const response = await fetchWith(route, '*/*');
    expect(response.status).toBe(200);
    expect(
      response.headers.get('content-type'),
      `${route} with Accept: */* must stay text/html -- */* is not a markdown request`,
    ).toMatch(/^text\/html\b/);
  });

  test(`${route}: a missing Accept header returns HTML, same as */*`, async () => {
    const response = await fetchWith(route);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html\b/);
  });

  test(`${route}: text/html outweighing text/markdown by q-value returns HTML`, async () => {
    // Respecting q-values, not just presence: text/markdown appears in the
    // header, but at a lower weight than text/html, so text/html must win.
    const response = await fetchWith(route, 'text/markdown;q=0.1, text/html;q=0.9');
    expect(response.status).toBe(200);
    expect(
      response.headers.get('content-type'),
      `${route}: text/html;q=0.9 should outweigh text/markdown;q=0.1`,
    ).toMatch(/^text\/html\b/);
  });
}

test('the trailing-slash form of a content route also negotiates', async () => {
  // task-8-brief.md's called-out edge case: an extensionless request like
  // /writing/foo 307-redirects to /writing/foo/ before Cloudflare would ever
  // serve an asset for it (task-7-report.md), so a real client can reach
  // negotiation with either form of the path. Naively appending `.md` to
  // the slashed form would target the nonexistent /writing/foo/.md.
  const response = await fetchWith('/writing/type-specimen/', 'text/markdown');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/markdown\b/);
  expect(response.headers.get('vary')).toBe('Accept');
  const body = await response.text();
  expect(body).toContain('title: "Type Specimen"');
});

test('aggregation pages (/writing, /work) never negotiate, even when asked for markdown', async () => {
  // The aggregation surfaces have no markdown variant of their own (they are
  // the "only aggregation surfaces filter drafts" tier, not a content
  // route) -- negotiation must not invent one or return something broken.
  for (const path of ['/writing', '/writing/', '/work', '/work/']) {
    const response = await fetchWith(path, 'text/markdown');
    expect(response.status, `${path} should still be 200`).toBe(200);
    expect(
      response.headers.get('content-type'),
      `${path} has no markdown variant and must keep serving HTML`,
    ).toMatch(/^text\/html\b/);
    expect(response.headers.get('vary'), `${path} was never negotiated`).toBeNull();
  }
});

test('a non-content path (/resume.pdf) is unaffected by Accept: text/markdown', async () => {
  // /resume.pdf already carries its own explicit format in its URL and is
  // not one of Task 6/7's markdown-exportable collections at all --
  // negotiation must leave it alone regardless of what Accept asks for.
  const withMarkdownAccept = await server.fetch('/resume.pdf', {
    headers: { Accept: 'text/markdown' },
  });
  const withDefaultAccept = await server.fetch('/resume.pdf');

  expect(withMarkdownAccept.status).toBe(200);
  expect(withDefaultAccept.status).toBe(200);
  expect(
    withMarkdownAccept.headers.get('content-type'),
    '/resume.pdf must never be served as text/markdown',
  ).not.toMatch(/^text\/markdown\b/);
  expect(withMarkdownAccept.headers.get('content-type')).toBe(
    withDefaultAccept.headers.get('content-type'),
  );
  expect(withMarkdownAccept.headers.get('vary'), '/resume.pdf is never negotiated').toBeNull();
});

test('an already-suffixed request (/writing/<slug>.md) ignores Accept entirely', async () => {
  // A URL that already names its own format is not up for negotiation: an
  // HTML-preferring Accept header must not turn /writing/type-specimen.md
  // into anything other than the markdown it names.
  const response = await fetchWith('/writing/type-specimen.md', 'text/html');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/markdown\b/);
});
