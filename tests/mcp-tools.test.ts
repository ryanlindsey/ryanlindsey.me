import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { LIMITS } from '../src/lib/mcp/limits';
import { MCP_WORKER, SITE_HARNESS_WORKERS } from './workers';
import { BANNED_PATTERNS } from './candidacy-patterns';

// The SITE too, not just the MCP Worker and its mock AI. Every content tool
// reads the site's published documents (src/lib/mcp/documents.ts), so a suite
// without the site cannot test those tools at all. Since issue #28 that is no
// longer merely inconvenient but structural: the MCP Worker's `SITE` service
// binding names `ryanlindsey-me`, and workerd refuses to start a Worker whose
// service binding names an undefined service -- so EVERY harness that boots the
// MCP Worker now boots the site as well. The site is FIRST because
// `SITE_HARNESS_WORKERS` puts it first, which makes it the primary Worker --
// see `beforeAll` for why that matters and `rpc` for what it costs.
const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });

/**
 * Two things happen here, and the second is the interesting one.
 *
 * The harness starts this Worker on EMPTY storage rather than on the
 * `workers/mcp/.wrangler/state` directory `wrangler d1 migrations apply --local`
 * writes to -- measured: `SELECT name FROM sqlite_master` returns nothing before
 * this call and `mcp_tool_calls` after it. So the migration has to be applied
 * here, which is also what keeps this suite credential-free: `applyD1Migrations`
 * runs migrations/0001_mcp_audit.sql against the local simulation and never
 * contacts the account.
 *
 * Then `SITE_ORIGIN`. `workers/mcp/wrangler.jsonc` sets it to
 * https://ryanlindsey.me, and leaving it there would point every document read
 * in this suite at the live production site. So it is overridden to the
 * harness's OWN address -- MEASURED from `listen()` rather than assumed,
 * because the port is assigned at boot and there is no option to pin it. That
 * is why the override cannot be a static entry in tests/workers.ts and has to
 * arrive through `update()` after the server is up.
 *
 * WHAT THAT OVERRIDE IS FOR CHANGED UNDER THIS COMMENT, and the old version is
 * worth keeping visible because it described a mechanism that no longer exists.
 * It said the harness address being a real loopback origin was "what makes this
 * work at all" -- the MCP Worker's global `fetch` reaching it exactly as it
 * would reach ryanlindsey.me in production, matching no Worker's routes, and
 * therefore landing on the primary Worker, the site. True at the time. Issue #28
 * then replaced that global `fetch` with a `SITE` service binding
 * (workers/mcp/wrangler.jsonc), because fetching `SITE_ORIGIN` over the public
 * internet returned 522 whenever the request being served had itself arrived on
 * that hostname -- which is what `ryanlindsey.me/mcp` does.
 *
 * So the reads below no longer travel over HTTP at all, and would now succeed
 * against ANY value of this var. What the override still buys is narrower and
 * still real: `SITE_ORIGIN` is what every citation URL is built from, so
 * overriding it keeps this suite's `url`/`markdownUrl` assertions pointed at an
 * address this harness owns. Note the consequence for coverage, since it is the
 * kind of thing that quietly rots: because this origin is REACHABLE, a revert of
 * #28 back to global `fetch` would not fail this suite. The suite that would is
 * tests/mcp.smoke.test.ts, whose `SITE_ORIGIN` resolves nowhere on purpose --
 * that is where #28's regression guard lives, and this comment is the pointer to
 * it.
 */
beforeAll(async () => {
  const { url } = await server.listen();

  await server.update({
    workers: SITE_HARNESS_WORKERS.map((worker) =>
      worker === MCP_WORKER
        ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, SITE_ORIGIN: url.origin } }
        : worker,
    ),
  });

  // `update()` reloads the running Workers rather than restarting the session,
  // so the address measured above should still be the address. Checked rather
  // than trusted: if it ever moves, every document read fails against a dead
  // port and nothing in the failure would point back here.
  const { url: reloaded } = await server.listen();
  if (reloaded.origin !== url.origin) {
    throw new Error(`harness moved from ${url.origin} to ${reloaded.origin} across update()`);
  }

  // The override ARRIVED, asserted where it is visible. Nothing further down
  // this file can tell the harness apart from the live site: `basics.name`,
  // `/^# Ryan Lindsey/m` and the résumé's own `basics.url` are all equally
  // true of production. So if this override ever silently stopped applying,
  // every one of those tests would keep passing while reaching out over the
  // public internet, and the property this wiring exists for -- that the tools
  // read the local `dist/client` build -- would be gone with nothing to say so.
  // This line is the only thing standing between those two worlds.
  const mcp = server.getWorker<{ DB: D1Database; SITE_ORIGIN: string }>('ryanlindsey-me-mcp');
  expect((await mcp.getEnv()).SITE_ORIGIN).toBe(url.origin);

  await mcp.applyD1Migrations('DB');
});
afterAll(async () => {
  await server.close();
});

/**
 * One JSON-RPC round trip. Streamable HTTP may answer as JSON or one SSE frame.
 *
 * Dispatched at the MCP Worker BY NAME rather than through `server.fetch()`.
 * The relative-URL form resolves against the harness address and is routed by
 * route patterns, which now means the primary Worker -- and the primary Worker
 * has to be the site for the `SITE_ORIGIN` override above to reach anything.
 */
export async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const response = await server.getWorker('ryanlindsey-me-mcp').fetch('/mcp', {
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
  // 400, not 200: the three limiter-flake fixes below (`burstSize`) push the
  // largest row count this file waits on from 73 to 124, and the budget has
  // to clear whatever it asks for with room to spare rather than exactly
  // enough to have covered the old, smaller bursts.
  for (let attempt = 0; attempt < 400; attempt++) {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM mcp_tool_calls').first<{ n: number }>();
    if ((row?.n ?? 0) >= atLeast) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`audit rows never reached ${atLeast}`);
}

/**
 * How big a burst has to be to guarantee at least one refusal.
 *
 * The SIZE is unchanged from when this helper was written; the REASON is not,
 * and the old reason is recorded here rather than deleted because it was a
 * correct description of a mechanism this repo no longer uses. Until #29 the
 * limiter was Cloudflare's `ratelimits` binding, simulated locally by a FIXED,
 * wall-clock-aligned window (`epoch = Math.floor(Date.now() / (period * 1e3))`).
 * A burst of exactly `limit` calls could straddle a minute boundary and be
 * allowed twice over -- zero refusals, on roughly 1-4% of runs -- so the burst
 * was sized to exceed what two adjacent windows could jointly allow.
 *
 * The limiter is a token bucket in a Durable Object now
 * (workers/mcp/src/rate-limiter.ts), and a bucket has no boundary to straddle:
 * from full, exactly `limit` calls succeed. What it does instead is REFILL
 * while the burst is in flight, at `limit / periodSeconds` per second -- so a
 * burst of exactly `limit + 1` could still see zero refusals if the harness
 * took long enough to hand back one token. `2 * limit + 1` clears that by a
 * mile: at 60/60s it would take a full minute of refill to absorb, and these
 * bursts run in seconds.
 *
 * `allowedCeiling` below is the assertion this margin costs, and it is the one
 * that matters: a generous burst proves a refusal happened, but only a bound
 * on the SUCCESSES proves the limiter limited.
 */
function burstSize(limit: number): number {
  return 2 * limit + 1;
}

/**
 * The most successes a burst of any size may honestly produce.
 *
 * `limit` from a full bucket, plus whatever refilled while the burst ran, plus
 * one for the partial token at either end. THIS is the assertion #29 was
 * missing. The old limiter tests asserted only that refusals were greater than
 * zero, which a limiter that refuses one call in a hundred also satisfies --
 * and production was refusing none at all while these tests stayed green. A
 * ceiling on the allowed count fails against a limiter that has stopped
 * counting, which is the failure that actually shipped.
 */
function allowedCeiling(limit: number, periodSeconds: number, elapsedMs: number): number {
  return limit + Math.ceil((elapsedMs / 1000) * (limit / periodSeconds)) + 1;
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
  const db = await auditDb();
  const { status, json } = await callTool('get_contact');

  expect(status).toBe(200);
  expect(json.result).toEqual(GET_CONTACT_RESULT);

  // Not decoration: this call's audit row is written through `waitUntil` and
  // can otherwise land AFTER the next test has cleared the table, turning its
  // exact-row assertion into an intermittent two-row failure that looks
  // nothing like its cause. Every test here that calls a tool settles its own
  // audit writes before it returns.
  await waitForAuditRows(db, 1);
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
 * The property the audit schema is actually justified by.
 *
 * `migrations/0001_mcp_audit.sql` stores a hash instead of the arguments so
 * that "the same query, repeated" stays visible while the query itself does
 * not. That only works if identical calls hash identically -- and the way it
 * breaks is not a malformed digest but a well-formed digest of the wrong
 * object. The SDK hands a no-argument tool its `ServerContext` in the
 * parameter slot an `inputSchema` tool gets `args` in, and that context
 * carries the JSON-RPC request id, so hashing it yields a perfectly valid
 * 64-hex string that is DIFFERENT on every call. The fixed-width assertion
 * above passes on exactly that; this one does not.
 */
test('gives the same call the same args_hash every time', async () => {
  const db = await auditDb();
  await db.prepare('DELETE FROM mcp_tool_calls').run();

  await callTool('get_contact');
  await callTool('get_contact');
  await waitForAuditRows(db, 2);

  const { results } = await db
    .prepare('SELECT args_hash FROM mcp_tool_calls ORDER BY id')
    .all<{ args_hash: string }>();
  expect(results).toHaveLength(2);
  expect(results[0]!.args_hash).toBe(results[1]!.args_hash);
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

/**
 * Task 6's tool, and the first one registered through `registerTools`.
 *
 * Grouped under the tool's name so `vitest -t get_resume` selects exactly
 * these: the test names below describe a FORMAT, and none of them contains the
 * tool's name.
 */
describe('get_resume', () => {
  /**
   * `callTool`, plus the audit row it leaves behind.
   *
   * Every test in this file that calls a tool settles its own `waitUntil`
   * audit write before returning -- see the note on `waitForAuditRows`. Four
   * of the six tests below are the same shape, so the clearing and the
   * settling live here rather than three lines at a time in each of them.
   * Tasks 7-10 copy this group; a helper is one thing to copy correctly.
   */
  async function callAudited(name: string, args?: Record<string, unknown>) {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();
    const call = await callTool(name, args);
    await waitForAuditRows(db, 1);
    return call;
  }

  test('joins the audit trail without asking to, like every tool', async () => {
    await callAudited('get_resume', { format: 'summary' });

    const { results } = await (
      await auditDb()
    )
      .prepare('SELECT tool, COUNT(*) AS n FROM mcp_tool_calls GROUP BY tool')
      .all();
    expect(results).toEqual([{ tool: 'get_resume', n: 1 }]);
  });

  test('returns JSON Resume for format=json', async () => {
    const { json } = await callAudited('get_resume', { format: 'json' });
    const parsed = JSON.parse(json.result.content[0].text);
    expect(parsed.basics.name).toBe('Ryan Lindsey');
    expect(Array.isArray(parsed.work)).toBe(true);
  });

  test('returns the published markdown for format=markdown', async () => {
    const { json } = await callAudited('get_resume', { format: 'markdown' });
    expect(json.result.content[0].text).toMatch(/^# Ryan Lindsey/m);
  });

  test('summary is short, prose, and cites where the full copy lives', async () => {
    const { json } = await callAudited('get_resume', { format: 'summary' });
    const text = json.result.content[0].text;
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain('https://ryanlindsey.me/resume');
  });

  test('defaults to json when format is omitted', async () => {
    const { json } = await callAudited('get_resume');
    expect(() => JSON.parse(json.result.content[0].text)).not.toThrow();
  });

  // Plain `callTool`, and that is the point: a call the SDK refuses at the
  // input schema never reaches `defineTool`, so there is no audit row to
  // settle. `callAudited` would wait out its 2 seconds and then fail.
  test('rejects an unknown format at the schema, before the handler runs', async () => {
    const { json } = await callTool('get_resume', { format: 'pdf' });
    expect(json.result?.isError ?? json.error).toBeTruthy();
  });
});

/**
 * Task 7's tools, copying the `get_resume` group's shape: each tool gets its
 * own `describe` (so `vitest -t list_case_studies` selects exactly one) and
 * its own local `callAudited`, because every tool-calling test in this file
 * settles its own audit writes before returning -- see `waitForAuditRows`.
 *
 * The stale-content note above the brief's own sketch of these tests no
 * longer holds on this branch: `delivery-forecasting` and `silent-failure`
 * are both `draft: false` (only `shape-specimen` still is), so
 * `list_case_studies` returns two real entries here, not zero. These tests
 * assert against that populated list rather than guarding an empty-list early
 * return the corpus no longer produces.
 */
describe('list_case_studies', () => {
  async function callAudited(name: string, args?: Record<string, unknown>) {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();
    const call = await callTool(name, args);
    await waitForAuditRows(db, 1);
    return call;
  }

  test('lists every published case study with its citation URL', async () => {
    const { json } = await callAudited('list_case_studies');
    const listed = JSON.parse(json.result.content[0].text);
    expect(Array.isArray(listed)).toBe(true);
    // At least the two real .mdx case studies published on this branch at
    // task-7 time (`delivery-forecasting`, `silent-failure`) -- not pinned to
    // exactly 2, since a third publishing later should not fail this suite
    // for a reason that has nothing to do with the tool under test.
    expect(listed.length).toBeGreaterThan(0);
    for (const item of listed) {
      // `https?`, not `https` only: this suite's SITE_ORIGIN is the harness's
      // own loopback address (tests/mcp-tools.test.ts's own `beforeAll`
      // comment -- "127.0.0.1"), not the production origin, so the scheme
      // here is genuinely `http` under this harness.
      expect(item.url).toMatch(/^https?:\/\/[^/]+\/work\/[^/]+\/$/);
      expect(item.title).toBeTruthy();
    }
  });

  test('omits metadata fields the entry does not declare, rather than nulling them', async () => {
    const { json } = await callAudited('list_case_studies');
    const listed = JSON.parse(json.result.content[0].text);
    expect(listed.length).toBeGreaterThan(0);
    for (const item of listed) {
      expect(Object.values(item)).not.toContain(null);
      // Neither published case study declares orgScale/domain/outcomes yet
      // (task-7 note); asserting their absence is what makes this a test of
      // the "omit, don't null" contract rather than a no-op over keys that
      // were never going to be there regardless of how this is implemented.
      expect(item).not.toHaveProperty('orgScale');
      expect(item).not.toHaveProperty('domain');
      expect(item).not.toHaveProperty('outcomes');
    }
  });

  test('joins the audit trail without asking to, like every tool', async () => {
    await callAudited('list_case_studies');
    const { results } = await (
      await auditDb()
    )
      .prepare('SELECT tool, COUNT(*) AS n FROM mcp_tool_calls GROUP BY tool')
      .all();
    expect(results).toEqual([{ tool: 'list_case_studies', n: 1 }]);
  });
});

describe('get_case_study', () => {
  async function callAudited(name: string, args?: Record<string, unknown>) {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();
    const call = await callTool(name, args);
    await waitForAuditRows(db, 1);
    return call;
  }

  test('returns the full document body for a published slug', async () => {
    const { json: list } = await callAudited('list_case_studies');
    const listed = JSON.parse(list.result.content[0].text);
    expect(listed.length).toBeGreaterThan(0); // see the note on list_case_studies above.

    const { json } = await callAudited('get_case_study', { slug: listed[0].slug });
    const detail = JSON.parse(json.result.content[0].text);
    expect(detail.slug).toBe(listed[0].slug);
    expect(detail.url).toBe(listed[0].url);
    expect(typeof detail.markdown).toBe('string');
    expect(detail.markdown.length).toBeGreaterThan(0);
    // The frontmatter block is the export format's envelope, not part of what
    // a reader was served -- get_resume's format=markdown makes the same call.
    expect(detail.markdown).not.toContain('---\ntitle:');
  });

  test('answers a missing slug with a readable error, not a crash', async () => {
    const { json } = await callAudited('get_case_study', { slug: 'no-such-case-study' });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/not found/i);
  });

  // Plain `callTool`, matching `get_resume`'s schema-rejection test: a call
  // the SDK refuses at the input schema never reaches `defineTool`'s handler,
  // so there is no audit row for `callAudited` to wait on.
  test('rejects an empty slug at the schema, before the handler runs', async () => {
    const { json } = await callTool('get_case_study', { slug: '' });
    expect(json.result?.isError ?? json.error).toBeTruthy();
  });
});

/**
 * Task 8's tools, copying the `list_case_studies`/`get_case_study` group's
 * shape. Unlike case studies, `src/content/posts/` has exactly one entry
 * (`type-specimen.mdx`) and it is `draft: true`, so there is no published
 * post on this branch today -- `list_writing` genuinely returns `[]` and
 * `get_post` has no published slug to fetch. The tests below say so directly
 * rather than guarding an empty list with an early `return`: a `return` before
 * any assertion would make the "full markdown, not a summary" test (the one
 * enforcing 03 §2's "Full markdown of any published piece") pass without
 * checking anything, which is exactly what a credential-free CI with no real
 * content must not do (global constraints: a test needing absent content must
 * skip cleanly and say so, never silently pass against a fake).
 */
describe('list_writing', () => {
  async function callAudited(name: string, args?: Record<string, unknown>) {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();
    const call = await callTool(name, args);
    await waitForAuditRows(db, 1);
    return call;
  }

  test('lists exactly the published posts', async () => {
    const { json } = await callAudited('list_writing');
    const listed = JSON.parse(json.result.content[0].text);
    // A real assertion about real state, not a skip: no post is published on
    // this branch today, so the correct answer is the empty list, and this
    // goes green against a populated one automatically once a post ships,
    // with nothing here to edit.
    expect(listed).toEqual([]);
  });
});

describe('get_post', () => {
  async function callAudited(name: string, args?: Record<string, unknown>) {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();
    const call = await callTool(name, args);
    await waitForAuditRows(db, 1);
    return call;
  }

  test('points at the other tool when the slug is a case study', async () => {
    // LIVE, not guarded: case studies genuinely are published on this branch
    // (`delivery-forecasting`, `silent-failure` -- see the note above
    // `list_case_studies`), so this exercises the redirect branch for real.
    const { json: list } = await callAudited('list_case_studies');
    const studies = JSON.parse(list.result.content[0].text);
    expect(studies.length).toBeGreaterThan(0);

    const { json: miss } = await callAudited('get_post', { slug: studies[0].slug });
    expect(miss.result.isError).toBe(true);
    expect(miss.result.content[0].text).toMatch(/get_case_study/);
  });

  test('answers an unknown slug with a readable error', async () => {
    const { json } = await callAudited('get_post', { slug: 'nope' });
    expect(json.result.isError).toBe(true);
  });

  /**
   * Dormant until a post is published. This is the test 03 §2's "Full
   * markdown of any published piece" actually rests on, so it must be seen
   * to be skipped rather than seen to silently pass: `ctx.skip(note)`
   * (vitest's dynamic per-test skip) marks the test SKIPPED in the run
   * output with the reason below attached, which is what tells a reader this
   * checked nothing -- a plain early `return` would report as a pass instead.
   * No edit is needed here the day a post ships: `posts.length` then reads
   * greater than zero and the skip is never reached.
   */
  test('returns full markdown, not a summary, for a published post', async (ctx) => {
    const { json } = await callAudited('list_writing');
    const posts = JSON.parse(json.result.content[0].text);
    if (posts.length === 0) {
      ctx.skip(
        'no published post exists yet -- src/content/posts/type-specimen.mdx is the only post and it is draft: true',
      );
    }
    const { json: post } = await callAudited('get_post', { slug: posts[0].slug });
    expect(post.result.content[0].text.length).toBeGreaterThan(posts[0].description.length);
  });
});

/**
 * Task 9's tool, and the one group in this file that is deliberately THIN.
 *
 * MEASURED before these tests were written, because the plan assumed
 * otherwise: `env.VECTORIZE.query(...)` under this harness throws `Binding
 * VECTORIZE needs to be run remotely`, from inside the Worker as well as
 * through `getEnv()`. There is no Vectorize here at all -- not an empty local
 * index, which is what the plan had expected. The measurement and what it
 * corrects are written out beside the binding in workers/mcp/wrangler.jsonc.
 * `env.AI` is a mock service binding for the reason that file also gives,
 * which is why `MCP_SEARCH_EMBEDDER: 'stub'` (tests/workers.ts) skips the
 * embedding call.
 *
 * So `search_writing` CANNOT complete under this harness, and nothing here
 * pretends it can. There is no "returns no matches" test: an empty result
 * would be a thrown binding wearing a passing assertion, which is the exact
 * false positive this repo keeps naming. These two tests assert only what is
 * genuinely observable without the index -- that the tool is registered with
 * the schema it advertises, and that it draws from the SEARCH limiter rather
 * than the document-read one.
 *
 * Citation correctness -- the chunk-id grammar, the re-chunked excerpt, the
 * query-side embedding key -- is covered by the pure tests in
 * tests/mcp-search.test.ts, which need no bindings at all. The retrieval round
 * trip against the live index is verified by hand in Task 16, the same
 * division day 3 Task 15 drew for the write side of this same corpus.
 */
describe('search_writing', () => {
  /**
   * Plain `callTool`, matching the other schema-rejection tests here: a call
   * the SDK refuses at the input schema never reaches `defineTool`, so there
   * is no audit row to settle.
   *
   * The assertion is on the MESSAGE, not merely on `isError`, and that is
   * what makes this a test of the tool rather than of the server: an
   * unregistered tool answers `{ error: { code: -32602, message: 'Tool
   * search_writing not found' } }`, which is equally truthy. Only a
   * registered tool whose schema actually enforces `min(1)` answers with an
   * input-validation error naming `query` (both strings measured against this
   * harness).
   */
  test('validates the query argument at the schema', async () => {
    const { json } = await callTool('search_writing', { query: '' });
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/Input validation error/);
    expect(json.result.content[0].text).toMatch(/query/);
  });

  /**
   * The routing `cost: 'inference'` buys, and it discriminates: `LIMITS` in
   * src/lib/mcp/limits.ts puts `cheap` at 60/minute and `inference` at
   * 10/minute, so `burstSize(10)` (21) calls cross the search bucket and would
   * not come close to the cheap one. A `search_writing` registered as `cheap`
   * fails this test rather than passing it quietly. The limits are read from
   * `LIMITS` rather than repeated here, which they could not be while they
   * lived in wrangler.jsonc -- the old version of this comment had to quote
   * two numbers out of a config file and trust they had not moved.
   *
   * 21, not a smaller number that would merely exceed 10: see `burstSize`'s
   * own comment for the refill that a burst of exactly the limit can outrun.
   *
   * It runs without the index because `defineTool` checks the limit BEFORE
   * calling the handler, so the refusals are real refusals; the calls that
   * get past the limiter go on to fail at the Vectorize binding, which is
   * why this asserts on the `rate_limited` rows specifically rather than on
   * anything the tool returned.
   */
  test('draws from the search limiter, and does not starve the cheap tools', async () => {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();

    const burst = burstSize(LIMITS.inference.limit);
    const started = Date.now();
    for (let i = 0; i < burst; i++) await callTool('search_writing', { query: `q${i}` });
    const elapsedMs = Date.now() - started;

    // Every one of the burst is audited -- refusals included, or the table
    // would under-report exactly the traffic worth looking at.
    await waitForAuditRows(db, burst);
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM mcp_tool_calls WHERE tool='search_writing' AND outcome='rate_limited'",
      )
      .first<{ n: number }>();
    expect(row!.n).toBeGreaterThan(0);

    // And the other half of the same fact: the calls that got THROUGH are
    // bounded by the bucket. See `allowedCeiling` for why "some were refused"
    // on its own is the assertion that let #29 ship.
    expect(burst - row!.n).toBeLessThanOrEqual(
      allowedCeiling(LIMITS.inference.limit, LIMITS.inference.periodSeconds, elapsedMs),
    );

    // The whole point of two buckets: exhausting search leaves reading intact.
    const { json } = await callTool('get_contact');
    expect(json.result.isError).toBeFalsy();

    // Settled before returning, like every tool call in this file: that write
    // is dispatched through `ctx.waitUntil` and would otherwise be in flight
    // when the next test clears the table. See `waitForAuditRows`.
    await waitForAuditRows(db, burst + 1);
  });
});

/**
 * Day 4 Task 15 (09 §2's named adversarial prompts against the public MCP
 * surface): "Is Ryan looking?", "Is he interviewing anywhere?". There is no
 * chat agent to run a whole conversation through until day 6, so
 * `search_writing` is the one public tool that could answer a query like this
 * today -- these run the two prompts through it directly.
 *
 * MEASURED, not assumed (same fact the plain `search_writing` describe block
 * above already documents): `env.VECTORIZE.query()` throws `Binding VECTORIZE
 * needs to be run remotely` under this harness -- there is no local
 * simulation, not even an empty one. So neither query can retrieve anything
 * here, and a test asserting "the results contain no search language and no
 * synthesized verdict" would be certifying results that were never produced --
 * exactly the false-positive the plan's global constraints name ("never fail,
 * and never silently pass against a fake"). What genuinely IS true under this
 * harness -- the call fails closed (a tool-result error, not a crash or an
 * unhandled throw) and the failure text itself carries no search language --
 * is asserted for real below. The retrieval half is deferred to Task 16's live
 * run against the real index, where it can actually be observed, and marked
 * with an explicit named skip rather than silently omitted.
 *
 * One more thing has to be true for "fails closed under this harness" to
 * test anything real: the query has to actually REACH the handler. The plain
 * `search_writing` describe block immediately above fires `burstSize(10)`
 * (21) calls at the `search_writing:unknown` bucket, and Miniflare's rate
 * limiter caps the counter at the limit without incrementing it further past
 * a refusal, so that bucket is left DRAINED -- for the rest of this file, not
 * just for that test. Calls made here milliseconds later, at the same
 * `unknown` IP, would therefore be refused by the LIMITER and never reach the
 * handler at all. That refusal is itself `isError: true`, with a message
 * ("Rate limit reached for search_writing. Try again in 6 seconds." -- the
 * interval is derived per cost class, see `retryHint` in src/lib/mcp/limits.ts) that
 * trivially satisfies every banned pattern checked below -- so this whole
 * describe block would go green while proving nothing about 09 §2's
 * highest-risk check. (An earlier version of this file did exactly that: its
 * own comment claimed the query "reaches the handler and fails there, at the
 * binding," while the limiter was actually answering both calls.) Each call
 * below therefore carries a `cf-connecting-ip` of its own -- `limitKeyFor` is
 * `<tool>:<ip>`, so a fresh IP draws a fresh, unexhausted bucket -- and the
 * assertion is on the HANDLER's own generic failure text
 * (`defineTool`'s `fail()`, "search_writing failed. The error was logged."),
 * not merely on `isError`, since a limiter refusal and a handler failure are
 * both `isError: true` and only the wording tells them apart.
 */
describe('search_writing adversarial candidacy queries (09 §2)', () => {
  const ADVERSARIAL_QUERIES = ['Is Ryan looking?', 'Is he interviewing anywhere?'];

  // Distinct from `unknown` (the IP every other call in this file answers to
  // when no header is set) and from the resource limiter test's
  // `203.0.113.11` -- not that reusing the latter would collide, since
  // `limitKeyFor` keys on `<tool>:<ip>` and this bucket is `search_writing`'s,
  // but a name of its own is clearer than relying on that.
  const ADVERSARIAL_CLIENT = { 'cf-connecting-ip': '203.0.113.77' };

  for (const query of ADVERSARIAL_QUERIES) {
    test(`"${query}" fails closed under this harness, and the failure carries no search language`, async () => {
      const { json } = await callTool('search_writing', { query }, ADVERSARIAL_CLIENT);
      // Not the schema-rejection path (the other search_writing test's shape):
      // this query is a valid non-empty string, so -- drawing from a fresh
      // bucket, above -- it is let past the limiter and reaches the handler,
      // where it fails at the binding. Asserted on the handler's own generic
      // failure text, which a rate-limit refusal cannot produce: see the
      // block comment above this describe for why `isError` alone would not
      // tell the two apart.
      expect(json.error).toBeUndefined();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toMatch(/failed\. The error was logged/);
      for (const banned of BANNED_PATTERNS) {
        expect(json.result.content[0].text).not.toMatch(banned);
      }
    });
  }

  test.skip(
    'both adversarial queries return cited excerpts only, with no synthesized verdict and no ' +
      "search language in the actual results -- deferred to Task 16's live run: VECTORIZE has no " +
      'local simulation under this harness (env.VECTORIZE.query() throws), so there is no result ' +
      'here to make this assertion about',
    () => {},
  );
});

/**
 * Task 10's tool, and the single most delicate string in the repo (03 §2):
 * a private tier is normal; it does not imply a search. The whole string is
 * asserted verbatim below -- the same discipline tests/mcp.smoke.test.ts
 * applies to the server's own `instructions` -- so any edit to this copy
 * fails this test and has to be made deliberately.
 */
describe('request_private_access', () => {
  async function callAudited(name: string, args?: Record<string, unknown>) {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();
    const call = await callTool(name, args);
    await waitForAuditRows(db, 1);
    return call;
  }

  const PRIVATE_ACCESS_TEXT =
    'Some material on this site is served to scoped tokens rather than published: ' +
    'reference contacts, engagement logistics, and the unredacted layer of a few case ' +
    'studies. This is an ordinary access tier, not a waiting list. Email ' +
    'hello@ryanlindsey.me with who you are and what you are evaluating, and Ryan will ' +
    'issue a scoped, expiring token if it fits. Public tools cover the portfolio in full.';

  test('returns exactly the reviewed private-tier copy', async () => {
    const { json } = await callAudited('request_private_access');
    expect(json.result.content[0].text).toBe(PRIVATE_ACCESS_TEXT);
  });

  // The banned-pattern list is written as regexes over sanctioned text (day 1's
  // ruling): this file is in the public repo, so the check never enumerates
  // forbidden vocabulary into a file that ships publicly.
  //
  // It covers the RESOURCE surface as well as the tools, because 09 §2 binds
  // resource names, titles and descriptions the same way it binds a tool's --
  // they are read by strangers' agents by design, so a leak in either is a
  // broadcast leak. BANNED_PATTERNS (./candidacy-patterns.ts) rather than a
  // second, inline list of its own: this test used to hand-type one, and Day 4
  // Task 15's fix round unified it into the one shared list every other
  // candidacy check in this repo now uses -- see that module's own comment for
  // the one deliberate difference from what used to be hand-typed here
  // (`available for` was dropped, not carried forward).
  test('nothing on the published surface carries search language', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} });
    const { json: listed } = await rpc({
      jsonrpc: '2.0',
      id: 98,
      method: 'resources/list',
      params: {},
    });
    const { json: templates } = await rpc({
      jsonrpc: '2.0',
      id: 97,
      method: 'resources/templates/list',
      params: {},
    });
    const surface =
      JSON.stringify(json.result.tools) +
      JSON.stringify(listed.result.resources) +
      JSON.stringify(templates.result.resourceTemplates) +
      PRIVATE_ACCESS_TEXT;
    for (const banned of BANNED_PATTERNS) {
      expect(surface).not.toMatch(banned);
    }
  });

  test('is audited like any other tool', async () => {
    await callAudited('request_private_access');
    const db = await auditDb();
    const row = await db.prepare('SELECT tool FROM mcp_tool_calls').first<{ tool: string }>();
    expect(row?.tool).toBe('request_private_access');
  });
});

/**
 * Task 12 (03 §1): `/llms.txt`'s MCP description is a hand-written literal
 * (src/pages/llms.txt.ts's own comment explains why -- `astro:content` and
 * this Worker's module graph are two separate builds, so generating the line
 * from these registrations is not reachable at build time). A literal copy
 * drifts, and it already had once: this file's own description said "One tool
 * today: get_contact" from Task 9 until Task 12, false since Task 6 added a
 * second tool.
 *
 * tests/pages.test.ts's Task 12 assertion only checks for the specific
 * stale line and for `search_writing` by name -- it would stay green if a
 * NINTH tool were added to `tools.ts` without a matching update to
 * `llms.txt.ts`, reproducing the exact bug this task exists to fix under a
 * different tool's name. This is the real guard: it enumerates the live
 * `tools/list` result from THIS harness's MCP Worker and requires every name
 * to appear in the SAME harness's built `/llms.txt` (served by the site
 * Worker, over the SITE_ORIGIN wiring `beforeAll` above sets up) -- so it
 * fails the moment the two go out of step, regardless of which tool moved.
 * Mirrors tests/mcp.smoke.test.ts's "the instructions name every registered
 * tool", the same shape of guard for the other published surface.
 */
test('/llms.txt names every registered tool, so the two cannot drift apart silently', async () => {
  const { json: listed } = await rpc({ jsonrpc: '2.0', id: 96, method: 'tools/list', params: {} });
  const page = await (await server.fetch('/llms.txt')).text();
  for (const tool of listed.result.tools) {
    expect(page, `/llms.txt should name ${tool.name}`).toContain(tool.name);
  }
});

/**
 * Task 11's resources: `resume://json` and the `writing://{slug}` template.
 *
 * A resource is not a tool and cannot go through `defineTool` -- `resources/read`
 * has its own handler shape, its own result (`contents`, not `content`) and no
 * `isError` result to put a sentence in. It goes through `defineResource`
 * instead, which limits and audits a read exactly as `defineTool` does a call,
 * so the first three tests here are about the guard rather than the content.
 * Discovery (`resources/list`, `resources/templates/list`) is neither limited
 * nor audited, matching `tools/list`.
 *
 * ORDER MATTERS INSIDE THIS GROUP. The three tests the plan specifies verbatim
 * come further down, and one of them reads `resume://json` without settling the
 * audit write that read dispatches through `ctx.waitUntil` -- the race
 * `waitForAuditRows`'s note describes. An exact-row assertion can only be made
 * while the table is quiet, so the audit tests run BEFORE that read rather than
 * after it. The limiter test runs LAST in the group for the same kind of
 * reason: it exhausts a bucket, and every read above it would be refused.
 */
describe('resources', () => {
  let resourceCallId = 400;
  function readResource(uri: string, headers?: Record<string, string>) {
    return rpc(
      { jsonrpc: '2.0', id: ++resourceCallId, method: 'resources/read', params: { uri } },
      headers,
    );
  }

  test('audits a resource read under its own name, like every tool call', async () => {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();

    await readResource('resume://json');
    await waitForAuditRows(db, 1);

    // The same assertion the tool surface makes ("every registered tool call
    // writes exactly one audit row"), against the half of the surface that is
    // not a tool: 03 §3 logs every call, and a read is a call.
    const { results } = await db
      .prepare('SELECT tool, tier, audience, outcome FROM mcp_tool_calls')
      .all();
    expect(results).toEqual([
      { tool: 'resource:resume', tier: 'public', audience: null, outcome: 'ok' },
    ]);
  });

  test('audits a template read under the template name, failures included', async () => {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();

    const { json } = await readResource('writing://no-such-post');
    // `resources/read` has no `isError` result shape, so a miss is a JSON-RPC
    // error rather than a result -- and it is audited all the same.
    //
    // Asserted as a MISS rather than merely as an error, because the two are
    // different answers and only one of them is true: -32602 carrying the URI
    // in `data` is how this SDK spells resource-not-found, and the message is
    // one written for the caller. `defineResource` passes a deliberate
    // `ProtocolError` through and replaces anything else with a generic
    // sentence, so a generic message here would mean the sanitiser had
    // swallowed the real answer.
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toBe('Resource not found: writing://no-such-post');
    await waitForAuditRows(db, 1);

    const { results } = await db.prepare('SELECT tool, outcome FROM mcp_tool_calls').all();
    expect(results).toEqual([{ tool: 'resource:writing', outcome: 'error' }]);
  });

  test('advertises a resources capability alongside tools', async () => {
    const { json } = await initialize(203);
    expect(json.result.capabilities.tools).toBeTruthy();
    expect(json.result.capabilities.resources).toBeTruthy();
  });

  test('advertises the resume resource', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 200, method: 'resources/list', params: {} });
    expect(json.result.resources.map((r: { uri: string }) => r.uri)).toContain('resume://json');
  });

  test('reads the resume resource as JSON Resume', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 201,
      method: 'resources/read',
      params: { uri: 'resume://json' },
    });
    expect(JSON.parse(json.result.contents[0].text).basics.name).toBe('Ryan Lindsey');
  });

  test('templates writing:// over published slugs only', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 202,
      method: 'resources/templates/list',
      params: {},
    });
    expect(JSON.stringify(json.result)).toContain('writing://');
  });

  /**
   * What the template enumerates TODAY, asserted rather than assumed.
   *
   * No post is published on this branch (`src/content/posts/type-specimen.mdx`
   * is the only one and it is `draft: true`), so the template advertises itself
   * and lists nothing -- the same real state `list_writing` asserts against.
   * The day a post ships this line fails and has to name it, which is the
   * intended cost: a document appearing on the public resource surface should
   * be a reviewed edit rather than a silent one.
   */
  test('lists no writing resource while no post is published', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 204, method: 'resources/list', params: {} });
    const uris: string[] = json.result.resources.map((r: { uri: string }) => r.uri);
    expect(uris.filter((uri) => uri.startsWith('writing://'))).toEqual([]);
  });

  /**
   * Dormant until a post is published, and skipped out loud rather than
   * passing quietly -- the same shape `get_post`'s dormant test uses, for the
   * same reason. Nothing here needs editing the day a post ships: the list
   * above it stops being empty and the skip is never reached.
   */
  test('serves a published post through the writing:// template', async (ctx) => {
    const { json: list } = await rpc({
      jsonrpc: '2.0',
      id: 205,
      method: 'resources/list',
      params: {},
    });
    const post = list.result.resources.find((r: { uri: string }) => r.uri.startsWith('writing://'));
    if (post === undefined) {
      ctx.skip(
        'no published post exists yet -- src/content/posts/type-specimen.mdx is the only post and it is draft: true',
      );
    }
    const { json } = await readResource(post.uri);
    expect(json.result.contents[0].mimeType).toBe('text/markdown');
    expect(json.result.contents[0].text.length).toBeGreaterThan(0);
  });

  /**
   * The controller's extension to Task 11, and the reason `defineResource`
   * exists at all rather than a bare `server.registerResource`.
   *
   * `writing://{slug}` serves the same documents `get_post` serves, and
   * `get_post` is limited at 60/60s. An unlimited resource path to identical
   * content would make that limiter decorative -- a client wanting the whole
   * corpus would simply read the resource instead. So a read is limited, and
   * the three assertions after the loop are what "its own bucket" means:
   * `limitKeyFor` is `<name>:<ip>`, so exhausting `resource:writing` for ONE
   * client leaves the same resource open to another client, leaves the other
   * resource open, and leaves the tools open.
   *
   * Keyed on a `cf-connecting-ip` of its own, which is also why this test does
   * not have to be the last one in the file the way the `get_contact` limiter
   * test does: every other test here answers to the `unknown` IP.
   */
  test('refuses a resource read past the limit, from a bucket of its own', async () => {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();
    const client = { 'cf-connecting-ip': '203.0.113.11' };

    // `burstSize(LIMITS.cheap.limit)` (121), not a plain 70: see that helper's
    // own comment for why a burst has to exceed the limit by more than a
    // handful to guarantee a refusal against a bucket that refills as it runs.
    const attempts = [];
    for (let i = 0; i < burstSize(LIMITS.cheap.limit); i++)
      attempts.push(await readResource(`writing://p${i}`, client));

    const refused = attempts.filter((a) => /rate limit/i.test(a.json.error?.message ?? ''));
    expect(refused.length).toBeGreaterThan(0);
    // A JSON-RPC error, not a broken connection: the client reads a sentence.
    expect(refused[0]!.status).toBe(200);
    // And it reads as a refusal rather than as a miss: -32000 is JSON-RPC's
    // implementation-defined server-error range, where -32602 would tell the
    // client its URI was wrong and invite it to drop a URI that is fine.
    expect(refused[0]!.json.error.code).toBe(-32000);

    // Same URI, different client: a bucket per IP, so one caller cannot
    // exhaust the resource for everyone. This also proves the header above is
    // genuinely reaching `limitKeyFor` rather than being ignored.
    const otherClient = await readResource('writing://p0');
    expect(otherClient.json.error?.message ?? '').not.toMatch(/rate limit/i);

    // Same client, the other resource and a tool: separate buckets, so the
    // writing resource cannot starve either of them.
    const resume = await readResource('resume://json', client);
    expect(resume.json.result.contents[0].text).toContain('Ryan Lindsey');
    const contact = await callTool('get_contact', {}, client);
    expect(contact.json.result.isError).toBeFalsy();

    // Refusals are audited too, exactly as a tool's are -- an unaudited
    // refusal would make the table under-report the traffic worth looking at.
    await waitForAuditRows(db, attempts.length + 3);
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM mcp_tool_calls WHERE tool='resource:writing' AND outcome='rate_limited'",
      )
      .first<{ n: number }>();
    expect(row!.n).toBeGreaterThan(0);
  });
});

/**
 * Day 4 Task 15: the candidacy-leak gate over the WHOLE public MCP surface
 * (09 §2, 03 §5's launch-checklist item), not just the routes Day 3 covered.
 * Every string here is read by strangers' agents by design, so a leak on this
 * surface is a broadcast leak -- the plan's own words for why this task is a
 * gate rather than a detail of any one tool.
 *
 * Walks `tools/list` AT RUNTIME rather than a hardcoded tool name list: a
 * hardcoded list is a list that misses day 5's additions, and day 5 -- the
 * gated tier and fit analysis -- is when this risk is real. Every zero-
 * REQUIRED-argument tool is actually CALLED and its output checked, not just
 * its listed name/description -- `tools/list` and `resources/list` cover the
 * metadata, but a tool's runtime output is a surface of its own.
 *
 * The skip condition is `tool.inputSchema?.required`, not "has an
 * `inputSchema` at all" or "has any properties": MEASURED against this
 * harness's own `tools/list` response (see workers/mcp/src/tools.ts) --
 * `get_resume`'s schema has one property (`format`) with a zod `.default()`
 * and reports NO `required` key at all, the same shape a tool with an empty
 * `properties: {}` reports. A condition that skipped any tool with properties,
 * rather than any tool with required ones, would silently drop get_resume
 * from coverage. `get_case_study`, `get_post` and `search_writing` are the
 * three genuinely skipped, each because it needs an argument this loop cannot
 * supply -- each is covered by its own describe block above instead.
 *
 * DAY 5 ARRIVED AND THIS TEST DID ITS JOB WITHOUT AN EDIT. The gated tools
 * are registered per grant (workers/mcp/src/server.ts), so an anonymous
 * `tools/list` here still enumerates exactly the public tier -- which is why
 * the runtime walk was written instead of a hardcoded list. The gated
 * surface's own scan lives in tests/mcp-gated.test.ts, where a grant exists
 * to enumerate it.
 */
test('no public MCP surface carries search language: initialize, tools/list, resources/list, and every zero-argument tool call', async () => {
  const db = await auditDb();
  await db.prepare('DELETE FROM mcp_tool_calls').run();

  const { json: init } = await initialize(950);
  const { json: tools } = await rpc({ jsonrpc: '2.0', id: 951, method: 'tools/list', params: {} });
  const { json: resources } = await rpc({
    jsonrpc: '2.0',
    id: 952,
    method: 'resources/list',
    params: {},
  });
  const { json: templates } = await rpc({
    jsonrpc: '2.0',
    id: 953,
    method: 'resources/templates/list',
    params: {},
  });

  const surfaces = [
    init.result.instructions,
    JSON.stringify(tools.result),
    JSON.stringify(resources.result),
    JSON.stringify(templates.result),
  ];

  const calledNames = new Set<string>();
  for (const tool of tools.result.tools as {
    name: string;
    inputSchema?: { required?: string[] };
  }[]) {
    const required = tool.inputSchema?.required ?? [];
    if (required.length > 0) continue; // needs an argument this loop cannot supply -- own test above.
    const { json } = await callTool(tool.name);
    calledNames.add(tool.name);
    surfaces.push(JSON.stringify(json.result));
  }

  // Not vacuous, and specifically proves the skip condition above did not
  // mishandle get_resume's all-optional schema (see the doc comment): every
  // tool known to be callable with zero arguments today was actually called.
  // A day-5 tool joining this set only adds to it -- this does not pin the
  // total.
  for (const name of [
    'get_contact',
    'get_resume',
    'list_case_studies',
    'list_writing',
    'request_private_access',
  ]) {
    expect(
      calledNames,
      `${name} should have been called as a zero-required-argument tool`,
    ).toContain(name);
  }

  // Settled before returning, like every tool-calling test in this file: each
  // call's audit write is dispatched through `ctx.waitUntil` and would
  // otherwise still be in flight when the KEEP-LAST rate-limiter test below
  // clears this table.
  await waitForAuditRows(db, calledNames.size);

  for (const surface of surfaces) {
    for (const banned of BANNED_PATTERNS) {
      expect(surface, `must not match ${banned}`).not.toMatch(banned);
    }
  }
});

/**
 * KEEP THIS TEST LAST, and append new tests ABOVE it.
 *
 * It deliberately exhausts the `get_contact:unknown` bucket, and the bucket's
 * period is 60 seconds -- longer than this whole file takes to run. Any
 * `get_contact` call appended after it is refused rather than served, and the
 * failure surfaces as an unexplained `isError` in the new test rather than as
 * anything pointing here. A tool with its own name is unaffected: the tool
 * name is in the limiter key precisely so one tool cannot starve another.
 */
test('refuses past the limit and records the refusal', async () => {
  const db = await auditDb();
  await db.prepare('DELETE FROM mcp_tool_calls').run();

  // `burstSize(LIMITS.cheap.limit)` (121), not a plain 70 -- see that helper's
  // own comment for why a burst has to exceed the limit by more than a handful
  // to guarantee a refusal against a bucket that refills as it runs.
  const attempts = [];
  const started = Date.now();
  for (let i = 0; i < burstSize(LIMITS.cheap.limit); i++)
    attempts.push(await callTool('get_contact'));
  const elapsedMs = Date.now() - started;

  const refused = attempts.filter((a) => a.json.result?.isError === true);
  expect(refused.length).toBeGreaterThan(0);

  // The assertion #29 was missing, and the reason this test is worth more than
  // it was: not merely that SOMETHING was refused, but that no more than a
  // bucketful got through. A limiter that has stopped counting -- which is
  // exactly what production was doing while this file stayed green -- passes
  // the line above and fails this one. See `allowedCeiling`.
  expect(attempts.length - refused.length).toBeLessThanOrEqual(
    allowedCeiling(LIMITS.cheap.limit, LIMITS.cheap.periodSeconds, elapsedMs),
  );

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
