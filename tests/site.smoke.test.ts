import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';

// Two Workers are listed because the site's `MCP` service binding resolves
// against the MCP Worker -- workerd refuses to start a Worker whose service
// binding names an undefined service. The site is listed first, making it the
// primary Worker that relative `server.fetch()` URLs address.
//
// Fetches go through `server.fetch()` rather than `getWorker().fetch()`: the
// site is an assets-only Worker, and `getWorker()` dispatches to user Worker
// code, bypassing the asset router that serves every route on day 1.
const server = createTestHarness({
  workers: [{ configPath: './wrangler.jsonc' }, { configPath: './workers/mcp/wrangler.jsonc' }],
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
