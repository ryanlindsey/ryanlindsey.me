import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS } from './workers';
import { mintToken, newJti, type Scope } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant';

// `POST /grant` (04 §2): what one bearer unlocks, answered by the Worker that
// owns the question. It exists so the site can preload a campaign's target
// description without learning how to verify a token, and so that preload
// follows the GRANT rather than a global `active` entry -- which is what lets
// more than one campaign run at a time.

const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
let db: D1Database;
let kv: KVNamespace;
let origin = '';

beforeAll(async () => {
  const { url } = await server.listen();
  origin = url.origin;
  const mcp = server.getWorker<{ DB: D1Database; KV_CONFIG: KVNamespace }>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  const env = await mcp.getEnv();
  db = env.DB;
  kv = env.KV_CONFIG;
});
afterAll(async () => {
  await server.close();
});

async function grant(audience: string, scopes: Scope[] = ['fit']): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: 1 as const,
    jti: newJti(),
    aud: audience,
    scopes,
    iat: now,
    exp: now + 3600,
  };
  await recordIssue(db, {
    jti: claims.jti,
    audience,
    scopes,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    revokedAt: null,
    note: 'grant context suite',
  });
  return mintToken(TEST_SIGNING_KEY, claims);
}

function post(token: string | null): Promise<Response> {
  return fetch(`${origin}/grant`, {
    method: 'POST',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

test('a bearerless POST /grant is a bare 404', async () => {
  // Same refusal as every other gated surface. A 403 would confirm the
  // endpoint exists to anyone who probes for it.
  const response = await post(null);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe('');
});

test('a garbage bearer is the same 404', async () => {
  const response = await post('rlme1.not-a-real-token.nope');
  expect(response.status).toBe(404);
});

test('a granted token gets its tools, audience and expiry', async () => {
  const token = await grant('fixture-one', ['fit', 'profile']);
  const response = await post(token);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    tools: string[];
    audience: string;
    expiresAt: number;
    preload: string;
  };
  expect(body.tools).toContain('analyze_fit');
  expect(body.tools).toContain('get_availability');
  expect(body.tools).not.toContain('judge_answer');
  expect(body.audience).toBe('fixture-one');
  expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  expect(body.preload).toBe('');
});

test('the preload follows the grant, so two campaigns can run at once', async () => {
  // THE POINT OF THIS ENDPOINT. Two entries, both `active`, and each token
  // sees only its own. Under the `activeCampaign()` this replaced, whichever
  // entry KV listed first won for every caller.
  await kv.put(
    'campaign:fixture-two',
    JSON.stringify({
      id: 'fixture-two',
      company: 'Fixture Two',
      status: 'active',
      jd_text: 'TWO-TARGET-TEXT',
      referrer_domains: [],
      hero_line: 'A generic line.',
      token_audience: 'fixture-two',
      gated_narrative_doc: 'narratives/two.md',
    }),
  );
  await kv.put(
    'campaign:fixture-three',
    JSON.stringify({
      id: 'fixture-three',
      company: 'Fixture Three',
      status: 'active',
      jd_text: 'THREE-TARGET-TEXT',
      referrer_domains: [],
      hero_line: 'A generic line.',
      token_audience: 'fixture-three',
      gated_narrative_doc: 'narratives/three.md',
    }),
  );

  const two = (await (await post(await grant('fixture-two'))).json()) as { preload: string };
  const three = (await (await post(await grant('fixture-three'))).json()) as { preload: string };
  expect(two.preload).toBe('TWO-TARGET-TEXT');
  expect(three.preload).toBe('THREE-TARGET-TEXT');
});

test('a GET is a 404, like any other path this Worker does not serve', async () => {
  const response = await fetch(`${origin}/grant`);
  expect(response.status).toBe(404);
});
