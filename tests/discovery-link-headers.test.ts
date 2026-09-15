import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { SITE_HARNESS_WORKERS, MCP_HARNESS_WORKERS } from './workers';

/** Parses an RFC 8288 field value into { rel -> target } pairs. */
function parseLink(value: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const part of value.split(/,\s*(?=<)/)) {
    const target = /^<([^>]+)>/.exec(part.trim())?.[1];
    const rel = /rel="?([^";]+)"?/.exec(part)?.[1];
    if (target && rel) links.set(rel, target);
  }
  return links;
}

// See ./workers.ts for why the site Worker is booted from the build output and
// why the MCP Worker is always listed with it.
const server = createTestHarness({
  workers: SITE_HARNESS_WORKERS,
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

test('the homepage advertises all four relations', async () => {
  const response = await server.fetch('/');
  const links = parseLink(response.headers.get('link') ?? '');
  expect(links.get('service-desc')).toBe('/.well-known/mcp/server-card.json');
  expect(links.get('api-catalog')).toBe('/.well-known/api-catalog');
  expect(links.get('describedby')).toBe('/.well-known/agent-skills/index.json');
  expect(links.get('service-doc')).toBe('/llms.txt');
});

// The reason this issue is blocked by the other four. A Link header pointing at
// a 404 is worse than no header at all.
test('every advertised target actually resolves', async () => {
  const response = await server.fetch('/');
  for (const [rel, target] of parseLink(response.headers.get('link') ?? '')) {
    const fetched = await server.fetch(target);
    expect(fetched.status, `${rel} -> ${target}`).toBe(200);
  }
});

test('the header is one value, not two rules joined', async () => {
  const response = await server.fetch('/');
  // Four targets, so three separators. A comma-joined pair from two _headers
  // rules would show more.
  expect((response.headers.get('link') ?? '').match(/<\//g)?.length).toBe(4);
});

// Step 6: the MCP Worker's own copy, set in code (workers/mcp/src/index.ts)
// because public/_headers does not apply to this origin at all. MCP_HARNESS_
// WORKERS puts the MCP Worker first, so relative mcpServer.fetch() calls below
// address it; the site is still in the list (its own SITE service binding
// requires it).
const mcpServer = createTestHarness({
  workers: MCP_HARNESS_WORKERS,
});

/**
 * Dispatches to the Worker that actually owns an advertised target's origin,
 * by NAME rather than by the target's absolute URL.
 *
 * MEASURED (2026-09-14), not assumed: a bare `custom_domain` route pattern like
 * `ryanlindsey.me` (wrangler.jsonc's own `routes` entry) parses under this
 * harness's dev-routing to an EXACT match on path `/` only, not every path
 * beneath that host the way a real Cloudflare Custom Domain behaves --
 * `server.fetch('https://ryanlindsey.me/llms.txt')` against this harness 404s,
 * because nothing matches and the request falls back to the PRIMARY Worker
 * (the MCP Worker here) with the pathname intact, which has no branch for
 * `/llms.txt`. `getWorker(name).fetch(path)` -- the mechanism the harness's own
 * doc comment names for this exact case -- sidesteps host routing entirely.
 */
function dispatchTo(target: string) {
  if (target.startsWith('https://mcp.ryanlindsey.me')) {
    return mcpServer
      .getWorker('ryanlindsey-me-mcp')
      .fetch(target.replace('https://mcp.ryanlindsey.me', ''));
  }
  if (target.startsWith('https://ryanlindsey.me')) {
    return mcpServer
      .getWorker('ryanlindsey-me')
      .fetch(target.replace('https://ryanlindsey.me', ''));
  }
  throw new Error(`unrecognised target origin: ${target}`);
}

beforeAll(async () => {
  await mcpServer.listen();
});

afterAll(async () => {
  await mcpServer.close();
});

// This origin serves no catalog and no skills index (workers/mcp/src/index.ts
// has no route for either), so both relations are absent -- naming one would
// be the same 404 problem the site's own header exists to avoid, moved here.
test('the MCP origin advertises only the documents it actually serves', async () => {
  for (const path of [
    '/.well-known/mcp.json',
    '/.well-known/mcp/server-card.json',
    '/.well-known/oauth-protected-resource',
  ]) {
    const response = await mcpServer.fetch(path);
    const links = parseLink(response.headers.get('link') ?? '');
    expect(links.get('service-desc'), path).toBe(
      'https://mcp.ryanlindsey.me/.well-known/mcp/server-card.json',
    );
    expect(links.get('service-doc'), path).toBe('https://ryanlindsey.me/llms.txt');
    expect(links.has('api-catalog'), `${path} should not advertise a catalog`).toBe(false);
    expect(links.has('describedby'), `${path} should not advertise a skills index`).toBe(false);
  }
});

test('every relation the MCP origin advertises actually resolves', async () => {
  const response = await mcpServer.fetch('/.well-known/mcp.json');
  for (const [rel, target] of parseLink(response.headers.get('link') ?? '')) {
    const fetched = await dispatchTo(target);
    expect(fetched.status, `${rel} -> ${target}`).toBe(200);
  }
});
