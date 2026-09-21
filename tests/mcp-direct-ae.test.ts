import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS, MCP_WORKER } from './workers';
import { routeClassFor } from '../src/lib/agent-intel/classify';
import { VIA_SITE_HEADER, VIA_SITE_VALUE } from '../src/lib/mcp/via';

/**
 * A direct `/mcp` request writes one Analytics Engine row with surface `mcp`;
 * a request the site forwarded, marked with the via header, writes none here
 * because the site already wrote its own. Measured 2026-09-20 before this
 * suite existed: the direct case wrote nothing, and /ops had never seen the
 * surface.
 */
type MockAeModule = typeof import('../workers/mock-ae/src/index');
const MOCK_AE_WORKER = { configPath: './workers/mock-ae/wrangler.jsonc' };

const server = createTestHarness({
  workers: [
    { ...MCP_WORKER, bindingOverrides: { ...MCP_WORKER.bindingOverrides, AE: 'mock-ae' } },
    ...MCP_HARNESS_WORKERS.filter((worker) => worker !== MCP_WORKER),
    MOCK_AE_WORKER,
  ],
});
let mockAe: Awaited<
  ReturnType<ReturnType<typeof server.getWorker<unknown, MockAeModule>>['getExport']>
>;

beforeAll(async () => {
  await server.listen();
  mockAe = await server.getWorker<unknown, MockAeModule>('mock-ae').getExport();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await mockAe.reset();
});

function toolsListInit(headers: Record<string, string>) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  };
}

function toolsList(headers: Record<string, string>) {
  return server.getWorker('ryanlindsey-me-mcp').fetch('/mcp', toolsListInit(headers));
}

/**
 * The same call addressed to the SITE Worker, which forwards it over its `MCP`
 * service binding -- so the via header is the one src/worker.ts really sets
 * rather than one a test wrote.
 */
function toolsListThroughSite(headers: Record<string, string>) {
  return server.getWorker('ryanlindsey-me').fetch('/mcp', toolsListInit(headers));
}

test('a direct /mcp request lands one row with surface mcp', async () => {
  const response = await toolsList({ 'user-agent': 'ClaudeBot/1.0' });
  expect(response.status).toBe(200);

  let points: Awaited<ReturnType<typeof mockAe.points>> = [];
  await vi.waitFor(async () => {
    points = await mockAe.points();
    expect(points).toHaveLength(1);
  });
  // AE_BLOB_FIELDS (src/lib/agent-intel/record.ts): agent_class, agent,
  // route_class, referrer_class, surface, status_class.
  expect(points[0]?.blobs?.[1]).toBe('ClaudeBot');
  expect(points[0]?.blobs?.[2]).toBe(routeClassFor('/mcp'));
  expect(points[0]?.blobs?.[4]).toBe('mcp');
  expect(points[0]?.blobs?.[5]).toBe('2xx');
  expect(points[0]?.doubles?.[0]).toBe(1);
  expect(points[0]?.doubles?.[1]).toBeGreaterThanOrEqual(0);
});

test('a /mcp request the site forwarded writes no row here', async () => {
  // A negative asserted through a positive: the forwarded request goes first,
  // then a direct one, and the single row that lands is the direct one's. A
  // bare "still zero after a wait" would pass on a slow write.
  // curl classifies as `http-client` and ClaudeBot as itself, which is how the
  // one row that lands is known to be the direct request's.
  const forwarded = await toolsList({
    'user-agent': 'curl/8.7.1',
    [VIA_SITE_HEADER]: VIA_SITE_VALUE,
  });
  expect(forwarded.status).toBe(200);
  const direct = await toolsList({ 'user-agent': 'ClaudeBot/1.0' });
  expect(direct.status).toBe(200);

  let points: Awaited<ReturnType<typeof mockAe.points>> = [];
  await vi.waitFor(async () => {
    points = await mockAe.points();
    expect(points).toHaveLength(1);
  });
  expect(points[0]?.blobs?.[1]).toBe('ClaudeBot');
});

test('a /mcp the real site Worker forwarded writes no row here', async () => {
  // THE SITE-SIDE MARKING, END TO END, and the reason this test exists beside
  // the one above rather than instead of it. That one hand-sets the via
  // header, so it proves this Worker HONOURS the header and nothing about
  // whether the site ever SENDS it. Measured 2026-09-20 during fix round 1:
  // with `markForwardedBySite` deleted from src/worker.ts's forward, every
  // suite in this repo still passed -- tests/pages.test.ts's handshake
  // included, because it checks the handshake and not the counting. So the
  // one line standing between production and a double count had no test at
  // all, and the failure would have been silent. This routes through the real
  // site Worker, so that deletion lands two rows here and fails on the length.
  //
  // The site writes its OWN row for this request and it is deliberately not
  // in `points()`: the `AE` override above is on the MCP Worker alone, so
  // SITE_WORKER's binding is miniflare's own simulated dataset and only what
  // the MCP Worker writes reaches the mock. That is what makes a length of 1
  // the whole assertion.
  const forwarded = await toolsListThroughSite({ 'user-agent': 'curl/8.7.1' });
  expect(forwarded.status).toBe(200);
  const direct = await toolsList({ 'user-agent': 'ClaudeBot/1.0' });
  expect(direct.status).toBe(200);

  let points: Awaited<ReturnType<typeof mockAe.points>> = [];
  await vi.waitFor(async () => {
    points = await mockAe.points();
    expect(points).toHaveLength(1);
  });
  expect(points[0]?.blobs?.[1]).toBe('ClaudeBot');
});

test('the other paths on this Worker write nothing from the wrapper', async () => {
  // /chat and /search record their own rows in their own handlers, and the
  // discovery documents record none. The wrapper is for /mcp alone.
  const robots = await server.getWorker('ryanlindsey-me-mcp').fetch('/robots.txt', {
    headers: { 'user-agent': 'curl/8.7.1' },
  });
  expect(robots.status).toBe(200);
  const direct = await toolsList({ 'user-agent': 'ClaudeBot/1.0' });
  expect(direct.status).toBe(200);

  let points: Awaited<ReturnType<typeof mockAe.points>> = [];
  await vi.waitFor(async () => {
    points = await mockAe.points();
    expect(points).toHaveLength(1);
  });
  expect(points[0]?.blobs?.[1]).toBe('ClaudeBot');
});
