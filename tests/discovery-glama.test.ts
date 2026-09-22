import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { buildGlamaClaim, GLAMA_CLAIM_TOKEN } from '../src/lib/discovery/glama';
import { MCP_HARNESS_WORKERS, SITE_HARNESS_WORKERS } from './workers';

test('the claim file matches the connector schema', () => {
  // glama.ai/mcp/schemas/connector.json, read 2026-09-20: `claim` is
  // `^glama_claim_[A-Za-z0-9_-]{32}$`, and `$schema` is what the FAQ's own
  // example carries.
  const doc = buildGlamaClaim();
  expect(doc).toEqual({
    $schema: 'https://glama.ai/mcp/schemas/connector.json',
    claim: GLAMA_CLAIM_TOKEN,
  });
  expect(GLAMA_CLAIM_TOKEN).toMatch(/^glama_claim_[A-Za-z0-9_-]{32}$/);
});

// See ./workers.ts for why each harness lists both Workers.
const mcpServer = createTestHarness({ workers: MCP_HARNESS_WORKERS });
const siteServer = createTestHarness({ workers: SITE_HARNESS_WORKERS });

beforeAll(async () => {
  await mcpServer.listen();
  await siteServer.listen();
});

afterAll(async () => {
  await mcpServer.close();
  await siteServer.close();
});

test('the MCP origin serves the claim as JSON', async () => {
  const response = await mcpServer.fetch('/.well-known/glama.json');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  // The claim is not a discovery document, so it advertises nothing. Pinned
  // here because discovery-link-headers.test.ts cannot catch it: that suite
  // iterates three hard-coded paths and never sees this one, so without this
  // line a later edit could add `Link: discoveryLinkHeader()` to the branch
  // and every test would still pass.
  expect(response.headers.get('link')).toBeNull();
  expect(await response.json()).toEqual(buildGlamaClaim());
});

test('the site origin does not serve it, because the claim belongs to the connector origin', async () => {
  const response = await siteServer.fetch('/.well-known/glama.json');
  expect(response.status).toBe(404);
});
