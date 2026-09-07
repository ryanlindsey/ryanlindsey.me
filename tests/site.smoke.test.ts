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

test('is not indexable before launch', async () => {
  const html = await (await server.fetch('/')).text();
  expect(html).toContain('name="robots"');
  expect(html).toContain('noindex');
});

test('returns 404 for an unknown path', async () => {
  const response = await server.fetch('/this-route-does-not-exist');
  expect(response.status).toBe(404);
});
