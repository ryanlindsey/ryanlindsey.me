import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createTestHarness } from 'wrangler';
import { MCP_HARNESS_WORKERS, MCP_WORKER } from './workers';
import { mintToken, newJti, type Scope } from '../src/lib/tier/token';
import { recordIssue } from '../src/lib/tier/registry';
import { TEST_SIGNING_KEY } from '../src/lib/tier/grant';

// `POST /fit/start` (#269): the endpoint that lets `/fit/run` answer in
// milliseconds. It opens a `fit_reports` row, hands back the permalink id and
// finishes the engine call in `ctx.waitUntil`, so the eighty seconds
// `analyze_fit` takes stop being time a browser spends waiting.
//
// THE SEAM THIS SUITE RUNS ON IS NOT THE SHARED ONE. tests/workers.ts sets
// `FIT_ENGINE: 'off'`, under which the deferred run refuses at the seam before
// the breaker, the corpus or the model -- so fast that `completeRun`'s UPDATE
// lands before this suite's next round trip can SELECT, and `pending`, the one
// state this endpoint exists to produce, is never visible. MEASURED
// 2026-09-21: every read of a freshly opened row came back `failed`.
//
// So both harnesses below override it. The first refuses after half a second
// (`'off-after-delay'`, added for this issue and argued for beside
// `FIT_ENGINE_MODES` in src/lib/fit/engine.ts), which makes the TRANSITION
// `pending -> failed` a behavioural assertion rather than a race. The second
// carries a value the seam does not accept, which is how a plain `Error`
// reaches `completeRun` and the `errored` half of the closed failure map gets
// exercised. Neither spends a neuron, opens a subrequest or touches a binding.

const server = createTestHarness({
  workers: MCP_HARNESS_WORKERS.map((worker) =>
    worker === MCP_WORKER
      ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, FIT_ENGINE: 'off-after-delay' } }
      : worker,
  ),
});

/**
 * A second Worker whose `FIT_ENGINE` is deliberately not a value the seam
 * accepts, so `analyzeFit` throws a plain `Error` rather than a
 * `FitUnavailable`.
 *
 * That is the ONLY way to reach the `errored` branch from here, and it is the
 * seam's own documented behaviour rather than a contrivance: a mis-set var is
 * an operator's mistake, `analyzeFit` throws a plain `Error` for it
 * specifically so the mistake is loud, and `completeRun` files exactly that
 * class of failure as `errored`. The pairing is the real one a deploy would
 * produce.
 *
 * A second harness rather than a second var on the first, because
 * `FIT_ENGINE` is read off the environment and one Worker has one value of it.
 * tests/evals-schedule.test.ts boots a second harness with a poisoned
 * `CORPUS_REFRESH` for the same reason.
 */
const misconfigured = createTestHarness({
  workers: MCP_HARNESS_WORKERS.map((worker) =>
    worker === MCP_WORKER
      ? { ...MCP_WORKER, vars: { ...MCP_WORKER.vars, FIT_ENGINE: 'not-a-value-it-accepts' } }
      : worker,
  ),
});

let db: D1Database;
let misconfiguredDb: D1Database;
let origin = '';
let misconfiguredOrigin = '';

const AUDIENCE = 'fixture-audience';

beforeAll(async () => {
  origin = (await server.listen()).url.origin;
  const mcp = server.getWorker<{ DB: D1Database }>('ryanlindsey-me-mcp');
  await mcp.applyD1Migrations('DB');
  db = (await mcp.getEnv()).DB;

  // Listened here rather than inside the one test that uses it: a harness
  // started in a test body is a harness whose lifetime is not the file's.
  misconfiguredOrigin = (await misconfigured.listen()).url.origin;
  const poisoned = misconfigured.getWorker<{ DB: D1Database }>('ryanlindsey-me-mcp');
  await poisoned.applyD1Migrations('DB');
  misconfiguredDb = (await poisoned.getEnv()).DB;
});
afterAll(async () => {
  await server.close();
  await misconfigured.close();
});

/**
 * A live grant, registered so `resolveGrant` honours it.
 *
 * A FRESH `jti` EVERY TIME, and both things it buys are used below. The
 * limiter keys a granted caller's bucket `analyze_fit:g:<jti>`
 * (`limitKeyFor`, src/lib/mcp/limits.ts), so one token's exhausted allowance
 * says nothing about the next token's; and `mcp_tool_calls.grant_jti` is what
 * lets a test find its OWN audit row rather than the newest one some other
 * test wrote.
 */
async function grant(
  into: D1Database,
  audience = AUDIENCE,
  scopes: Scope[] = ['fit'],
): Promise<{ token: string; jti: string }> {
  const now = Math.floor(Date.now() / 1000);
  const claims = { v: 1 as const, jti: newJti(), aud: audience, scopes, iat: now, exp: now + 3600 };
  await recordIssue(into, {
    jti: claims.jti,
    audience,
    scopes,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    revokedAt: null,
    note: 'fit start suite',
  });
  return { token: await mintToken(TEST_SIGNING_KEY, claims), jti: claims.jti };
}

const A_DESCRIPTION = JSON.stringify({ target_description: 'A role.' });

function send(
  at: string,
  path: string,
  init: { method?: string; token?: string; body?: string } = {},
): Promise<Response> {
  const method = init.method ?? 'POST';
  return fetch(`${at}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
    },
    body: method === 'GET' ? undefined : (init.body ?? A_DESCRIPTION),
  });
}

/**
 * The same shape tests/mcp-grant-context.test.ts compares refusals against,
 * and it is here for the same reason rather than by imitation: the whole
 * observable response, so that nothing has to be NAMED to be compared. A list
 * of fields cannot notice a field that appears later, and a header set on a
 * refused `/fit/start` and on nothing else is exactly the route-existence
 * oracle this endpoint must not be.
 *
 * Headers are sorted because order is not something a prober can read.
 * `set-cookie` is the one header the iterator yields more than once and would
 * collapse here; nothing on either side of this comparison sets one, and the
 * day something does, add `getSetCookie()` here and in the two suites carrying
 * this same helper.
 */
async function observable(response: Response) {
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries([...response.headers.entries()].sort()),
  };
}

/**
 * The control: a path this Worker genuinely does not route, so the 404 that
 * comes back is the one `createMcpHandler` builds rather than anything this
 * repository constructs. Routing here is a list of exact `===` matches with no
 * prefix branch among them, which is what makes `/fit/startx` as dead as an
 * unrelated path while sitting one character from a real one.
 *
 * The control is fetched with the SAME METHOD as the refusal it stands
 * against, because a 404 is allowed to differ by method and a comparison
 * across two methods would be measuring that instead.
 */
async function expectSameRefusal(response: Response, method: string): Promise<void> {
  const control = await observable(await send(origin, '/fit/startx', { method }));
  expect(control.status, 'the control must be a genuine 404').toBe(404);
  expect(await observable(response)).toEqual(control);
}

test('opens the row as pending, answers with its id, and closes it behind the response', async () => {
  const { token } = await grant(db);
  const response = await send(origin, '/fit/start', { token });

  expect(response.status).toBe(200);
  const { id } = (await response.json()) as { id: string };
  expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);

  // THE OPENING STATE, which is the whole point of the endpoint: the caller
  // has its permalink before the run it names has finished.
  const opened = await db
    .prepare('SELECT * FROM fit_reports WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  expect(opened?.status).toBe('pending');
  expect(opened?.failure_code).toBeNull();
  expect(opened?.audience).toBe(AUDIENCE);
  expect(opened?.target_description).toBe('A role.');
  expect(opened?.model, 'a pending row knows nothing about a report').toBeNull();
  expect(opened?.report_json).toBeNull();

  // THE TOKEN IS REQUEST SCOPED, and this is the structural half of saying so.
  // The row is the only thing this endpoint writes that outlives the request,
  // so a token in any column of it would be the leak the epic's constraint
  // forbids. Asserted over the WHOLE row rather than the columns a reader
  // expects, so a column added later is covered without this line moving.
  expect(JSON.stringify(opened)).not.toContain(token);

  // THE TRANSITION, not either instant. `'off-after-delay'` is what makes both
  // halves visible from one test: the row is `pending` above because the
  // engine has not answered yet, and `failed` here because it has.
  await vi.waitFor(
    async () => {
      const closed = await db
        .prepare('SELECT status, failure_code FROM fit_reports WHERE id = ?')
        .bind(id)
        .first<{ status: string; failure_code: string | null }>();
      expect(closed?.status).toBe('failed');
      expect(closed?.failure_code).toBe('refused');
    },
    { timeout: 5000, interval: 25 },
  );
});

/**
 * EVERY REFUSAL THIS ROUTE CAN ANSWER, through one comparison.
 *
 * The epic's constraint is that a refusal on this surface is the genuine
 * unrouted 404 rather than a copy of it, and the way that constraint gets
 * broken is not by rewriting the ones a test already watches -- it is by
 * adding a helpful `400` to one nobody checked. So the list is the exits
 * themselves: a method the route does not answer, no bearer, a bearer with no
 * `fit` scope, a body that is not JSON, a description that is empty once
 * trimmed, and an allowance already spent.
 *
 * The rate-limited one is the one most easily argued away, and it is the one
 * that matters most: a 429 is honest to a caller and tells anyone holding a
 * link that the route is real.
 */
const REFUSALS: { name: string; method: string; send: () => Promise<Response> }[] = [
  {
    name: 'a method this route does not answer',
    method: 'GET',
    send: async () => send(origin, '/fit/start', { method: 'GET', token: (await grant(db)).token }),
  },
  {
    name: 'a request carrying no grant',
    method: 'POST',
    send: () => send(origin, '/fit/start'),
  },
  {
    name: 'a grant that does not carry the fit scope',
    method: 'POST',
    send: async () =>
      send(origin, '/fit/start', { token: (await grant(db, AUDIENCE, ['profile'])).token }),
  },
  {
    name: 'a body that is not JSON',
    method: 'POST',
    send: async () => send(origin, '/fit/start', { token: (await grant(db)).token, body: '{' }),
  },
  {
    name: 'a description that is empty once trimmed',
    method: 'POST',
    send: async () =>
      send(origin, '/fit/start', {
        token: (await grant(db)).token,
        body: JSON.stringify({ target_description: '   ' }),
      }),
  },
  {
    name: 'an allowance already spent',
    method: 'POST',
    send: async () => {
      // `analyze_fit` is `expensive`, six per five minutes
      // (src/lib/mcp/limits.ts), so the seventh call on one token is refused.
      // Seven round trips and no inference: the six that succeed defer a run
      // the seam refuses.
      const { token } = await grant(db, 'fixture-limiter');
      for (let call = 0; call < 6; call += 1) {
        const allowed = await send(origin, '/fit/start', { token });
        expect(allowed.status, `call ${call + 1} of six should be inside the allowance`).toBe(200);
      }
      return send(origin, '/fit/start', { token });
    },
  },
];

for (const refusal of REFUSALS) {
  test(`refuses ${refusal.name} the same way an unrouted path does`, async () => {
    await expectSameRefusal(await refusal.send(), refusal.method);
  });
}

test('a refused run leaves no row behind', async () => {
  // The reason the INSERT sits INSIDE `limitAndAudit`'s guarded body rather
  // than in front of it: the limiter is asked first, so a refused run opens no
  // permalink that nothing will ever finish. The case above asserts what the
  // refusal LOOKS like; this one asserts what it did not do.
  //
  // It spends its own allowance rather than counting the rows the case above
  // left, so that running either test alone still means something.
  const { token } = await grant(db, 'fixture-no-row');
  for (let call = 0; call < 6; call += 1) {
    expect((await send(origin, '/fit/start', { token })).status).toBe(200);
  }
  expect((await send(origin, '/fit/start', { token })).status).toBe(404);

  const rows = await db
    .prepare('SELECT COUNT(*) AS n FROM fit_reports WHERE audience = ?')
    .bind('fixture-no-row')
    .first<{ n: number }>();
  expect(rows?.n, 'the seventh call was refused, so there are six rows').toBe(6);
});

test('records the run in the audit trail under the tool the limiter metered', async () => {
  const { token, jti } = await grant(db);
  const response = await send(origin, '/fit/start', { token });
  expect(response.status).toBe(200);

  // Found by `grant_jti` rather than by recency: this suite writes an audit
  // row for every call it makes, and "the newest one" is whichever test ran
  // last. Waited for because `limitAndAudit` writes the row under
  // `ctx.waitUntil` -- scheduled before the response is returned, finished
  // whenever the runtime gets to it.
  const audit = await vi.waitFor(
    async () => {
      const row = await db
        .prepare('SELECT tool, tier, audience, outcome FROM mcp_tool_calls WHERE grant_jti = ?')
        .bind(jti)
        .first<{ tool: string; tier: string; audience: string; outcome: string }>();
      expect(row).not.toBeNull();
      return row;
    },
    { timeout: 5000, interval: 25 },
  );

  // The route is metered and recorded under the TOOL's name, because it is the
  // same spend: a second name here would be a second allowance for one engine.
  expect(audit?.tool).toBe('analyze_fit');
  expect(audit?.tier).toBe('private');
  expect(audit?.audience).toBe(AUDIENCE);
  expect(audit?.outcome).toBe('ok');
});

test('a failure nobody wrote a sentence about closes the row as errored', async () => {
  // The other half of the closed map issue #276 renders. `refused` is the
  // engine declining for a reason it wrote a sentence about; `errored` is a
  // defect, and here the defect is the real one this seam's plain `Error`
  // exists to make loud -- a `FIT_ENGINE` nobody set correctly.
  const { token } = await grant(misconfiguredDb);
  const response = await send(misconfiguredOrigin, '/fit/start', { token });
  expect(response.status, 'a misconfigured engine must not change the answer').toBe(200);
  const { id } = (await response.json()) as { id: string };

  await vi.waitFor(
    async () => {
      const row = await misconfiguredDb
        .prepare('SELECT status, failure_code FROM fit_reports WHERE id = ?')
        .bind(id)
        .first<{ status: string; failure_code: string | null }>();
      expect(row?.status).toBe('failed');
      expect(row?.failure_code).toBe('errored');
    },
    { timeout: 5000, interval: 25 },
  );
});
