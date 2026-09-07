import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_WORKER, MOCK_AI_WORKER } from './workers';

const server = createTestHarness({ workers: [MCP_WORKER, MOCK_AI_WORKER] });

// The harness starts this Worker on EMPTY storage rather than on the
// `workers/mcp/.wrangler/state` directory `wrangler d1 migrations apply --local`
// writes to -- measured: `SELECT name FROM sqlite_master` returns nothing before
// this call and `mcp_tool_calls` after it. So the migration has to be applied
// here, which is also what keeps this suite credential-free: `applyD1Migrations`
// runs migrations/0001_mcp_audit.sql against the local simulation and never
// contacts the account.
beforeAll(async () => {
  await server.listen();
  await server.getWorker('ryanlindsey-me-mcp').applyD1Migrations('DB');
});
afterAll(async () => {
  await server.close();
});

/** One JSON-RPC round trip. Streamable HTTP may answer as JSON or one SSE frame. */
export async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const response = await server.fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? text
          .split('\n')
          .find((l) => l.startsWith('data:'))!
          .slice(5)
          .trim()
      : text;
  return { status: response.status, json: JSON.parse(payload) };
}

let id = 0;
export function callTool(
  name: string,
  args?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return rpc(
    { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args ?? {} } },
    headers,
  );
}

/**
 * Defined here as well as in tests/mcp.smoke.test.ts, deliberately: Task 12
 * and Task 15 both assert over the initialize result from THIS suite, and
 * importing a helper across two harness files would boot two harnesses.
 */
export function initialize(callId: number) {
  return rpc({
    jsonrpc: '2.0',
    id: callId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'tools', version: '0' },
    },
  });
}

/** The audit table, through the same local D1 simulation the Worker writes to. */
async function auditDb() {
  return (await server.getWorker<{ DB: D1Database }>('ryanlindsey-me-mcp').getEnv()).DB;
}

/**
 * Waits for `atLeast` audit rows.
 *
 * `defineTool` dispatches the audit write through `ctx.waitUntil`, so it is
 * deliberately still in flight when the tool's response reaches the client --
 * a caller never waits on the audit trail. Reading the table the instant the
 * response arrives is therefore a race, and polling for the expected count is
 * what makes these assertions about the audit trail rather than about timing.
 */
async function waitForAuditRows(db: D1Database, atLeast: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM mcp_tool_calls').first<{ n: number }>();
    if ((row?.n ?? 0) >= atLeast) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`audit rows never reached ${atLeast}`);
}

// The payload `get_contact` answered with BEFORE it moved onto `defineTool`,
// captured from this same harness. `defineTool` wraps every tool in the
// limiter and the audit trail; this is the assertion that the wrapper changed
// nothing a client sees.
const GET_CONTACT_RESULT = {
  content: [
    {
      type: 'text',
      text: JSON.stringify(
        {
          email: 'hello@ryanlindsey.me',
          site: 'https://ryanlindsey.me',
          timezone: 'America/Los_Angeles',
        },
        null,
        2,
      ),
    },
  ],
};

test('get_contact returns the same payload it returned before the wrapper', async () => {
  const { status, json } = await callTool('get_contact');

  expect(status).toBe(200);
  expect(json.result).toEqual(GET_CONTACT_RESULT);
});

test('every registered tool call writes exactly one audit row', async () => {
  const db = await auditDb();
  await db.prepare('DELETE FROM mcp_tool_calls').run();

  await callTool('get_contact');
  await waitForAuditRows(db, 1);

  const { results } = await db
    .prepare('SELECT tool, tier, audience, outcome FROM mcp_tool_calls')
    .all();
  expect(results).toEqual([{ tool: 'get_contact', tier: 'public', audience: null, outcome: 'ok' }]);
});

test('the audit row records a hash, never the arguments', async () => {
  const db = await auditDb();
  await db.prepare('DELETE FROM mcp_tool_calls').run();

  await callTool('get_contact');
  await waitForAuditRows(db, 1);

  const row = await db
    .prepare('SELECT args_hash FROM mcp_tool_calls')
    .first<{ args_hash: string }>();
  expect(row?.args_hash).toMatch(/^[0-9a-f]{64}$/);
});

/**
 * The audit table's four identity columns, both ways round.
 *
 * This server is stateless -- a fresh `McpServer` per HTTP request -- so a
 * 2025-era client's `initialize` handshake tells a later `tools/call`
 * nothing, and only the 2026-07-28 per-request `_meta` envelope carries
 * client identity on the call itself. The point of asserting the legacy row
 * is NULL is that the alternative is worse than a blank column: a fabricated
 * `client_name` would make the audit trail read as evidence of something it
 * never observed.
 *
 * The three `mcp-*` headers are what makes a request modern-era to this SDK,
 * measured by watching it answer -32020 without them.
 */
test('audits the client identity a call genuinely carries, and no more', async () => {
  const db = await auditDb();
  await db.prepare('DELETE FROM mcp_tool_calls').run();

  await initialize(900);
  await callTool('get_contact', {}, { 'user-agent': 'legacy-probe/1.0' });
  await rpc(
    {
      jsonrpc: '2.0',
      id: 901,
      method: 'tools/call',
      params: {
        name: 'get_contact',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'modern-probe', version: '2.1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
    {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'get_contact',
      'user-agent': 'modern-probe/1.0',
    },
  );
  await waitForAuditRows(db, 2);

  const { results } = await db
    .prepare(
      'SELECT client_name, client_version, user_agent, protocol_version FROM mcp_tool_calls ORDER BY id',
    )
    .all();
  expect(results).toEqual([
    {
      client_name: null,
      client_version: null,
      user_agent: 'legacy-probe/1.0',
      protocol_version: null,
    },
    {
      client_name: 'modern-probe',
      client_version: '2.1',
      user_agent: 'modern-probe/1.0',
      protocol_version: '2026-07-28',
    },
  ]);
});

test('refuses past the limit and records the refusal', async () => {
  const db = await auditDb();
  await db.prepare('DELETE FROM mcp_tool_calls').run();

  const attempts = [];
  for (let i = 0; i < 70; i++) attempts.push(await callTool('get_contact'));

  const refused = attempts.filter((a) => a.json.result?.isError === true);
  expect(refused.length).toBeGreaterThan(0);

  // A refusal is a tool result, not a transport error: the client should see
  // a readable message rather than a broken connection.
  expect(refused[0]!.status).toBe(200);
  expect(JSON.stringify(refused[0]!.json)).toMatch(/rate/i);

  // Refusals are audited too -- an unaudited refusal would make the table
  // under-report exactly the traffic worth looking at.
  await waitForAuditRows(db, attempts.length);
  const { results } = await db
    .prepare("SELECT COUNT(*) AS n FROM mcp_tool_calls WHERE outcome = 'rate_limited'")
    .all<{ n: number }>();
  expect(results[0]!.n).toBeGreaterThan(0);
});
