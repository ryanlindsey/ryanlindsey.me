import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { buildProtectedResource } from '../src/lib/discovery/protected-resource';
import { buildAuthDoc } from '../src/lib/discovery/auth-doc';
import { SCOPES } from '../src/lib/tier/token';
import { buildMcpDiscovery } from '../src/lib/mcp/discovery';
import { SITE_HARNESS_WORKERS } from './workers';

test('the document names every scope except evals, derived rather than typed', () => {
  const doc = buildProtectedResource('https://mcp.ryanlindsey.me/mcp');
  expect(doc.scopes_supported).toEqual(SCOPES.filter((s) => s !== 'evals'));
  expect(doc.scopes_supported).not.toContain('evals');
});

test('no authorization server is named, because none exists', () => {
  expect(buildProtectedResource('https://mcp.ryanlindsey.me/mcp')).not.toHaveProperty(
    'authorization_servers',
  );
});

// The tension the epic names, pinned so a later editor cannot collapse the two
// documents into one. `authentication: 'none'` says what the advertised
// endpoint REQUIRES; the protected-resource document says what it ACCEPTS.
test('the two discovery documents still disagree in the intended direction', () => {
  expect(buildMcpDiscovery('https://ryanlindsey.me').authentication).toBe('none');
  expect(buildProtectedResource('https://mcp.ryanlindsey.me/mcp').bearer_methods_supported).toEqual(
    ['header'],
  );
});

test('auth.md sends the reader to the address that issues tokens', () => {
  const doc = buildAuthDoc();
  expect(doc).toContain('hello@ryanlindsey.me');
  expect(doc).toContain('/.well-known/oauth-protected-resource');
});

test('auth.md claims no OAuth flow it cannot perform', () => {
  const doc = buildAuthDoc().toLowerCase();
  for (const claim of ['authorization_endpoint', 'token_endpoint', 'client_id', 'redirect_uri']) {
    expect(doc).not.toContain(claim);
  }
});

// Served-response coverage for both new site routes, the same discipline
// tests/discovery-server-card.test.ts applies to /.well-known/mcp/server-
// card.json: a public/_headers RULE with no assertion against a real
// response is the half most likely to be wrong, and this is doubly true for
// the extensionless /.well-known/oauth-protected-resource -- Cloudflare's
// mime lookup has nothing to work from there, so without this test a typo in
// that rule would ship silently.
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

test('the deployed protected-resource document ships the declared Content-Type', async () => {
  const response = await server.fetch('/.well-known/oauth-protected-resource');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  const doc = (await response.json()) as ReturnType<typeof buildProtectedResource>;
  expect(doc.resource).toBe('https://mcp.ryanlindsey.me/mcp');
  expect(doc.scopes_supported).toEqual(SCOPES.filter((s) => s !== 'evals'));
});

test('the deployed auth.md ships the declared Content-Type', async () => {
  const response = await server.fetch('/auth.md');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  const body = await response.text();
  expect(body).toContain('hello@ryanlindsey.me');
});
