import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';

// Both Workers are listed for the same reason as tests/site.smoke.test.ts: the
// site's `MCP` service binding names the MCP Worker, and workerd refuses to
// start a Worker whose service binding names an undefined service.
const server = createTestHarness({
  workers: [{ configPath: './wrangler.jsonc' }, { configPath: './workers/mcp/wrangler.jsonc' }],
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

const html = async (path: string) => {
  const response = await server.fetch(path);
  expect(response.status, `${path} should be 200`).toBe(200);
  return response.text();
};

test('sets the theme before first paint', async () => {
  const page = await html('/');
  // The script must be inline and in the head -- a deferred or bundled script
  // paints the wrong theme first, which is the whole failure being prevented.
  const head = page.slice(0, page.indexOf('</head>'));
  expect(head).toContain('rl-theme');
  expect(head).toContain('prefers-color-scheme');
  expect(head).toContain('data-theme');
  // A bundled module script would carry a src= instead of a body.
  expect(head).not.toMatch(/<script[^>]+src=[^>]*rl-theme/);
});

test('does not hardcode a theme on the html element', async () => {
  const page = await html('/');
  // The server must not guess; the script decides. A server-rendered value
  // would be wrong for half of all visitors on their first paint.
  expect(page).not.toMatch(/<html[^>]+data-theme=/);
});

test('exposes an accessible theme toggle', async () => {
  const page = await html('/');
  expect(page).toContain('data-theme-toggle');
  expect(page).toMatch(/aria-label="[^"]*[Tt]heme[^"]*"/);
});
