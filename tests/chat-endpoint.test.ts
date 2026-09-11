import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS, MCP_WORKER } from './workers';
import { LIMITS } from '../src/lib/mcp/limits';
import { referrerClassFor } from '../src/lib/agent-intel/classify';
import { mintToken, newJti, type Scope, type TokenClaims } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant';
import { chatAgentEvent, chatHighIntentEvent, firstOfSession } from '../workers/mcp/src/chat';
import type { McpEnv } from '../workers/mcp/src/env';

/**
 * The AE binding double (fix round 1, task-13a-findings-r1.md's Important
 * finding). NOT in `MCP_HARNESS_WORKERS` (./workers.ts): that array's
 * `MCP_WORKER` is shared by every suite that boots this Worker, and no other
 * suite has a use for a readable `AE`, so the override is built locally here
 * instead of widening a shared config for one file's sake. `workers/mock-ae`
 * carries the full reasoning for why this Worker, and what it costs, in its
 * own wrangler.jsonc and src/index.ts.
 */
type MockAeModule = typeof import('../workers/mock-ae/src/index');
const MOCK_AE_WORKER = { configPath: './workers/mock-ae/wrangler.jsonc' };

/**
 * `POST /chat` (04 §1) -- everything AROUND the model call.
 *
 * WHAT THIS SUITE CANNOT PROVE, stated rather than implied: the engine is off
 * here (`CHAT_ENGINE: 'off'` in tests/workers.ts) because the harness's `AI` is
 * a service binding and its `VECTORIZE` throws `needs to be run remotely`. So no
 * test below sees a real answer, a real retrieval or a real stream. The engine
 * itself is covered with stubs in tests/chat-engine.test.ts, the framing in
 * tests/chat-protocol.test.ts, and the round trip by hand and by the chat eval
 * suite against a deployed endpoint (Task 9).
 *
 * What it DOES prove is the part with the most branches and the least
 * inspection: admission, the limiter, the refusal framing, the headers, and
 * that nothing is fabricated when the engine is off.
 */
const server = createTestHarness({
  // DERIVED from `MCP_HARNESS_WORKERS` (./workers.ts) rather than hand-listed
  // (task-13a-findings-final.md item 8): the earlier version named
  // `SITE_WORKER`, `MOCK_BROWSER_WORKER` and `MOCK_AI_WORKER` explicitly,
  // which meant a fifth worker added to the shared array in the future would
  // silently never reach this suite. Filtering `MCP_WORKER` back out and
  // re-adding it with the `AE` override merged in keeps every OTHER worker
  // in that array reachable automatically, whatever it grows to.
  workers: [
    { ...MCP_WORKER, bindingOverrides: { ...MCP_WORKER.bindingOverrides, AE: 'mock-ae' } },
    ...MCP_HARNESS_WORKERS.filter((worker) => worker !== MCP_WORKER),
    MOCK_AE_WORKER,
  ],
});
let env: McpEnv;
let mockAe: Awaited<
  ReturnType<ReturnType<typeof server.getWorker<unknown, MockAeModule>>['getExport']>
>;

beforeAll(async () => {
  await server.listen();
  const mcp = server.getWorker<McpEnv>('ryanlindsey-me-mcp');
  // `chat_turns` arrives with migrations/0004; without this the transcript
  // assertions below fail on a missing table rather than on a missing row.
  await mcp.applyD1Migrations('DB');
  env = await mcp.getEnv();
  mockAe = await server.getWorker<unknown, MockAeModule>('mock-ae').getExport();
});

afterAll(async () => {
  await server.close();
});

/**
 * A registered, signed grant carrying `scopes`.
 *
 * The fourth copy of this shape in this repo (tests/mcp-gated.test.ts:141,
 * tests/fit-pages.test.ts:111, tests/tier-grant.test.ts). Both halves are
 * required and the second is the one that is easy to forget: mint through the
 * `RLME_TOKEN_KEY_SOURCE: 'test'` seam AND insert the `access_tokens` row,
 * because `resolveGrant` consults the registry and an unregistered token
 * resolves to no grant at all.
 *
 * Extracting the four into a shared module is a tidy-up this task does NOT take
 * on, and the reason is scope rather than taste: it would touch three passing
 * suites in a branch about chat.
 */
async function tokenWith(scopes: Scope[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    v: 1,
    jti: newJti(),
    aud: 'chat-endpoint-suite',
    scopes,
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
    note: 'chat endpoint suite',
  });
  return mintToken(TEST_SIGNING_KEY, claims);
}

const chat = (body: unknown, headers: Record<string, string> = {}) =>
  server.getWorker('ryanlindsey-me-mcp').fetch('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/**
 * Every call carries a bot-check token by default, because admission now
 * requires one (`RLME_TURNSTILE_MODE: 'stub'` on this Worker makes any non-empty
 * token pass while still refusing an absent one -- see src/lib/turnstile.ts,
 * which keeps the missing-token branch reachable under the stub on purpose).
 * The omission case gets its own test rather than being the default.
 */
const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  chat({ turnstileResponse: 'stub-token', ...body }, headers);

// Structural, not `Response`: the harness's `fetch` answers with undici's
// Response and this file also builds Workers ones, and the two are distinct
// types that TypeScript will not unify. Reading the body is all this needs.
const frames = async (response: { text(): Promise<string> }) => {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const [event = '', data = ''] = frame.split('\n');
      return {
        event: event.replace('event: ', ''),
        data: JSON.parse(data.replace('data: ', '')) as Record<string, unknown>,
      };
    });
};

describe('POST /chat', () => {
  test('GET is not the endpoint', async () => {
    expect((await server.getWorker('ryanlindsey-me-mcp').fetch('/chat')).status).toBe(405);
  });

  test('a body that is not JSON is refused without reaching the engine', async () => {
    const response = await server.getWorker('ryanlindsey-me-mcp').fetch('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  test('the response is an event stream that is never cached', async () => {
    const response = await post({ question: 'what is this site?' });
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('it carries no CORS headers, unlike /mcp', async () => {
    const response = await post({ question: 'hello' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('no bot-check token and no grant is refused before anything is spent', async () => {
    const [first] = await frames(await chat({ question: 'what is this site?' }));
    expect(first?.event).toBe('error');
    expect(first?.data.code).toBe('bot-check');
  });

  test('an empty bot-check token is the same as none', async () => {
    const [first] = await frames(await post({ question: 'hello', turnstileResponse: '' }));
    expect(first?.data.code).toBe('bot-check');
  });

  test('a grant carrying the evals scope is admitted with no bot check at all', async () => {
    const token = await tokenWith(['evals']);
    const response = await chat(
      { question: 'what is this site?' },
      { authorization: `Bearer ${token}` },
    );
    const [first] = await frames(response);
    // Past admission, so the refusal is the engine's own (it is off here),
    // which is the proof the grant was accepted rather than the challenge.
    expect(first?.data.code).toBe('unreachable');
  });

  test('a grant WITHOUT the evals scope does not open this door', async () => {
    const token = await tokenWith(['fit']);
    const [first] = await frames(
      await chat({ question: 'hello' }, { authorization: `Bearer ${token}` }),
    );
    expect(first?.data.code).toBe('bot-check');
  });

  test('the engine being off is reported as an error frame, not a 500', async () => {
    const response = await post({ question: 'what is this site?' });
    expect(response.status).toBe(200);
    const [first] = await frames(response);
    expect(first?.event).toBe('error');
    expect(first?.data.code).toBe('unreachable');
  });

  test('an empty question is refused with its own code', async () => {
    const [first] = await frames(await post({ question: '   ' }));
    expect(first?.data.code).toBe('empty');
  });

  test('an over-long question is refused with its own code', async () => {
    const [first] = await frames(await post({ question: 'x'.repeat(2000) }));
    expect(first?.data.code).toBe('too-long');
  });

  test('an error frame carries a code and never a sentence', async () => {
    const [first] = await frames(await post({ question: 'hello' }));
    expect(Object.keys(first?.data ?? {})).toEqual(['code']);
  });

  test('the limiter refuses the message after the allowance is spent', async () => {
    // DERIVED from `LIMITS.conversation`, not the literal 13 this used to hard-
    // code. That number was right for a limit of twelve and silently wrong the
    // moment the limit moved -- and it moved, because a full eval run consumed
    // exactly twelve of twelve. A test that pins a behaviour should read the
    // constant that decides it.
    const allowance = LIMITS.conversation.limit;
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    const codes: unknown[] = [];
    for (let i = 0; i <= allowance; i += 1) {
      const [first] = await frames(await post({ question: `q${i}` }, headers));
      codes.push(first?.data.code);
    }
    // Everything up to the allowance reaches the engine (off here, so
    // `unreachable`); the one after it is refused by the limiter instead.
    expect(codes.slice(0, allowance).every((code) => code === 'unreachable')).toBe(true);
    expect(codes[allowance]).toBe('rate-limited');
  });

  test('a refused message is audited, so /ops sees the refusal', async () => {
    await post({ question: 'audited-refusal-probe' }, { 'cf-connecting-ip': '203.0.113.9' });
    const { results } = await env.DB.prepare(
      `SELECT outcome FROM chat_turns WHERE question = ? LIMIT 1`,
    )
      .bind('audited-refusal-probe')
      .all();
    expect(results[0]?.outcome).toBe('refused');
  });

  test('a malformed session id is replaced rather than stored', async () => {
    await post({ question: 'session-id-probe', sessionId: '../../etc/passwd' });
    const { results } = await env.DB.prepare(
      `SELECT session_id FROM chat_turns WHERE question = ? LIMIT 1`,
    )
      .bind('session-id-probe')
      .all();
    expect(String(results[0]?.session_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('no transcript row carries an IP or a user agent, because there is no column for one', async () => {
    const { results } = await env.DB.prepare(`SELECT * FROM chat_turns LIMIT 1`).all();
    const columns = Object.keys(results[0] ?? {});
    expect(columns.length).toBeGreaterThan(0);
    expect(columns).not.toContain('ip');
    expect(columns).not.toContain('user_agent');
  });
});

/**
 * Task 13a: the two seams chat.ts closes (06 §3) -- `firstOfSession`, the
 * corrected first-turn decision (task-13a-findings-final.md, Important 1);
 * `chatHighIntentEvent`, which layers the server-minted-session gate on top
 * of it (Important 2); `chatAgentEvent`, the AE-event shape both
 * `recordAgentEvent` call sites share; and (fix round 1,
 * task-13a-findings-r1.md) the `refuse` call site's actual effect, asserted
 * end to end below rather than only through the shape `chatAgentEvent` builds.
 *
 * WHY SEAM A AND END-OF-STREAM SEAM B STILL CANNOT BE DRIVEN THROUGH THE
 * ENDPOINT: `startAnswer` (src/lib/chat/engine.ts) always throws before either
 * one runs, on every turn `describe('POST /chat', ...)` above sends.
 * `env.CHAT_ENGINE` is `'off'` on this Worker (MCP_WORKER in
 * tests/workers.ts), checked unconditionally once a question passes its own
 * length check -- and a question that fails that check throws even earlier,
 * with its own `empty`/`too-long` code, before `CHAT_ENGINE` is ever read. So
 * regardless of admission, grant, or question validity, `startAnswer` throws
 * and `handleChat` calls `refuse` instead. That is why 13 of the 16
 * pre-existing tests above reach `refuse` (`GET is not the endpoint` and `a
 * body that is not JSON` both return before `refuse` is even defined, and `no
 * transcript row carries an IP or a user agent` makes no HTTP request at all
 * -- Important 3 in the same findings file), and why `firstOfSession`,
 * `chatHighIntentEvent` and `chatAgentEvent` are asserted directly rather
 * than through the endpoint -- see each function's own doc comment in
 * chat.ts for why that is the real observation point rather than a
 * workaround.
 *
 * `refuse`'s `recordAgentEvent` call is DIFFERENT: it is not behind that
 * unreachable success, so once something could read `AE` back, the call site
 * itself became testable. Miniflare's local Analytics Engine dataset offers no
 * such read-back on its own -- `writeDataPoint` there does nothing at all, not
 * even log (node_modules/miniflare/dist/src/workers/analytics-engine) -- but
 * `bindingOverrides` sidesteps that the same way `{ AI: 'mock-ai' }` already
 * does in tests/workers.ts for a binding Miniflare cannot emulate usefully:
 * `workers/mock-ae` stands in for `AE` here (local to this file; see the
 * `MOCK_AE_WORKER` comment above), and `describe('the refuse AE datapoint',
 * ...)` below reads it back.
 *
 * What remains NOT asserted, and cannot be under this harness: the
 * end-of-stream `recordAgentEvent` call and Seam A's `env.EVENTS.send`, both
 * downstream of the `startAnswer` success explained above.
 */
describe('firstOfSession', () => {
  /** A `chat_turns` row with `outcome` controlled, everything else filler. */
  async function seedTurn(sessionId: string, outcome: 'ok' | 'refused' | 'error'): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO chat_turns
         (id, session_id, created_at, question, answer, model, sources_json,
          cited, invalid_citations, outcome, duration_ms, surface)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        sessionId,
        new Date().toISOString(),
        'seed question',
        'seed answer',
        'seed-model',
        '[]',
        0,
        0,
        outcome,
        1,
        'direct',
      )
      .run();
  }

  test('a fresh session id counts as the first turn', async () => {
    expect(await firstOfSession(env, crypto.randomUUID())).toBe(true);
  });

  test('a session id with an existing OK-outcome row does not', async () => {
    const sessionId = crypto.randomUUID();
    await seedTurn(sessionId, 'ok');
    expect(await firstOfSession(env, sessionId)).toBe(false);
  });

  test('a session id whose only row is a REFUSED turn still counts as first (Important 1)', async () => {
    // The bug the corrected Ruling 4 exists to fix: a visitor's first
    // interaction being refused (a fat-fingered empty submit, a Turnstile
    // hiccup, a limiter trip) must not consume their session's one
    // notification before they ever ask a real question.
    const sessionId = crypto.randomUUID();
    await seedTurn(sessionId, 'refused');
    expect(await firstOfSession(env, sessionId)).toBe(true);
  });

  test('a session id whose only row is an ERROR-outcome turn still counts as first (the accepted trade)', async () => {
    // Pins the trade `firstOfSession`'s own comment names explicitly: a
    // session whose first answer broke mid-stream can notify a second time
    // on its next turn, which is the safe direction to err in.
    const sessionId = crypto.randomUUID();
    await seedTurn(sessionId, 'error');
    expect(await firstOfSession(env, sessionId)).toBe(true);
  });

  test('a failed read reports NOT first, and logs rather than throwing (Ruling 4)', async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
    const broken = {
      DB: {
        prepare: () => {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as McpEnv;
    try {
      await expect(firstOfSession(broken, crypto.randomUUID())).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(
      logged.some((entry) => entry instanceof Error && entry.message === 'D1 unavailable'),
      'the original D1 failure must reach the log',
    ).toBe(true);
  });
});

describe('chatHighIntentEvent', () => {
  test('no session id supplied (the eval-harness shape) never queues, even for an otherwise-fresh session', async () => {
    // task-13a-findings-final.md, Important 2: evals/run.mjs's askOnce sends
    // `{ question }` with no `sessionId` at all. The session id this test
    // passes is guaranteed fresh (nothing has ever seeded it), so
    // `firstOfSession` alone WOULD say true -- this is the exact case the
    // negative filter exists to catch, and it is what stops an eval run from
    // paging the operator 12 times.
    const event = await chatHighIntentEvent(env, crypto.randomUUID(), false);
    expect(event).toBeNull();
  });

  test('a caller-supplied session id on its first turn queues a chat-session event', async () => {
    // A direct caller that DOES send a session id must still fire the seam --
    // that is `src/pages/chat.astro`'s own shape, and losing it would recreate
    // the gap Important 1 closed.
    const event = await chatHighIntentEvent(env, crypto.randomUUID(), true);
    expect(event?.kind).toBe('chat-session');
  });

  test('a caller-supplied session id past its first (OK) turn does not requeue', async () => {
    const sessionId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO chat_turns
         (id, session_id, created_at, question, answer, model, sources_json,
          cited, invalid_citations, outcome, duration_ms, surface)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        sessionId,
        new Date().toISOString(),
        'seed question',
        'seed answer',
        'seed-model',
        '[]',
        0,
        0,
        'ok',
        1,
        'direct',
      )
      .run();
    const event = await chatHighIntentEvent(env, sessionId, true);
    expect(event).toBeNull();
  });
});

describe('chatAgentEvent', () => {
  const requestWith = (headers: Record<string, string> = {}) =>
    new Request('https://mcp.ryanlindsey.me/chat', { method: 'POST', headers });

  test('surface is always the literal "chat", never the transcript\'s site/direct vocabulary', () => {
    // The exact bug Ruling 1 (task-13a-brief.md) warns about: a `surface`
    // local read here by mistake would typecheck whenever its value happens
    // to be 'site', because that string is valid in both vocabularies. This
    // function takes no `surface` parameter at all, so there is nothing in
    // scope to pass by mistake.
    expect(chatAgentEvent(requestWith(), 200, 5).surface).toBe('chat');
  });

  test('status and durationMs pass through unchanged', () => {
    const event = chatAgentEvent(requestWith(), 429, 123);
    expect(event.status).toBe(429);
    expect(event.durationMs).toBe(123);
  });

  test('classification is computed from the real request, not a fixed value', () => {
    const agent = chatAgentEvent(requestWith({ 'user-agent': 'ClaudeBot/1.0' }), 200, 1);
    expect(agent.classification.agentClass).toBe('agent');
    expect(agent.classification.agent).toBe('ClaudeBot');

    const browser = chatAgentEvent(requestWith({ 'sec-fetch-mode': 'navigate' }), 200, 1);
    expect(browser.classification.agentClass).toBe('browser');
  });

  test("no campaign domains are read here, matching src/worker.ts's CAMPAIGN_DOMAINS_OFF", () => {
    const referer = 'https://a-campaign-domain.example/post';
    // Proof this referer is a genuine probe, not an arbitrary one that could
    // never classify as 'campaign' regardless of what chat.ts does: under a
    // real, non-empty campaign list that names it, referrerClassFor really
    // does say 'campaign'. Without this line the test below would still pass
    // if `chatAgentEvent` read a real campaign list, as long as that list
    // didn't happen to name this particular domain -- exactly the assertion
    // that cannot fail task-13a-findings-r1.md's Bundled finding 2 flagged.
    expect(referrerClassFor(referer, ['a-campaign-domain.example'])).toBe('campaign');

    // The real call site uses CAMPAIGN_DOMAINS_OFF (empty), so the SAME
    // referer through it is not labelled campaign -- pinned to the actual
    // label ('other': not social, not search, and campaignDomains is empty
    // so it never matches) rather than the weaker `not.toBe('campaign')`
    // (task-13a-findings-final.md item 7): the positive assertion is exactly
    // as available and pins what the row actually says.
    const event = chatAgentEvent(requestWith({ referer }), 200, 1);
    expect(event.classification.referrerClass).toBe('other');
  });
});

/**
 * Fix round 1 (task-13a-findings-r1.md, Important finding 1): the `refuse`
 * half of Seam B, asserted end to end rather than only through the shape
 * `chatAgentEvent` builds. `mockAe` is the SAME running `workers/mock-ae`
 * instance the `AE` binding override points `env.AE` at (see the top-of-file
 * comments), so a datapoint the Worker under test writes through the binding
 * is exactly what `mockAe.points()` reads back here.
 *
 * `vi.waitFor` around the read (task-13a-findings-final.md item 12) rather
 * than a single read: the write is a service-binding RPC call `refuse`
 * neither awaits nor wraps in `ctx.waitUntil()` (workers/mock-ae/src/index.ts's
 * own doc comment says why, and that it is MEASURED to land in time rather
 * than guaranteed to). Polling removes the flake class outright without
 * weakening what this test proves: with the production call site deleted,
 * `points()` never reaches length 1 and `waitFor` still times out and fails
 * the test, so the delete-the-line property survives intact.
 */
describe('the refuse AE datapoint', () => {
  test('a refusal records exactly one AE point, shaped like chatAgentEvent says', async () => {
    await mockAe.reset();
    const ip = '203.0.113.99';
    const userAgent = 'ClaudeBot/1.0';
    await post(
      { question: 'ae-datapoint-probe' },
      { 'cf-connecting-ip': ip, 'user-agent': userAgent },
    );

    let points: Awaited<ReturnType<typeof mockAe.points>> = [];
    await vi.waitFor(async () => {
      points = await mockAe.points();
      expect(points).toHaveLength(1);
    });

    // AE_BLOB_FIELDS (src/lib/agent-intel/record.ts) is the published legend
    // this indexes against: ['agent_class', 'agent', 'route_class',
    // 'referrer_class', 'surface', 'status_class'].
    expect(points[0]?.blobs?.[1]).toBe('ClaudeBot');
    expect(points[0]?.blobs?.[4]).toBe('chat');
    expect(points[0]?.blobs?.[5]).toBe('2xx');
    expect(points[0]?.doubles?.[0]).toBe(1);
    expect(points[0]?.doubles?.[1]).toBeGreaterThanOrEqual(0);

    // The published /ai-policy promise (task-13a-findings-final.md item 11),
    // defended end to end through the real binding for the first time in
    // this repo: no blob carries the caller's IP or its raw user agent
    // string (the recorded label is 'ClaudeBot', the bounded class -- not
    // 'ClaudeBot/1.0', the string this request actually sent).
    for (const blob of points[0]?.blobs ?? []) {
      expect(blob).not.toContain(ip);
      expect(blob).not.toContain(userAgent);
    }
  });
});
