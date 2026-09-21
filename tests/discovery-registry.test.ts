import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import {
  buildRegistryEntry,
  REGISTRY_REMOTE_URL,
  REGISTRY_SERVER_NAME,
} from '../src/lib/discovery/registry-entry';
import { buildRegistryAuth, MCP_REGISTRY_PUBLIC_KEY } from '../src/lib/discovery/registry-auth';
import { DISCOVERY_VERSION } from '../src/lib/discovery/version';
import { SITE_ORIGIN } from '../src/lib/markdown-export';
import { MCP_ORIGIN } from '../workers/mcp/src/origin';
import { buildMcpServerCard } from '../src/lib/discovery/server-card';
import { SITE_HARNESS_WORKERS } from './workers';

/**
 * The registry entry is built, not committed, so these are the assertions
 * that would otherwise have pinned a committed copy: the version is the one
 * every discovery document advertises, the remote is the endpoint every
 * document names, and the description is the card's. The registry schema
 * (static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json,
 * read 2026-09-20) bounds `name` to `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$` with
 * exactly one slash, and `description` to 100 characters.
 */
test('the registry entry names this server under the domain namespace', () => {
  const entry = buildRegistryEntry(DISCOVERY_VERSION);
  expect(entry.name).toBe('me.ryanlindsey/ryanlindsey-me');
  expect(entry.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  expect(entry.name.split('/')).toHaveLength(2);
  expect(REGISTRY_SERVER_NAME).toBe(entry.name);
});

test('the registry entry carries the version it is given, the endpoint and the card description', () => {
  const entry = buildRegistryEntry(DISCOVERY_VERSION);
  expect(entry.version).toBe(DISCOVERY_VERSION);
  expect(entry.remotes).toEqual([{ type: 'streamable-http', url: `${MCP_ORIGIN}/mcp` }]);
  expect(REGISTRY_REMOTE_URL).toBe(`${MCP_ORIGIN}/mcp`);
  expect(entry.websiteUrl).toBe(SITE_ORIGIN);
  expect(entry.description).toBe(buildMcpServerCard(MCP_ORIGIN).description);
  expect(entry.description.length).toBeLessThanOrEqual(100);
  expect(entry.$schema).toBe(
    'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  );
  expect(entry).not.toHaveProperty('packages');
});

test('the namespace proof is one line in the documented format', () => {
  // modelcontextprotocol.io/registry/authentication, read 2026-09-20:
  // `v=MCPv1; k=ed25519; p=<base64 of the 32 raw public-key bytes>`. Thirty-two
  // bytes base64 is 43 characters and one `=`.
  expect(buildRegistryAuth()).toBe(`v=MCPv1; k=ed25519; p=${MCP_REGISTRY_PUBLIC_KEY}`);
  expect(MCP_REGISTRY_PUBLIC_KEY).toMatch(/^[A-Za-z0-9+/]{43}=$/);
});

// Born to police a three-edit change: registry-auth.ts shipped a sentinel
// public key while issue #310 step 1 was still owner-run and undone, and the
// day the real key landed the placeholder paragraph and the skip on the test
// above both had to go with it. The key landed 2026-09-21, so the transition
// this was written for is over and the early return it used to take on the
// sentinel is gone. It stays as a live assertion because it costs one file
// read and still catches the thing that made the scaffolding necessary: a
// placeholder or a skip reintroduced here would otherwise make the proof
// untested while the suite stayed green. Reads both files as text, the way
// tests/mcp-env.test.ts reads wrangler configs to catch drift no import sees.
test('the registry key carries no placeholder text or skipped test', async () => {
  const authSource = await readFile('src/lib/discovery/registry-auth.ts', 'utf8');
  const thisSource = await readFile('tests/discovery-registry.test.ts', 'utf8');
  // Split so this line's own source text never spells the marker it looks
  // for -- otherwise this test would keep failing itself forever, even after
  // the real skip above is gone.
  const skipMarker = 'test' + '.skip(';
  expect(authSource).not.toContain('PLACEHOLDER');
  expect(thisSource).not.toContain(skipMarker);
});

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });
beforeAll(async () => {
  await server.listen();
});
afterAll(async () => {
  await server.close();
});

test('the deployed proof ships as one plain-text line', async () => {
  const response = await server.fetch('/.well-known/mcp-registry-auth');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(await response.text()).toBe(`${buildRegistryAuth()}\n`);
});
