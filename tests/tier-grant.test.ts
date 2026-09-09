import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS } from './workers';
import { mintToken, newJti, type TokenClaims } from '../src/lib/tier/token';
import { recordIssue, revokeToken } from '../src/lib/tier/registry';
import {
  bearerFrom,
  hasScope,
  resolveGrant,
  TEST_SIGNING_KEY,
  type GrantEnv,
} from '../src/lib/tier/grant';

const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
let env: {
  DB: D1Database;
  RLME_TOKEN_SIGNING_KEY: SecretsStoreSecret;
  RLME_TOKEN_KEY_SOURCE?: string;
};

const NOW = 1_800_000_000;

beforeAll(async () => {
  await server.listen();
  const mcp = server.getWorker<typeof env>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  env = await mcp.getEnv();
});
afterAll(async () => {
  await server.close();
});

/** Mints a token AND registers it, which is the only combination that resolves. */
async function issue(over: Partial<TokenClaims> = {}) {
  const claims: TokenClaims = {
    v: 1,
    jti: newJti(),
    aud: 'fixture-audience',
    scopes: ['fit', 'profile'],
    iat: NOW,
    exp: NOW + 3600,
    ...over,
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
  return { claims, token: await mintToken(TEST_SIGNING_KEY, claims) };
}

const withHeader = (token: string) =>
  new Request('https://mcp.example/mcp', { headers: { authorization: `Bearer ${token}` } });

test('bearerFrom reads the header case-insensitively and tolerates its absence', () => {
  expect(bearerFrom(new Request('https://x/', { headers: { authorization: 'Bearer abc' } }))).toBe(
    'abc',
  );
  expect(bearerFrom(new Request('https://x/', { headers: { Authorization: 'bearer abc' } }))).toBe(
    'abc',
  );
  expect(bearerFrom(new Request('https://x/'))).toBeNull();
  expect(
    bearerFrom(new Request('https://x/', { headers: { authorization: 'Basic abc' } })),
  ).toBeNull();
  expect(bearerFrom(undefined)).toBeNull();
});

test('no header at all is an ordinary public caller, not a refusal', async () => {
  expect(await resolveGrant(env, new Request('https://mcp.example/mcp'), NOW)).toEqual({
    grant: null,
    refusal: null,
  });
});

test('a registered, unexpired, unrevoked token resolves to a grant', async () => {
  const { claims, token } = await issue();
  const { grant, refusal } = await resolveGrant(env, withHeader(token), NOW);
  expect(refusal).toBeNull();
  expect(grant).toEqual({
    jti: claims.jti,
    audience: 'fixture-audience',
    scopes: ['fit', 'profile'],
    expiresAt: claims.exp,
  });
});

test('a well-signed token that was never registered is refused as unknown', async () => {
  // The signature is real; the registry has never heard of it. That is the
  // shape a leaked signing key produces, and it must not resolve.
  const claims: TokenClaims = {
    v: 1,
    jti: newJti(),
    aud: 'fixture-audience',
    scopes: ['fit'],
    iat: NOW,
    exp: NOW + 3600,
  };
  const token = await mintToken(TEST_SIGNING_KEY, claims);
  expect(await resolveGrant(env, withHeader(token), NOW)).toEqual({
    grant: null,
    refusal: 'unknown',
  });
});

test('a revoked token is refused immediately, with no cache to wait out', async () => {
  const { claims, token } = await issue();
  expect((await resolveGrant(env, withHeader(token), NOW)).grant).not.toBeNull();
  await revokeToken(env.DB, claims.jti, new Date(NOW * 1000).toISOString());
  expect(await resolveGrant(env, withHeader(token), NOW)).toEqual({
    grant: null,
    refusal: 'revoked',
  });
});

test('an expired token is refused before the registry is consulted', async () => {
  const { token } = await issue({ exp: NOW + 10 });
  expect(await resolveGrant(env, withHeader(token), NOW + 11)).toEqual({
    grant: null,
    refusal: 'expired',
  });
});

test('a forged signature is refused', async () => {
  const token = await mintToken('not-the-signing-key', {
    v: 1,
    jti: newJti(),
    aud: 'fixture-audience',
    scopes: ['fit'],
    iat: NOW,
    exp: NOW + 3600,
  });
  expect(await resolveGrant(env, withHeader(token), NOW)).toEqual({
    grant: null,
    refusal: 'bad_signature',
  });
});

test('the grant carries the REGISTRY scopes, not the token claim, when they disagree', async () => {
  // The claim is signed, so it cannot be edited by the holder -- but it CAN
  // be stale: scopes are narrowed in the registry when a capability is pulled
  // back without re-issuing. The narrower of the two wins, and the registry
  // is the live record.
  const { claims, token } = await issue({ scopes: ['fit', 'profile', 'documents', 'narrative'] });
  await env.DB.prepare('UPDATE access_tokens SET scopes = ? WHERE jti = ?')
    .bind(JSON.stringify(['fit']), claims.jti)
    .run();
  const { grant } = await resolveGrant(env, withHeader(token), NOW);
  expect(grant!.scopes).toEqual(['fit']);
});

test('hasScope narrows null away and answers per scope', async () => {
  const { token } = await issue({ scopes: ['fit'] });
  const { grant } = await resolveGrant(env, withHeader(token), NOW);
  expect(hasScope(grant, 'fit')).toBe(true);
  expect(hasScope(grant, 'narrative')).toBe(false);
  expect(hasScope(null, 'fit')).toBe(false);
});

/**
 * One JSON-RPC round trip at the MCP Worker, in the shape
 * tests/mcp-tools.test.ts established: streamable HTTP may answer as JSON or
 * as one SSE frame.
 * Dispatched at the Worker BY NAME rather than through `server.fetch()`, which
 * routes by route pattern.
 */
async function rpc(body: unknown, headers: Record<string, string> = {}) {
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
  const payload = text.startsWith('event:')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data:'))!
        .slice(5)
        .trim()
    : text;
  return { status: response.status, json: JSON.parse(payload) as { result?: unknown } };
}

/** The audit row lands through `ctx.waitUntil`, so it is polled rather than assumed. */
async function auditRows(count: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { results } = await env.DB.prepare(
      'SELECT tool, tier, audience, grant_jti, outcome FROM mcp_tool_calls',
    ).all();
    if (results.length >= count) return results;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`fewer than ${count} audit rows after 1s`);
}

test('a token on the wire reaches the audit row as tier, audience and grant_jti', async () => {
  // THE INTEGRATION THIS TASK IS, end to end and through the real endpoint:
  // ./workers.ts's seam -> index.ts's per-request `resolveGrant` -> the ONE
  // audit-row builder in define.ts's `guarded`. Every other test in this file
  // calls `resolveGrant` directly and would still pass if index.ts never
  // called it -- and `guarded` would then write `tier: 'public'` for a scoped
  // call, which that function's own comment calls worse than writing nothing,
  // "because it reads as evidence".
  //
  // `get_contact` deliberately: a PUBLIC tool, so what this asserts is the
  // tier resolution and nothing about scope gating (that is Task 7's suite).
  const { claims, token } = await issue();
  await env.DB.prepare('DELETE FROM mcp_tool_calls').run();

  const { status, json } = await rpc(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_contact', arguments: {} } },
    { authorization: `Bearer ${token}` },
  );
  expect(status).toBe(200);
  expect(json.result).toBeDefined();

  expect(await auditRows(1)).toEqual([
    {
      tool: 'get_contact',
      tier: 'private',
      audience: 'fixture-audience',
      grant_jti: claims.jti,
      outcome: 'ok',
    },
  ]);
});

test('the same call without a token still records the public tier', async () => {
  // The other half, and the one that would catch a `tier` derived from
  // something other than the grant's presence.
  await env.DB.prepare('DELETE FROM mcp_tool_calls').run();
  await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_contact', arguments: {} },
  });
  expect(await auditRows(1)).toEqual([
    {
      tool: 'get_contact',
      tier: 'public',
      audience: null,
      grant_jti: null,
      outcome: 'ok',
    },
  ]);
});

test('a resources/read carrying the same token records the private tier as well', async () => {
  // THE PLAN'S OWN NAMED RISK, as a measurement rather than a reading: "day 5
  // can change one and miss the other, and the miss is silent" (`guarded`'s
  // doc in workers/mcp/src/define.ts). `defineResource` and `defineTool` are
  // two adapters over ONE `guarded`, so this is guaranteed structurally --
  // and structural guarantees are exactly the ones that quietly stop holding
  // when someone adds a third registration path. The tool half above and this
  // half together are what would catch that.
  const { claims, token } = await issue();
  await env.DB.prepare('DELETE FROM mcp_tool_calls').run();

  const { status, json } = await rpc(
    { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'resume://json' } },
    { authorization: `Bearer ${token}` },
  );
  expect(status).toBe(200);
  expect(json.result).toBeDefined();

  expect(await auditRows(1)).toEqual([
    {
      // `resource:<name>`, the prefixed key-space `defineResource` derives
      // once so the audit trail and the limiter cannot drift apart.
      tool: 'resource:resume',
      tier: 'private',
      audience: 'fixture-audience',
      grant_jti: claims.jti,
      outcome: 'ok',
    },
  ]);
});

/**
 * The two tests below are NOT in the plan, and they exist because of something
 * the plan's own Task 2 measured: `verifyToken` REJECTS on a zero-length key
 * (`DOMException: Zero-length key is not supported`, thrown out of `hmacKey`
 * before any verdict exists), and the same task's probe proved
 * `RLME_TOKEN_SIGNING_KEY.get()` can THROW outright
 * (`Secret "RLME_TOKEN_SIGNING_KEY" not found`) because miniflare simulates
 * `secrets_store_secrets` against a local store nothing has populated.
 *
 * Both of those are reachable in production, not just here: a Secrets Store
 * secret can be deleted, rotated to empty, or bound to a store this Worker's
 * deploy has not written yet. Unwrapped, either one escapes `resolveGrant`,
 * escapes the `fetch` handler, and answers a caller with a 500 -- which fails
 * OPEN in the only sense that matters for an operator reading a dashboard: it
 * looks like the Worker broke rather than like the private tier is shut.
 *
 * A stand-in env rather than a mutated real one: `getEnv()` hands back the
 * live bindings, and rewriting `RLME_TOKEN_SIGNING_KEY` on that object would
 * leak into every test after this one in file order.
 */
const keyEnv = (get: () => Promise<string>): GrantEnv => ({
  DB: env.DB,
  // No RLME_TOKEN_KEY_SOURCE, deliberately: this is the DEPLOYED path, where
  // the key comes from Secrets Store and the seam is absent.
  RLME_TOKEN_SIGNING_KEY: { get } as unknown as SecretsStoreSecret,
});

test('an absent signing secret is a refusal, not a 500', async () => {
  const { token } = await issue();
  const absent = keyEnv(() =>
    Promise.reject(new Error('Secret "RLME_TOKEN_SIGNING_KEY" not found')),
  );
  expect(await resolveGrant(absent, withHeader(token), NOW)).toEqual({
    grant: null,
    refusal: 'unavailable',
  });
});

test('an empty signing secret is a refusal, not the DOMException crypto raises', async () => {
  const { token } = await issue();
  const empty = keyEnv(() => Promise.resolve(''));
  expect(await resolveGrant(empty, withHeader(token), NOW)).toEqual({
    grant: null,
    refusal: 'unavailable',
  });
});

test('an unrecognised key source still throws, and is not swallowed as a refusal', async () => {
  // The other half of the containment above, and the reason `KeySourceError`
  // is a class. `signingKey`'s second safety property is that a typo in the
  // seam is a 500 rather than a guess; a `catch` that could not tell that
  // apart from an unreadable secret would convert it into a private tier that
  // is silently and permanently shut, which is the failure the property
  // exists to make loud.
  const { token } = await issue();
  const typo: GrantEnv = { ...keyEnv(() => Promise.resolve('')), RLME_TOKEN_KEY_SOURCE: 'tets' };
  await expect(resolveGrant(typo, withHeader(token), NOW)).rejects.toThrow(
    /unrecognised RLME_TOKEN_KEY_SOURCE/,
  );
});

test('a token presented to a broken key does not become a public caller', async () => {
  // The distinction this asserts is the whole point of refusing rather than
  // returning `{ grant: null, refusal: null }`: a presented token that cannot
  // be judged is a REFUSAL, and ./grant.ts's `GrantResolution` comment is what
  // says so. Answering `null, null` would tell buildInstructions (Task 7's
  // server.ts) that nobody presented anything, and the operator running a
  // revocation drill would see the public tier and no explanation.
  const { token } = await issue();
  const { refusal } = await resolveGrant(
    keyEnv(() => Promise.resolve('')),
    withHeader(token),
    NOW,
  );
  expect(refusal).not.toBeNull();
});
