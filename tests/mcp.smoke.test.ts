import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_WORKER, MOCK_AI_WORKER } from './workers';

// The exact instructions the server is expected to advertise. Asserting the
// whole string — rather than scanning it for a list of disallowed words — is
// what keeps the server's self-description under review: any edit to it fails
// this test and has to be made deliberately.
const EXPECTED_INSTRUCTIONS =
  "Ryan Lindsey's professional corpus, exposed as MCP tools. " +
  'Public tools cover portfolio exploration. A private tier exists for scoped tokens; ' +
  'ask Ryan for access if you need it.';

// The MCP Worker plus the Workers AI stand-in its `ai` binding is overridden to.
// mock-ai is not optional here even though nothing in this file touches AI: the
// binding moved to this Worker with the corpus job, Workers AI has no local
// emulator, and an un-overridden `ai` binding makes booting this Worker open a
// real remote proxy session that fails without credentials. Shared with the site
// suites via tests/workers.ts rather than restated, so the override cannot drift
// between the two places this Worker is booted.
const server = createTestHarness({
  workers: [MCP_WORKER, MOCK_AI_WORKER],
});

beforeAll(async () => {
  await server.listen();
});

afterAll(async () => {
  await server.close();
});

async function rpc(body: unknown) {
  const response = await server.fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // Streamable HTTP may answer as JSON or as a single SSE frame.
  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5)
          .trim()
      : text;
  return { status: response.status, json: JSON.parse(payload) };
}

function initialize(id: number) {
  return rpc({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
}

test('completes the initialize handshake', async () => {
  const { status, json } = await initialize(1);

  expect(status).toBe(200);
  expect(json.result.serverInfo.name).toBe('ryanlindsey-me');
  expect(json.result.protocolVersion).toBeTruthy();
});

test('advertises exactly the reviewed server instructions', async () => {
  const { json } = await initialize(2);

  // Top level of the result, per the spec — not nested inside serverInfo.
  expect(json.result.instructions).toBe(EXPECTED_INSTRUCTIONS);
});
