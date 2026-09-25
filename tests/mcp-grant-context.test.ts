import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS } from './workers';
import { mintToken, newJti, type Scope } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant';
import { handleGrantContext, type GrantContext } from '../workers/mcp/src/grant-context';
import type { McpEnv } from '../workers/mcp/src/env';

// `POST /grant` (04 §2): what one bearer unlocks, answered by the Worker that
// owns the question. It exists so the site can preload a campaign's target
// description without learning how to verify a token, and so that preload
// follows the GRANT rather than a global `active` entry -- which is what lets
// more than one campaign run at a time.

const server = createTestHarness({ workers: MCP_HARNESS_WORKERS });
let db: D1Database;
let kv: KVNamespace;
let mcpEnv: McpEnv;
let origin = '';

beforeAll(async () => {
  const { url } = await server.listen();
  origin = url.origin;
  const mcp = server.getWorker<McpEnv>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  mcpEnv = await mcp.getEnv();
  db = mcpEnv.DB;
  kv = mcpEnv.KV_CONFIG;
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

// Every path this helper is given is one the Worker genuinely does not route,
// so the 404 that comes back is the one `createMcpHandler` builds itself rather
// than anything this repository constructs -- the baseline a refused `/grant`
// has to be INDISTINGUISHABLE FROM. Comparing against a hand-copied literal
// would pass even if the two had already drifted apart, which is exactly how
// the defect this suite guards against shipped in the first place
// (grant-context.ts's own doc). Routing on this Worker is a list of exact
// `===` matches with no prefix branch among them, which is what makes a path
// adjacent to a real one (`/grantx`) as genuinely dead as an unrelated one.
function unrouted(method: string, path: string): Promise<Response> {
  return fetch(`${origin}${path}`, { method });
}

// The whole observable response, so that nothing has to be named to be
// compared. Sorted, because header order is not part of what a prober can
// read and two responses that differ only in it are the same response.
//
// `Object.fromEntries` keeps the last of any repeated name, which for
// `set-cookie` -- the one header the iterator yields more than once rather than
// folding into a comma list -- means several cookies collapse to one. Nothing
// on either side of this comparison sets a cookie, and the enumeration this
// replaced did not look at `set-cookie` either, so it is not a gap this change
// opens. It is written down because `allowedOriginHostnames: '*'` on this
// Worker is safe only while nothing here is ambient (tests/tier-invisibility.test.ts):
// the day a refusal sets a cookie, add `response.headers.getSetCookie()` to
// this snapshot and to the one in tests/fit-pages.test.ts, which has the same
// shape and therefore the same blind spot.
async function observable(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries([...response.headers.entries()].sort()),
  };
}

// Two unrouted paths, which have to agree with each other before either is
// worth comparing a refusal against. This pins that the baseline is not derived
// from the request, because a 404 carrying the path it was asked for could
// never be matched by a refusal on `/grant`, and no work on the refusal side
// would fix it.
//
// HONEST ABOUT WHAT IT GUARDS HERE, which is not what the same check guards on
// the site. `tests/fit-pages.test.ts` uses two controls against a measured
// near-miss: Astro's stock 404 embeds the requested path, so under it no `/fit`
// refusal could ever have matched. This Worker's 404 body is the constant
// `Not Found` that `agents`' `serve` builds, with no path in it and nothing in
// this repository constructing it, so here the same check guards a hypothetical
// rather than a near-miss. Kept anyway, at two fetches: the property is cheap
// to state and the failure it produces is unmistakable.
//
// Its own test rather than a line inside `expectSameRefusal`, so that a
// disagreement between two controls fails under a name that describes it. Run
// from inside the refusal helper it would fail under "a bearerless POST /grant
// matches a genuinely unrouted path", which points at the refusal when the
// refusal is not what came apart.
test('two unrouted paths on this Worker answer identically', async () => {
  for (const method of ['POST', 'GET']) {
    expect(
      await observable(await unrouted(method, '/nope/nope')),
      `the control must not depend on the path (${method})`,
    ).toEqual(await observable(await unrouted(method, '/grantx')));
  }
});

// EVERY observable field, not a named few (`01 §5`). The rule this suite tests
// is that a refusal is compared against a live unrouted path on the same
// Worker, on every observable field, never against a fixed literal. The version
// this replaced named eight: status, body text, and six headers -- the five
// `access-control-*` ones `withCors` sets plus `content-type` -- each written
// down by hand, on the claim that those are the whole shape of an `agents` 404.
//
// That claim was true of what the Worker sets, and an enumeration is still the
// wrong shape of assertion, for the same reason a hand-copied literal is: A
// LIST CANNOT NOTICE A FIELD THAT APPEARS LATER. One header added to `serve`'s
// 404 by the next bump to `agents`, or added on the `/grant` side by a change
// here, moves the two responses apart where no assertion is looking -- a
// hand-maintained copy of the response's shape, one level up from the
// hand-maintained copy of the response that grant-context.ts's own doc records.
//
// Measured 2026-09-16, which is what the enumeration was already missing: both
// sides carry EIGHT headers, not the six it named. Those six plus
// `content-encoding: gzip` and `transfer-encoding: chunked`. Both are almost
// certainly artifacts of the harness's loopback transport rather than anything
// the Worker or `withCors` sets, and neither was verified against a deployed
// edge response. They are compared anyway, because they appear identically on
// both sides: including them costs nothing, and comparing what was not chosen
// is the point.
//
// Confirmed against the drift it exists to catch rather than assumed. With one
// extra header set on a refused `/grant` and not on `/grantx` -- nine headers
// against eight -- the enumerated version passed all three refusal cases, and
// the suite went green, while `curl -i` on the pair told a prober the route was
// real. This version fails all three and names the header in the diff.
//
// Compared as one object rather than field by field, and NOT by handing two
// Response objects to `toEqual`: that compares internal slots, so it can pass
// or fail for reasons that have nothing to do with what a prober can read.
// Snapshotting first is what keeps the property the field-by-field version was
// written for, because the diff on a plain object is what names the part that
// came apart.
//
// IF THIS EVER FLAKES, the fix is not a denylist of headers to skip -- that
// reinstates the hand-maintained list this change exists to delete. Nothing in
// the measured set can differ between two fetches, but a `date` or a request id
// added to the loopback response by a future workerd would let two fetches a
// millisecond apart straddle a second boundary. Delete that one key from BOTH
// snapshots inside `observable()`, with the date and the reason it is not a
// difference a prober could read. For the same reason this helper would not
// survive being pointed at a deployed edge, where `date`, `cf-ray` and `server`
// all appear: the control has to come from the same Worker in the same harness.
//
// `tests/fit-pages.test.ts` does this for `/fit`, and reached it in a fix round
// after its own enumerated version let the original defect through: a
// difference the test does not name is a difference the test cannot see.
async function expectSameRefusal(response: Response, method: string): Promise<void> {
  const control = await observable(await unrouted(method, '/grantx'));
  // Guards the one way `/grantx` stops being a valid control: a prefix branch
  // on `/grant` added to workers/mcp/src/index.ts, which would route it.
  expect(control.status, 'the control must be a genuine 404').toBe(404);
  expect(await observable(response)).toEqual(control);
}

test('a bearerless POST /grant matches a genuinely unrouted path', async () => {
  // Same refusal as every other gated surface, and now BY CONSTRUCTION rather
  // than by a literal this test could pass against even after it drifted: a
  // response that differed observably from an unrouted path would confirm
  // the endpoint exists to anyone who probes for it. This assertion fails
  // against the old `new Response(null, { status: 404 })` code, which sends
  // no `content-type` and no `access-control-*` headers at all where the
  // genuine 404 sends five.
  const response = await post(null);
  await expectSameRefusal(response, 'POST');
});

test('a garbage bearer is the same as an unrouted path', async () => {
  const response = await post('rlme1.not-a-real-token.nope');
  await expectSameRefusal(response, 'POST');
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
    heroLine: string;
  };
  expect(body.tools).toContain('analyze_fit');
  expect(body.tools).toContain('get_availability');
  expect(body.tools).not.toContain('judge_answer');
  expect(body.audience).toBe('fixture-one');
  expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  expect(body.preload).toBe('');
  // No campaign matches this audience, same as `preload` above.
  expect(body.heroLine).toBe('');
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

test('a granted token gets the campaign hero line when the campaign is active', async () => {
  await kv.put(
    'campaign:fixture-hero-active',
    JSON.stringify({
      id: 'fixture-hero-active',
      company: 'Alpha',
      status: 'active',
      jd_text: 'ACTIVE-TARGET-TEXT',
      referrer_domains: [],
      hero_line: 'A generic line.',
      token_audience: 'fixture-hero-active',
      gated_narrative_doc: 'narratives/hero-active.md',
    }),
  );

  const response = await post(await grant('fixture-hero-active'));
  const body = (await response.json()) as { heroLine: string };
  expect(body.heroLine).toBe('A generic line.');
});

test('a retired campaign carries no hero line, but keeps its preload', async () => {
  // The gate lives in `handleGrantContext`, not in `readCampaignForAudience`
  // (grant-context.ts's own docblock on `heroLine`): that function reads
  // `status` nowhere on purpose, because it also resolves `preload` and the
  // gated narrative document, and a filter inside it would take both of
  // those out along with the hero line. This asserts both halves of that:
  // `heroLine` gated, `preload` not.
  await kv.put(
    'campaign:fixture-hero-retired',
    JSON.stringify({
      id: 'fixture-hero-retired',
      company: 'Alpha',
      status: 'retired',
      jd_text: 'RETIRED-TARGET-TEXT',
      referrer_domains: [],
      hero_line: 'A retired line that must never render.',
      token_audience: 'fixture-hero-retired',
      gated_narrative_doc: 'narratives/hero-retired.md',
    }),
  );

  const response = await post(await grant('fixture-hero-retired'));
  const body = (await response.json()) as { heroLine: string; preload: string };
  expect(body.heroLine).toBe('');
  expect(body.preload).toBe('RETIRED-TARGET-TEXT');
});

test('a GET matches a genuinely unrouted path, like any other method this Worker refuses', async () => {
  const response = await fetch(`${origin}/grant`);
  await expectSameRefusal(response, 'GET');
});

test('a failing campaign read answers the grant with no preload, not the refusal', async () => {
  // Called directly rather than over `fetch`, because the harness has no lever
  // that makes the Worker's own `KV_CONFIG.list` reject: the namespace a suite
  // holds is a separate handle from the object the Worker calls, the same wall
  // `src/pages/fit/r/[id].astro` records for its own guard. Here there IS a
  // function to import, so only the env is forged, and only its KV. `list` is
  // what fails because it is the call `walkCampaigns` leaves outside its `try`.
  const failingKv = {
    list: () => Promise.reject(new Error('KV list unavailable')),
    get: () => Promise.reject(new Error('KV get unavailable')),
  } as unknown as KVNamespace;
  const env = { ...mcpEnv, KV_CONFIG: failingKv } as McpEnv;
  const token = await grant('fixture-kv-down');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const response = await handleGrantContext(
      new Request('https://mcp.test/grant', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );
    // Not `null`: `null` is the refusal, which the site renders as the 404 a
    // dead token gets, and this token is live.
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as GrantContext;
    expect(body.audience).toBe('fixture-kv-down');
    expect(body.tools).toContain('analyze_fit');
    expect(body.preload).toBe('');
    expect(body.heroLine).toBe('');
    // The cause is interpolated into the message, because a Worker log shows
    // only the stack of an error passed as a second argument.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('KV list unavailable'));
  } finally {
    warn.mockRestore();
  }
});
