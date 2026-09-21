import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import {
  buildServerCardV1,
  SERVER_CARD_MEDIA_TYPE,
  SERVER_CARD_SCHEMA_URL,
} from '../src/lib/discovery/server-card-v1';
import { buildRegistryEntry } from '../src/lib/discovery/registry-entry';
import { DISCOVERY_VERSION } from '../src/lib/discovery/version';
import { MCP_HARNESS_WORKERS } from './workers';

test('the card is the registry entry with the card schema and the serving origin', () => {
  const card = buildServerCardV1('https://mcp.ryanlindsey.me');
  const entry = buildRegistryEntry(DISCOVERY_VERSION);
  expect(card.$schema).toBe(SERVER_CARD_SCHEMA_URL);
  expect(card.name).toBe(entry.name);
  expect(card.description).toBe(entry.description);
  expect(card.version).toBe(DISCOVERY_VERSION);
  expect(card.title).toBe(entry.title);
  expect(card.websiteUrl).toBe(entry.websiteUrl);
  expect(card.repository).toEqual(entry.repository);
  expect(card.remotes).toEqual([
    { type: 'streamable-http', url: 'https://mcp.ryanlindsey.me/mcp' },
  ]);
  // Card-only, by the extension's own README: no primitive listings.
  expect(card).not.toHaveProperty('capabilities');
  expect(card).not.toHaveProperty('tools');
  expect(card).not.toHaveProperty('packages');
});

test('each origin gets a card whose remote is itself', () => {
  expect(buildServerCardV1('https://ryanlindsey.me').remotes[0]?.url).toBe(
    'https://ryanlindsey.me/mcp',
  );
});

const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
beforeAll(async () => {
  await server.listen();
});
afterAll(async () => {
  await server.close();
});

test('the MCP origin serves the card at the reserved place with every mandatory header', async () => {
  // docs/discovery.md in the extension repository, read 2026-09-20: the four
  // Access-Control headers are MUST, Cache-Control and ETag are SHOULD.
  const response = await server.fetch('/mcp/server-card');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(SERVER_CARD_MEDIA_TYPE);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('access-control-allow-methods')).toBe('GET');
  expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type, If-None-Match');
  expect(response.headers.get('access-control-expose-headers')).toBe('ETag');
  expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/);
  const card = (await response.json()) as ReturnType<typeof buildServerCardV1>;
  expect(card).toEqual(buildServerCardV1('https://mcp.ryanlindsey.me'));
});

test('a matching If-None-Match answers 304 with no body', async () => {
  const first = await server.fetch('/mcp/server-card');
  const etag = first.headers.get('etag')!;
  const second = await server.fetch('/mcp/server-card', { headers: { 'if-none-match': etag } });
  expect(second.status).toBe(304);
  expect(await second.text()).toBe('');
  expect(second.headers.get('etag')).toBe(etag);
});

test('the old card stays where it was, in its old shape', async () => {
  const response = await server.fetch('/.well-known/mcp/server-card.json');
  expect(response.status).toBe(200);
  const old = (await response.json()) as { serverInfo?: { name: string } };
  expect(old.serverInfo?.name).toBe('ryanlindsey-me');
});
