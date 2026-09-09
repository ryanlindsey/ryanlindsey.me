import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { MCP_WORKER, SITE_HARNESS_WORKERS } from './workers';
import { mintToken, newJti, type Scope, type TokenClaims } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY, type Grant } from '../src/lib/tier/grant';
import { PROFILE_KEYS } from '../src/lib/tier/private-docs';
import { CAMPAIGN_PREFIX } from '../src/lib/tier/campaigns';
import { defineTool, type ToolContext } from '../workers/mcp/src/define';
import type { McpEnv } from '../workers/mcp/src/env';
import { BANNED_PATTERNS } from './candidacy-patterns';

const server = createTestHarness({ workers: SITE_HARNESS_WORKERS });
// The whole `McpEnv`, not the three bindings the fixtures below write to. The
// scope-refusal test at the bottom of this file builds a real `ToolContext`,
// which names that type -- so narrowing it here would only mean casting it
// back, and a cast is exactly what would stop a binding rename from being
// caught.
let env: McpEnv;

const AUDIENCE = 'fixture-audience';

beforeAll(async () => {
  const { url } = await server.listen();
  await server.update({
    workers: SITE_HARNESS_WORKERS.map((worker) =>
      worker === MCP_WORKER
        ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, SITE_ORIGIN: url.origin } }
        : worker,
    ),
  });
  const mcp = server.getWorker<McpEnv>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  env = await mcp.getEnv();

  // The private tier's fixtures. Generic text throughout: no company name, no
  // description of a role, nothing a banned pattern could match. What is being
  // tested is that a document at a key reaches a granted caller and no one
  // else -- the content is irrelevant to that and must stay irrelevant.
  await env.R2_PRIVATE.put(PROFILE_KEYS.availability, '# Availability\n\nFixture availability.\n');
  await env.R2_PRIVATE.put(PROFILE_KEYS.references, '# References\n\nFixture references.\n');
  await env.R2_PRIVATE.put(PROFILE_KEYS.compensation, '# Engagement terms\n\nFixture terms.\n');
  await env.R2_PRIVATE.put('case-study/silent-failure.md', '# Detail\n\nFixture detail.\n');
  await env.R2_PRIVATE.put(`narrative/${AUDIENCE}.md`, '# Narrative\n\nFixture narrative.\n');

  await env.KV_CONFIG.put(
    `${CAMPAIGN_PREFIX}fixture`,
    JSON.stringify({
      id: 'fixture',
      company: 'Fixture Company',
      status: 'staged',
      jd_text: 'A description supplied at runtime.',
      referrer_domains: ['fixture.example'],
      hero_line: 'A generic line.',
      token_audience: AUDIENCE,
      gated_narrative_doc: `narrative/${AUDIENCE}.md`,
    }),
  );
});
afterAll(async () => {
  await server.close();
});

/** Mints and registers a token. Returns the bearer value. */
async function grantFor(scopes: Scope[], over: Partial<TokenClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    v: 1,
    jti: newJti(),
    aud: AUDIENCE,
    scopes,
    iat: now,
    exp: now + 3600,
    ...over,
  };
  await recordIssue(env.DB, {
    jti: claims.jti,
    audience: claims.aud,
    scopes: claims.scopes,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    revokedAt: null,
    note: 'gated suite',
  });
  return mintToken(TEST_SIGNING_KEY, claims);
}

let id = 0;
async function rpc(body: object, token?: string) {
  const response = await server.getWorker('ryanlindsey-me-mcp').fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // Streamable HTTP answers as JSON or as one SSE frame.
  const payload =
    text.startsWith('event:') || text.startsWith('data:')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5)
          .trim()
      : text;
  return { response, json: JSON.parse(payload) };
}

const listTools = async (token?: string) =>
  (await rpc({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} }, token)).json.result
    .tools as { name: string; description: string }[];

const callTool = async (name: string, args: object | undefined, token?: string) =>
  (
    await rpc(
      {
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name, ...(args ? { arguments: args } : {}) },
      },
      token,
    )
  ).json;

const GATED = [
  'get_availability',
  'get_references',
  'get_compensation_expectations',
  'get_case_study_details',
  'get_application_narrative',
];

describe('invisibility without a grant', () => {
  test('tools/list contains no gated tool', async () => {
    const names = (await listTools()).map((tool) => tool.name);
    for (const gated of GATED) expect(names, `${gated} must not be listed`).not.toContain(gated);
  });

  test('calling a gated tool by name answers unknown-tool, not a refusal that confirms it', async () => {
    // The distinction matters: "you may not call that" confirms the tool
    // exists. Registration-time gating means the server genuinely does not
    // have it, so the SDK's own unknown-tool answer is the honest one and it
    // enumerates nothing.
    const result = await callTool('get_application_narrative', undefined);
    const text = JSON.stringify(result);
    expect(text).not.toContain('scope');
    expect(result.error ?? result.result?.isError).toBeTruthy();
  });

  test('an expired token is served the public tier and told so', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await grantFor(['profile'], { iat: now - 7200, exp: now - 3600 });
    const names = (await listTools(token)).map((t) => t.name);
    expect(names).not.toContain('get_availability');
    const { json } = await rpc(
      {
        jsonrpc: '2.0',
        id: ++id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'suite', version: '1' },
        },
      },
      token,
    );
    // Observable, which is what a revocation drill (09 §3 item 6) needs --
    // and deliberately not specific about WHY, which is what stops it being
    // an oracle for probing tokens.
    expect(json.result.instructions).toMatch(/was not accepted/i);
  });
});

describe('with a grant', () => {
  test('the granted scopes decide exactly which tools exist', async () => {
    const names = (await listTools(await grantFor(['profile']))).map((t) => t.name);
    expect(names).toContain('get_availability');
    expect(names).toContain('get_references');
    expect(names).toContain('get_compensation_expectations');
    expect(names).not.toContain('get_case_study_details');
    expect(names).not.toContain('get_application_narrative');
  });

  test('each profile tool returns its document', async () => {
    const token = await grantFor(['profile']);
    // NOT `as const`: a readonly tuple does not satisfy the mutable array type
    // the loop reads it as, and vitest alone would not show it -- only
    // `npm run check` would.
    const cases: [string, string][] = [
      ['get_availability', 'Fixture availability'],
      ['get_references', 'Fixture references'],
      ['get_compensation_expectations', 'Fixture terms'],
    ];
    for (const [tool, marker] of cases) {
      const result = await callTool(tool, undefined, token);
      expect(result.result.content[0].text, `${tool} should serve its document`).toContain(marker);
    }
  });

  test('get_case_study_details serves the unredacted layer by slug', async () => {
    const result = await callTool(
      'get_case_study_details',
      { slug: 'silent-failure' },
      await grantFor(['documents']),
    );
    expect(result.result.content[0].text).toContain('Fixture detail');
  });

  test('a refused slug and a missing document are indistinguishable to the caller', async () => {
    /**
     * THIS REPLACES the "a slug that could traverse is refused with a
     * sentence, not a read" test the plan carried, which asserted `isError`
     * and the absence of the availability fixture -- and would have passed
     * with `safeSegment` DELETED. R2 is a flat keyspace with no path
     * semantics, so `case-study/../profile/availability.md` is simply a key
     * that does not exist: `readPrivateDoc` answers `null` and the tool raises
     * the same `ToolError` either way. That test cannot tell "rejected at key
     * construction" apart from "read a key that happened not to be there".
     *
     * Traversal rejection itself is already proven where it is real, at the
     * unit level in tests/tier-private-docs.test.ts, and traversal to an
     * EXISTING key is categorically impossible: `/` is outside `safeSegment`'s
     * character class AND the key template's prefix is fixed.
     *
     * So this asserts the property the tool's own comment actually claims,
     * which nothing else pins: the two paths answer the SAME sentence, so a
     * caller probing slugs learns nothing about which ones exist. It fails the
     * day either path grows a message of its own.
     */
    const token = await grantFor(['documents']);
    const refused = await callTool(
      'get_case_study_details',
      { slug: '../profile/availability' },
      token,
    );
    const missing = await callTool('get_case_study_details', { slug: 'no-such-case-study' }, token);

    expect(refused.result.isError).toBe(true);
    expect(missing.result.isError).toBe(true);
    expect(refused.result.content[0].text).toBe(missing.result.content[0].text);
    // And still not a read: the refused slug did not reach the document it
    // was shaped to reach.
    expect(refused.result.content[0].text).not.toContain('Fixture availability');
  });

  test('get_application_narrative resolves the document from the grant audience', async () => {
    const result = await callTool(
      'get_application_narrative',
      undefined,
      await grantFor(['narrative']),
    );
    expect(result.result.content[0].text).toContain('Fixture narrative');
  });

  test('a missing document is a sentence, not a stack', async () => {
    await env.R2_PRIVATE.delete('narrative/other-audience.md');
    const now = Math.floor(Date.now() / 1000);
    const claims: TokenClaims = {
      v: 1,
      jti: newJti(),
      aud: 'other-audience',
      scopes: ['narrative'],
      iat: now,
      exp: now + 3600,
    };
    await recordIssue(env.DB, {
      jti: claims.jti,
      audience: claims.aud,
      scopes: claims.scopes,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      revokedAt: null,
      note: null,
    });
    const result = await callTool(
      'get_application_narrative',
      undefined,
      await mintToken(TEST_SIGNING_KEY, claims),
    );
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).not.toMatch(/at .*\.ts:|R2Bucket|TypeError/);
  });

  test('every gated call is audited as private, with its audience and jti', async () => {
    const token = await grantFor(['profile']);
    await callTool('get_availability', undefined, token);
    // The audit write is dispatched through ctx.waitUntil; poll rather than
    // sleep, the way tests/mcp-tools.test.ts does.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const row = await env.DB.prepare(
        "SELECT tier, audience, grant_jti FROM mcp_tool_calls WHERE tool='get_availability' ORDER BY id DESC LIMIT 1",
      ).first<{ tier: string; audience: string; grant_jti: string }>();
      if (row) {
        expect(row.tier).toBe('private');
        expect(row.audience).toBe(AUDIENCE);
        expect(row.grant_jti).toBeTruthy();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('no audit row for get_availability');
  });
});

/**
 * MECHANISM 2, tested at the only level where it is reachable -- and the fact
 * that this test cannot be an HTTP round trip is the point rather than a
 * shortcut.
 *
 * The private tier has two independent guarantees. Mechanism 1 is
 * registration: `registerGatedTools` (workers/mcp/src/gated.ts) does not
 * register a gated tool at all unless the grant carries its scope, which every
 * test above exercises over the wire. Mechanism 2 is `defineTool`'s call-time
 * `hasScope` check, which Task 4 deliberately put INSIDE `guarded` so that a
 * scope refusal is audited and spends limiter budget rather than being
 * answered off to the side.
 *
 * Mechanism 1 makes mechanism 2 UNREACHABLE over HTTP, and that is exactly
 * what it is for. Registration and the declared scope are decided from the
 * same `tc.grant`, in the same request, so no request can be built in which a
 * caller reaches a registered tool whose scope they lack -- an inconsistency
 * would have to be introduced by a future EDIT to gated.ts (a tool registered
 * under one branch and declaring another scope, or registered
 * unconditionally). Mechanism 2 is the net under that edit.
 *
 * So it is exercised where it lives: one `defineTool` registration against a
 * grant that lacks the declared scope, invoked directly. The registrar is a
 * capture rather than an `McpServer` because what is under test is the
 * wrapper's guard, not the SDK's dispatch -- and because a real gated tool
 * with this shape must never exist in the shipped surface.
 *
 * Without this, that branch of define.ts has no test at all: it is the one
 * call an operator most needs to see, because reaching it means either someone
 * is probing for gated tool names or mechanism 1 has regressed.
 */
test("a scope refusal is audited as an error, on the caller's own tier and audience", async () => {
  const PROBE = 'probe_scope_refusal';
  type Invoke = (...params: unknown[]) => Promise<CallToolResult>;

  let invoke: Invoke | undefined;
  // Named `registrar`, not `server`, and that is not a style choice.
  // tests/mcp-audit.test.ts's seam walk greps every source file in the repo
  // for the two SDK registration calls SPELLED AS TEXT -- receiver included --
  // and requires each match to live in define.ts. A binding named `server`
  // here would put that exact text in this file and read as an offender, and
  // so does quoting the call in a comment: MEASURED, this comment said the
  // literal out loud on its first draft and turned that test red. The capture
  // below still only ever runs because `defineTool` calls it.
  const registrar = {
    registerTool: (_name: string, _config: unknown, callback: Invoke) => {
      invoke = callback;
    },
  } as unknown as McpServer;

  const grant: Grant = {
    jti: newJti(),
    audience: AUDIENCE,
    scopes: ['profile'],
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  // The audit write goes through `ctx.waitUntil`; collecting the promise is
  // what lets this assert on the row without polling for it.
  const dispatched: Promise<unknown>[] = [];
  const tc: ToolContext = {
    env,
    ctx: {
      waitUntil: (promise: Promise<unknown>) => dispatched.push(promise),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    request: undefined,
    grant,
  };

  let handlerRan = false;
  defineTool(
    registrar,
    tc,
    {
      name: PROBE,
      title: 'Scope-check probe',
      description: 'Test-only. Declares a scope this grant does not carry.',
      cost: 'cheap',
      scope: 'documents',
    },
    async () => {
      handlerRan = true;
      return 'the handler must not be reached';
    },
  );

  // `(args, ctx)`: the SDK passes the context LAST, and `defineTool` reads the
  // arguments only when there is more than one parameter -- see its own note.
  const result = await invoke!({}, {});

  expect(handlerRan, 'the handler must not run for a refused scope').toBe(false);
  expect(result.isError).toBe(true);
  expect((result.content?.[0] as { text: string }).text).toBe(`${PROBE} requires a scoped token.`);

  await Promise.all(dispatched);
  const row = await env.DB.prepare(
    'SELECT tier, audience, grant_jti, outcome, args_hash FROM mcp_tool_calls WHERE tool=? ORDER BY id DESC LIMIT 1',
  )
    .bind(PROBE)
    .first<{
      tier: string;
      audience: string;
      grant_jti: string;
      outcome: string;
      args_hash: string;
    }>();

  // The row is the whole point: a refusal that left no trace would be the one
  // call worth seeing and the only one nobody could see.
  expect(row, 'a scope refusal must leave an audit row').not.toBeNull();
  expect(row!.outcome).toBe('error');
  expect(row!.tier).toBe('private');
  expect(row!.audience).toBe(AUDIENCE);
  expect(row!.grant_jti).toBe(grant.jti);
  // A real digest, not `guarded`'s `ARGS_HASH_UNAVAILABLE` sentinel -- which
  // is the mechanical proof that the check ran INSIDE the guard rather than as
  // an early return in front of it. An early return would answer the same
  // sentence with no hash, no row, and no limiter spend.
  expect(row!.args_hash).toMatch(/^[0-9a-f]{64}$/);
});

test('no gated tool NAME or DESCRIPTION carries search language', async () => {
  // These are code-resident strings and therefore public surfaces the moment
  // anyone with a token pastes a screenshot (09 §2). The DOCUMENTS they serve
  // are runtime data and are deliberately not scanned -- that is where
  // audience-specific meaning is allowed to live.
  const tools = await listTools(await grantFor(['fit', 'profile', 'documents', 'narrative']));
  const metadata = JSON.stringify(tools);
  for (const pattern of BANNED_PATTERNS) {
    expect(metadata, `gated tool metadata matched ${pattern}`).not.toMatch(pattern);
  }
});

test('the resource surface is identical with and without a grant', async () => {
  // Discharges the obligation workers/mcp/src/resources.ts records for this
  // day: a ResourceTemplate's `list` callback is invoked by the SDK straight
  // from its own request handler, so it passes through neither the limiter,
  // the audit trail, nor any token check. Day 5's answer is to register NO
  // gated resource, and this is the test that keeps that true -- the day
  // someone adds one, these two listings diverge and this fails.
  const token = await grantFor(['fit', 'profile', 'documents', 'narrative']);
  for (const method of ['resources/list', 'resources/templates/list']) {
    const anonymous = (await rpc({ jsonrpc: '2.0', id: ++id, method, params: {} })).json.result;
    const granted = (await rpc({ jsonrpc: '2.0', id: ++id, method, params: {} }, token)).json
      .result;
    expect(granted, `${method} must not change with a grant`).toEqual(anonymous);
  }
});
