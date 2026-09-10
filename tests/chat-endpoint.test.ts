import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS } from './workers';
import { mintToken, newJti, type Scope, type TokenClaims } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant';
import type { McpEnv } from '../workers/mcp/src/env';

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
const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
let env: McpEnv;

beforeAll(async () => {
  await server.listen();
  const mcp = server.getWorker<McpEnv>('ryanlindsey-me-mcp');
  // `chat_turns` arrives with migrations/0004; without this the transcript
  // assertions below fail on a missing table rather than on a missing row.
  await mcp.applyD1Migrations('DB');
  env = await mcp.getEnv();
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

  test('the limiter refuses the thirteenth message in a window', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.7' };
    const codes: unknown[] = [];
    for (let i = 0; i < 13; i += 1) {
      const [first] = await frames(await post({ question: `q${i}` }, headers));
      codes.push(first?.data.code);
    }
    expect(codes.slice(0, 12).every((code) => code === 'unreachable')).toBe(true);
    expect(codes[12]).toBe('rate-limited');
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
