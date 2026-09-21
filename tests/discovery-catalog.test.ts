import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { ADVERTISED_SURFACE } from '../src/lib/discovery/surface';
import { buildApiCatalog } from '../src/lib/discovery/api-catalog';
import { AI_CATALOG_MEDIA_TYPE, buildAiCatalog } from '../src/lib/discovery/ard';
import { isUnindexed } from '../src/lib/unindexed-routes.mjs';
import { SERVER_CARD_MEDIA_TYPE } from '../src/lib/discovery/server-card-v1';
import { SITE_HARNESS_WORKERS } from './workers';

// THE GUARD THIS ISSUE EXISTS FOR. /fit carries a scoped token in the URLs
// beneath it, and a catalog is a published list of the paths its author finds
// interesting. This makes publishing one a test failure rather than a review
// catch.
test('no advertised path is an unindexed route', () => {
  for (const endpoint of ADVERTISED_SURFACE) {
    expect(isUnindexed(`https://ryanlindsey.me${endpoint.path}`), endpoint.path).toBe(false);
  }
});

test('the guard is armed: it would actually reject /fit', () => {
  expect(isUnindexed('https://ryanlindsey.me/fit')).toBe(true);
  expect(isUnindexed('https://ryanlindsey.me/fit/r/abc123')).toBe(true);
});

test('every entry carries two to five representative queries', () => {
  for (const endpoint of ADVERTISED_SURFACE) {
    expect(endpoint.representativeQueries.length, endpoint.path).toBeGreaterThanOrEqual(2);
    expect(endpoint.representativeQueries.length, endpoint.path).toBeLessThanOrEqual(5);
  }
});

test('urn identifiers are unique and well formed', () => {
  const ids = buildAiCatalog('https://ryanlindsey.me').entries.map((e) => e.identifier);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^urn:air:ryanlindsey\.me:[a-z-]+:[a-z0-9-]+$/);
});

test('every ARD entry carries exactly one of url or data', () => {
  for (const entry of buildAiCatalog('https://ryanlindsey.me').entries) {
    expect(Number('url' in entry) + Number('data' in entry)).toBe(1);
  }
});

// Epic-165 follow-up review, second wave, finding C: the manifest's shape was
// designed without checking it against the real spec (`ards-project/ard-spec`,
// `spec/schemas/ai-catalog.schema.json`), and the scanner (isitagentready.com)
// caught what that missed -- `entries[].id` should have been `identifier`
// (asserted above via `.identifier`), `specVersion` is an enum whose only
// allowed value is `"1.0"`, and `host`, when present, requires `displayName`
// and forbids any field the schema does not name (including the `url` this
// manifest used to carry). Pinned here directly against the schema's own
// requirements, not against this repo's prior shape.
test('the manifest conforms to the real ARD schema: pinned specVersion and a schema-shaped host', () => {
  const doc = buildAiCatalog('https://ryanlindsey.me');
  expect(doc.specVersion).toBe('1.0');
  expect(doc.host).toEqual({ displayName: 'ryanlindsey-me' });
  for (const entry of doc.entries) {
    expect(entry).toHaveProperty('identifier');
    expect(entry).not.toHaveProperty('id');
  }
});

test('the catalog anchors every advertised endpoint at the given origin', () => {
  const catalog = buildApiCatalog('https://ryanlindsey.me');
  expect(catalog.linkset).toHaveLength(ADVERTISED_SURFACE.length);
  for (const entry of catalog.linkset) {
    expect(entry.anchor.startsWith('https://ryanlindsey.me/')).toBe(true);
  }
});

test('the MCP entry points the manifest at the card and the linkset at the endpoint', () => {
  // SEP-2127's docs/discovery.md, read 2026-09-20: the AI Catalog entry for an
  // MCP server has `type` application/mcp-server-card+json and a `url` to the
  // card. RFC 9727's linkset names the API itself. One surface entry, two
  // documents, through the optional `descriptor`.
  const manifest = buildAiCatalog('https://ryanlindsey.me');
  const mcp = manifest.entries.find((e) => e.identifier === 'urn:air:ryanlindsey.me:mcp:corpus');
  expect(mcp?.type).toBe(SERVER_CARD_MEDIA_TYPE);
  expect(mcp && 'url' in mcp ? mcp.url : null).toBe('https://ryanlindsey.me/mcp/server-card');

  const linkset = buildApiCatalog('https://ryanlindsey.me');
  expect(linkset.linkset.map((l) => l.anchor)).toContain('https://ryanlindsey.me/mcp');
  expect(linkset.linkset.map((l) => l.anchor)).not.toContain(
    'https://ryanlindsey.me/mcp/server-card',
  );
});

test('every entry without a descriptor still points at its own path', () => {
  const manifest = buildAiCatalog('https://ryanlindsey.me');
  for (const endpoint of ADVERTISED_SURFACE) {
    if ('descriptor' in endpoint) continue;
    const entry = manifest.entries.find(
      (e) => e.identifier === `urn:air:ryanlindsey.me:${endpoint.namespace}:${endpoint.name}`,
    );
    expect(entry && 'url' in entry ? entry.url : null, endpoint.path).toBe(
      `https://ryanlindsey.me${endpoint.path}`,
    );
    expect(entry?.type, endpoint.path).toBe(endpoint.mediaType);
  }
});

test('no linkset entry claims a status endpoint, because there is none', () => {
  for (const entry of buildApiCatalog('https://ryanlindsey.me').linkset) {
    expect(entry).not.toHaveProperty('status');
  }
});

// Served-response coverage for both new site routes, the same discipline
// tests/discovery-server-card.test.ts and tests/discovery-auth.test.ts apply
// to their own routes: a public/_headers RULE with no assertion against a
// real response is the half most likely to be wrong, and this is doubly true
// for the extensionless /.well-known/api-catalog -- Cloudflare's mime lookup
// has nothing to work from there, so without this test a typo in that rule
// would ship silently. The manifest's Access-Control-Allow-Origin is the
// other half a unit test of the builder alone cannot see, because the
// builders below never set a header at all.
//
// See ./workers.ts for why the site Worker is booted from the build output
// and why the MCP Worker is always listed with it.
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

test('the deployed API catalog ships the RFC 9264 linkset media type', async () => {
  const response = await server.fetch('/.well-known/api-catalog');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/linkset+json');
  const doc = (await response.json()) as ReturnType<typeof buildApiCatalog>;
  expect(doc.linkset).toHaveLength(ADVERTISED_SURFACE.length);
});

// This test pinned `application/json; charset=utf-8` here from #168 until
// 2026-09-21, and that was the only thing holding the wrong type in place:
// the value had never been checked against the AI Catalog spec, so the
// assertion recorded what the rule happened to say rather than what the
// document is required to ship. The media type now comes from the exported
// constant, and the test below it cites the spec that fixes the constant's
// value.
test('the deployed ARD manifest ships its media type and allows cross-origin reads', async () => {
  const response = await server.fetch('/.well-known/ai-catalog.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(AI_CATALOG_MEDIA_TYPE);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  const doc = (await response.json()) as ReturnType<typeof buildAiCatalog>;
  expect(doc.entries).toHaveLength(ADVERTISED_SURFACE.length);
});

test('ard.json is the same manifest under the name ARD v0.91 reads', async () => {
  // ards-project/ard-spec §5.1, read 2026-09-20: the manifest is a document
  // with an `entries` array, "any other top-level members are transport-defined
  // and ignored by ARD", and ARD's two additional requirements, a mandatory
  // displayName and representativeQueries, are already on every entry. So the
  // bytes are identical; only the name and the link relation are new.
  const [catalog, ard] = await Promise.all([
    server.fetch('/.well-known/ai-catalog.json'),
    server.fetch('/.well-known/ard.json'),
  ]);
  expect(ard.status).toBe(200);
  expect(await ard.text()).toBe(await catalog.text());
  expect(ard.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(ard.headers.get('access-control-allow-origin')).toBe('*');
});

test('ai-catalog.json ships the media type its own spec names', async () => {
  // ai-catalog.io/guides/serving-your-catalog, read 2026-09-20:
  // `Content-Type: application/ai-catalog+json`. No charset, following the
  // linkset rule's reasoning in public/_headers: the type is registered
  // without one.
  const response = await server.fetch('/.well-known/ai-catalog.json');
  expect(response.headers.get('content-type')).toBe(AI_CATALOG_MEDIA_TYPE);
  expect(AI_CATALOG_MEDIA_TYPE).toBe('application/ai-catalog+json');
});

// The MCP origin's robots file carries the same directive and is asserted in
// tests/mcp.smoke.test.ts, which is the suite that boots that Worker.
test("the home page and the site's robots file point at ard.json", async () => {
  const home = await server.fetch('/');
  expect(await home.text()).toContain('<link rel="ard" href="/.well-known/ard.json">');
  const robots = await server.fetch('/robots.txt');
  expect(await robots.text()).toMatch(
    /^Agentmap: https:\/\/ryanlindsey\.me\/\.well-known\/ard\.json$/m,
  );
});

// Epic-165 follow-up review, finding 3: every other test in this file checks
// the SHAPE of the advertised surface, and nothing fetched it -- which is how
// `/chat`'s entry could advertise `mediaType: 'text/event-stream'` while
// `GET /chat` actually answered `text/html`, with no test catching the
// disagreement. This test closes that gap.
//
// Iterates the BUILDERS' EMITTED URLs (`buildApiCatalog(...).linkset[].anchor`
// and `buildAiCatalog(...).entries[].url`), not `ADVERTISED_SURFACE`'s raw
// `path` strings -- the same review flagged that the "no advertised path is
// an unindexed route" guard above iterates raw paths and would miss a future
// builder-side transform of one, and this is where closing that gap actually
// matters: what a caller reaches is whatever the builder put in the document
// it fetched, not whatever `./surface.ts` says was intended.
test('every URL the discovery builders emit for the advertised surface actually resolves', async () => {
  const origin = 'https://ryanlindsey.me';
  const apiCatalogUrls = buildApiCatalog(origin).linkset.map((entry) => entry.anchor);
  const aiCatalogUrls = buildAiCatalog(origin).entries.map((entry) => {
    // "every ARD entry carries exactly one of url or data" above already
    // pins that `url` is the arm every entry actually takes; this repeats
    // the check here as a real failure rather than a silent skip, because a
    // future `data` entry would otherwise vanish from this loop instead of
    // being counted as a resource this test has not checked.
    if (!('url' in entry)) throw new Error(`ARD entry ${entry.identifier} carries data, not a url`);
    return entry.url;
  });

  // This used to assert `aiCatalogUrls` EQUALS `apiCatalogUrls`, on the
  // reasoning that both builders map the same ADVERTISED_SURFACE in the same
  // order so any divergence was builder-side drift. That stopped being true
  // on 2026-09-21: `descriptor` (./surface.ts) makes the MCP entry diverge on
  // purpose, the manifest naming the server card and the linkset naming the
  // endpoint, which is exactly what SEP-2127 and RFC 9727 each ask for. The
  // equality was load-bearing, though, and dropping it alone would have left
  // the loop below checking one builder's URLs while the other's went
  // unfetched -- so both sets are fetched now, deduplicated, and the drift
  // the equality used to catch is caught instead by "the MCP entry points the
  // manifest at the card and the linkset at the endpoint" above, which names
  // the one divergence that is allowed.
  const emitted = [...new Set([...apiCatalogUrls, ...aiCatalogUrls])];

  for (const url of emitted) {
    // `new URL(...).pathname`, not a string slice off `origin` -- this repo's
    // CodeQL gate blocks substring/startsWith checks against a URL or origin.
    const { pathname } = new URL(url);
    // THE /fit GUARD, ON WHAT A CALLER ACTUALLY REACHES. "no advertised path
    // is an unindexed route" at the top of this file reads `endpoint.path`
    // alone, and this file's own comment above predicted the hole that leaves:
    // the epic-165 follow-up review flagged that the guard "would miss a
    // future builder-side transform" of a path. `descriptor.path`
    // (./surface.ts) is that transform, arriving 2026-09-21 as a SECOND
    // path-bearing field that reaches the published manifest, and the raw-path
    // guard cannot see it. Repeating the check here covers both fields and
    // every future one, because these URLs are whatever the builders emitted
    // rather than whatever the list was read to mean.
    expect(isUnindexed(url), pathname).toBe(false);
    const response = await server.fetch(pathname);
    if (pathname === '/mcp') {
      // The one deliberate exception, named rather than folded into a loose
      // status check that would also pass a 404. Verified against production
      // (2026-09-14): an MCP endpoint that only speaks JSON-RPC POST answers
      // GET with 405, and public/_headers and src/pages/llms.txt.ts both
      // already record that same measurement.
      expect(response.status, pathname).toBe(405);
    } else {
      expect(response.status, pathname).toBe(200);
    }
  }
});
