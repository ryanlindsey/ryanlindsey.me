import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS } from './workers';

// See ./workers.ts for why the site Worker is booted from the build output and
// why the MCP Worker is always listed with it. The site is listed first, making
// it the primary Worker that relative `server.fetch()` URLs address.
//
// Fetches go through `server.fetch()` rather than `getWorker().fetch()` so they
// hit the asset router first, which is what serves every route on this site but
// /resume.pdf. `getWorker().fetch()` would dispatch straight into Worker code.
const server = createTestHarness({
  workers: SITE_HARNESS_WORKERS,
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

test('serves the holding page from static assets', async () => {
  const response = await server.fetch('/');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');

  const html = await response.text();
  expect(html).toContain('data-testid="holding-page"');
  expect(html).toContain('<title>Ryan Lindsey</title>');
});

test('is indexable since launch', async () => {
  const html = await (await server.fetch('/')).text();
  // Inverted at launch, and pinned to the exact attribute value rather than a
  // `toContain('index')` substring, which "noindex" would also satisfy -- see
  // the matching test in tests/pages.test.ts for why that is worth spelling
  // out here instead of trusting the shorter form.
  expect(html).toMatch(/<meta name="robots" content="index, follow"\s*\/?>/);
  expect(html).not.toContain('noindex');
});

test('returns 404 for an unknown path', async () => {
  const response = await server.fetch('/this-route-does-not-exist');
  expect(response.status).toBe(404);
});
