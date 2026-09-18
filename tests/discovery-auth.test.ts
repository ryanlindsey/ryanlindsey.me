import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { buildProtectedResource } from '../src/lib/discovery/protected-resource';
import { buildAuthDoc } from '../src/lib/discovery/auth-doc';
import { SCOPES } from '../src/lib/tier/token';
import { buildMcpDiscovery } from '../src/lib/mcp/discovery';
import { SITE_HARNESS_WORKERS } from './workers';

// The withheld scopes, RESTATED here rather than imported from
// src/lib/tier/token.ts, and that restatement is the whole value of the
// assertions below. A test that imported `PUBLIC_SCOPES` would agree with any
// change made to it, including the change that widens it; this list has to be
// edited by a second hand before a scope can start appearing in public
// metadata. It was one literal `!== 'evals'` in each place until epic 263
// added a second withheld scope.
const WITHHELD = ['evals', 'authoring'];

test('the document names every scope except the withheld ones, derived rather than typed', () => {
  const doc = buildProtectedResource('https://mcp.ryanlindsey.me');
  expect(doc.scopes_supported).toEqual(SCOPES.filter((s) => !WITHHELD.includes(s)));
  for (const scope of WITHHELD) expect(doc.scopes_supported).not.toContain(scope);
});

test('no authorization server is named, because none exists', () => {
  expect(buildProtectedResource('https://mcp.ryanlindsey.me')).not.toHaveProperty(
    'authorization_servers',
  );
});

// The tension the epic names, pinned so a later editor cannot collapse the two
// documents into one. `authentication: 'none'` says what the advertised
// endpoint REQUIRES; the protected-resource document says what it ACCEPTS.
test('the two discovery documents still disagree in the intended direction', () => {
  expect(buildMcpDiscovery('https://ryanlindsey.me').authentication).toBe('none');
  expect(buildProtectedResource('https://mcp.ryanlindsey.me').bearer_methods_supported).toEqual([
    'header',
  ]);
});

// Epic-165 follow-up review, finding B: `resource` must identify the origin
// that served THIS copy of the document (RFC 9728 §2), not a literal shared
// between the two origins that each publish one. A production scan
// (isitagentready.com) caught the old shared-literal version failing exactly
// this check against the site's own copy. `buildProtectedResource` now takes
// an origin and derives `resource` from it, so this is asserted directly
// rather than trusted to the two callers passing the right string.
test('resource identifies whichever origin served this document, per RFC 9728', () => {
  expect(buildProtectedResource('https://ryanlindsey.me').resource).toBe(
    'https://ryanlindsey.me/mcp',
  );
  expect(buildProtectedResource('https://mcp.ryanlindsey.me').resource).toBe(
    'https://mcp.ryanlindsey.me/mcp',
  );
});

// Epic-165 follow-up review, finding A: the canonical auth.md protocol
// (github.com/workos/auth.md) opens with exactly this heading, and the
// epic's own acceptance scanner (isitagentready.com) checks for it
// literally -- our document opened `# Authorization` instead, which read
// fine to a person and read as a missing document to the scanner.
test('auth.md opens with the canonical heading the scanner checks for', () => {
  expect(buildAuthDoc().startsWith('# auth.md\n')).toBe(true);
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

// Epic-165 follow-up review, finding 5: withholding is structural on the JSON
// side (buildProtectedResource's `scopes_supported` is derived from
// PUBLIC_SCOPES, a typo cannot silently widen an array nothing hand-writes),
// but auth.md is prose -- a reviewer or an editor typing a sentence that
// names a withheld scope would pass every other assertion in this file,
// because none of them scans the WHOLE document for the literal word. This is
// that scan, and it loops because there are now two words to look for rather
// than the one `evals` it was written for.
test('auth.md never names a withheld scope', () => {
  const doc = buildAuthDoc();
  for (const scope of WITHHELD) expect(doc).not.toContain(scope);
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
  // The SITE's own copy, so `resource` names the site's own `/mcp` -- NOT the
  // MCP Worker's vanity domain. This used to read `https://mcp.ryanlindsey.me/mcp`
  // here, which was the exact self-inconsistency (epic-165 follow-up review,
  // finding B) a production scan caught: this document is served FROM
  // ryanlindsey.me, so RFC 9728 §2 requires it to name ryanlindsey.me.
  expect(doc.resource).toBe('https://ryanlindsey.me/mcp');
  expect(doc.scopes_supported).toEqual(SCOPES.filter((s) => !WITHHELD.includes(s)));
});

test('the deployed auth.md ships the declared Content-Type', async () => {
  const response = await server.fetch('/auth.md');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  const body = await response.text();
  expect(body).toContain('hello@ryanlindsey.me');
});
