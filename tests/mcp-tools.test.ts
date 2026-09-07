import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_WORKER, SITE_HARNESS_WORKERS } from './workers';

// The SITE too, not just the MCP Worker and its mock AI. Every content tool
// reads the site's published documents over `SITE_ORIGIN` (src/lib/mcp/documents.ts),
// so a suite that boots the MCP Worker alone can only test those tools against a
// host that resolves nowhere. The site is FIRST because `SITE_HARNESS_WORKERS`
// puts it first, which makes it the primary Worker -- see `beforeAll` for why
// that matters and `rpc` for what it costs.
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
 * What makes this work at all is that the harness address is a real loopback
 * origin: the MCP Worker's global `fetch` reaches it exactly as it would reach
 * ryanlindsey.me in production, the request matches no Worker's routes (the two
 * custom domains are `ryanlindsey.me` and `mcp.ryanlindsey.me`, neither of
 * which is 127.0.0.1), and it therefore lands on the PRIMARY Worker -- the
 * site. So the code path under test is the deployed one, over HTTP, with no
 * service binding and no stub in it.
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
 * index, which is what workers/mcp/wrangler.jsonc's note on `vectorize`
 * defaulting to a local simulation under `wrangler dev` had suggested to
 * expect. `env.AI` is a mock service binding for the reason that file also
 * gives, which is why `MCP_SEARCH_EMBEDDER: 'stub'` (tests/workers.ts) skips
 * the embedding call.
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
   * The routing `cost: 'inference'` buys, and it discriminates: RATE_LIMITER
   * is 60/minute and RATE_LIMITER_SEARCH is 10/minute
   * (workers/mcp/wrangler.jsonc), so 12 calls cross the search bucket and
   * would not come close to the cheap one. A `search_writing` registered as
   * `cheap` fails this test rather than passing it quietly.
   *
   * It runs without the index because `defineTool` checks the limit BEFORE
   * calling the handler, so the refusals are real refusals; the ten calls
   * that get past the limiter go on to fail at the Vectorize binding, which
   * is why this asserts on the `rate_limited` rows specifically rather than
   * on anything the tool returned.
   */
  test('draws from the search limiter, and does not starve the cheap tools', async () => {
    const db = await auditDb();
    await db.prepare('DELETE FROM mcp_tool_calls').run();

    for (let i = 0; i < 12; i++) await callTool('search_writing', { query: `q${i}` });

    // Every one of the twelve is audited -- refusals included, or the table
    // would under-report exactly the traffic worth looking at.
    await waitForAuditRows(db, 12);
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM mcp_tool_calls WHERE tool='search_writing' AND outcome='rate_limited'",
      )
      .first<{ n: number }>();
    expect(row!.n).toBeGreaterThan(0);

    // The whole point of two buckets: exhausting search leaves reading intact.
    const { json } = await callTool('get_contact');
    expect(json.result.isError).toBeFalsy();
  });
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
