import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { ADVERTISED_SURFACE } from '../src/lib/discovery/surface';
import { buildApiCatalog } from '../src/lib/discovery/api-catalog';
import { buildAiCatalog } from '../src/lib/discovery/ard';
import { isUnindexed } from '../src/lib/unindexed-routes.mjs';
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
  const ids = buildAiCatalog('https://ryanlindsey.me').entries.map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^urn:air:ryanlindsey\.me:[a-z-]+:[a-z0-9-]+$/);
});

test('every ARD entry carries exactly one of url or data', () => {
  for (const entry of buildAiCatalog('https://ryanlindsey.me').entries) {
    expect(Number('url' in entry) + Number('data' in entry)).toBe(1);
  }
});

test('the catalog anchors every advertised endpoint at the given origin', () => {
  const catalog = buildApiCatalog('https://ryanlindsey.me');
  expect(catalog.linkset).toHaveLength(ADVERTISED_SURFACE.length);
  for (const entry of catalog.linkset) {
    expect(entry.anchor.startsWith('https://ryanlindsey.me/')).toBe(true);
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

test('the deployed ARD manifest ships JSON and allows cross-origin reads', async () => {
  const response = await server.fetch('/.well-known/ai-catalog.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  const doc = (await response.json()) as ReturnType<typeof buildAiCatalog>;
  expect(doc.entries).toHaveLength(ADVERTISED_SURFACE.length);
});
