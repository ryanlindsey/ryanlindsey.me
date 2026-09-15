import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { buildMcpServerCard } from '../src/lib/discovery/server-card';
import { DISCOVERY_VERSION } from '../src/lib/discovery/version';
import { SITE_HARNESS_WORKERS } from './workers';

test('the card carries the fields the scanner requires', () => {
  const card = buildMcpServerCard('https://ryanlindsey.me');
  expect(card.serverInfo.name).toBe('ryanlindsey-me');
  expect(card.serverInfo.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(card.transport.type).toBe('streamable-http');
});

test('each origin gets a card describing itself, never the other', () => {
  expect(buildMcpServerCard('https://ryanlindsey.me').url).toBe('https://ryanlindsey.me/mcp');
  expect(buildMcpServerCard('https://mcp.ryanlindsey.me').url).toBe(
    'https://mcp.ryanlindsey.me/mcp',
  );
});

test('the discovery version matches the one the MCP server advertises', async () => {
  const source = await readFile('workers/mcp/src/server.ts', 'utf8');
  const marker = /version: '([^']+)' \}, \/\/ x-release-please-version/.exec(source);
  expect(marker?.[1]).toBe(DISCOVERY_VERSION);
});

test('the discovery version matches package.json', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  expect(pkg.version).toBe(DISCOVERY_VERSION);
});

// See tests/workers.ts for why the site Worker is booted from the build
// output and why the MCP Worker is always listed with it.
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

test('the deployed card ships the declared Content-Type', async () => {
  const response = await server.fetch('/.well-known/mcp/server-card.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  // Cast to the shape `buildMcpServerCard` actually returns, the same
  // as-cast convention tests/mcp.smoke.test.ts and tests/agent-consumption.test.ts
  // already use for `response.json()`, which types as `unknown`.
  const card = (await response.json()) as ReturnType<typeof buildMcpServerCard>;
  expect(card.serverInfo.name).toBe('ryanlindsey-me');
});
