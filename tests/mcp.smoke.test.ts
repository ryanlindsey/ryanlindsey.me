import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';

// The exact instructions the server is expected to advertise. Asserting the
// whole string — rather than scanning it for a list of disallowed words — is
// what keeps the server's self-description under review: any edit to it fails
// this test and has to be made deliberately.
const EXPECTED_INSTRUCTIONS =
  "Ryan Lindsey's professional corpus, exposed as MCP tools. " +
  'Public tools cover portfolio exploration. A private tier exists for scoped tokens; ' +
  'ask Ryan for access if you need it.';

const server = createTestHarness({
  workers: [{ configPath: './workers/mcp/wrangler.jsonc' }],
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
