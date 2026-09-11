import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  readAnalytics,
  readSpend,
  type AgentTraffic,
  type AnalyticsEnv,
} from '../src/lib/ops/analytics';

/**
 * The credentialed half of /ops, with no credential and no network.
 *
 * WHAT THIS SUITE NOW PROVES, and it is more than it used to: both APIs were
 * answered by the real service on 2026-09-11, and `MEASURED_TOTALS`,
 * `MEASURED_ROUTES`, `MEASURED_EMPTY` and `MEASURED_SPEND` below are
 * transcriptions of four of those five responses. A green run therefore says
 * the module parses what the API actually sent rather than what this build
 * hoped it would.
 *
 * THOSE FOUR FIXTURES ARE ALSO AN ARCHIVE. The probe's raw output lives in the
 * plan's working notes under `.superpowers/`, which .gitignore excludes, so
 * these literals and the comments in src/lib/ops/analytics.ts are the only
 * copies that ship. Edit them to suit a parser and the record is gone. (The
 * fifth, `gw:rest`, is a 403 with no parse behind it; it is transcribed at
 * `readSpend` because its value is the ruling, not the body.)
 *
 * The rest of the fixtures are constructed -- there is no recorded body for a
 * GraphQL error, an empty gateway window or a malformed envelope, and inventing
 * one to assert against would prove nothing the fixture did not already assume.
 *
 * WHAT IT STILL CANNOT PROVE, beyond that the envelope has not changed since:
 * anything about the REQUESTS. The recording holds five responses and nothing
 * that was sent, so the query text, the `limit`, the selection set and the
 * datetime spelling are recollection rather than record -- these tests hold
 * them still, which is a different and smaller thing than confirming them.
 * Nothing here calls api.cloudflare.com, deliberately: CI holds no credential,
 * and a suite that needed one would either be skipped or be a liability.
 *
 * That is why the failure assertions still outnumber the success ones. The
 * property this page depends on is that an unrecognised response yields `null`
 * rather than a zero, and that property has to hold when the shape moves.
 *
 * `fetch` IS INJECTED, as `readAnalytics`'s fourth parameter, the same way
 * `verifyTurnstile` (src/lib/turnstile.ts) takes its `fetchImpl` -- so the
 * request-shaping assertions read the real call rather than a mock of it, and
 * no test depends on ambient global state. The global IS still replaced in
 * `beforeEach`, with a stub that throws: it is the backstop that turns "this
 * code path forgot to use the injected fetch" from a silent real request into a
 * failure, and it is what makes `expect(...).not.toHaveBeenCalled()` a positive
 * proof rather than an absence of evidence.
 */

const NOW = new Date('2026-09-09T12:00:00.000Z');

const env = (over: Partial<AnalyticsEnv> = {}): AnalyticsEnv => ({
  RLME_ANALYTICS_TOKEN: { get: async () => 'a-fixture-token' } as SecretsStoreSecret,
  RLME_ACCOUNT_ID: 'an-account',
  RLME_AI_GATEWAY_ID: 'a-gateway',
  ...over,
});

/**
 * The stub's own signature, declared so `mock.calls` is a TYPED tuple.
 *
 * `vi.fn(async () => …)` infers a zero-parameter procedure, which makes
 * `mock.calls[0]` the empty tuple and every `calls[0][1]` below a ts(2493) --
 * and `npm test` would never say so, because vitest does not typecheck. The
 * same note is on `AiRun` in tests/chat-engine.test.ts, for the same reason.
 */
type FetchImpl = typeof fetch;

/** One stubbed `fetch` returning the same body to all three queries. */
const answering = (body: unknown, status = 200) =>
  vi.fn<FetchImpl>(async () => new Response(JSON.stringify(body), { status }));

/** Three different bodies, one per query, in the order `Promise.all` issues them. */
const inOrder = (bodies: unknown[]) => {
  let call = -1;
  return vi.fn<FetchImpl>(async () => {
    call += 1;
    return new Response(JSON.stringify(bodies[call]));
  });
};

/**
 * One row carrying every column all three queries read.
 *
 * `answering` gives the same body to all three, and the three want different
 * shapes -- so a test about something OTHER than the parse (the blob guard, the
 * secret-read count) needs a body that satisfies all of them at once to get a
 * non-null result. `{ data: [] }` used to serve that purpose and no longer can:
 * an empty `totals` is now a `null` by design (see "an empty totals array" in
 * `failing closed` below), which is the correct answer and a useless fixture.
 */
const EVERY_SHAPE = {
  data: [{ requests: 1, agent_requests: 1, p50: 1, agent: 'ClaudeBot', route_class: 'content' }],
};

/** A totals row with a real aggregate in it, for tests about the other two queries. */
const TOTALS_ROW = { data: [{ requests: '120', agent_requests: '30', p50: '41.5' }] };

/**
 * THE RECORDED ANALYTICS ENGINE RESPONSE, copied field for field from the
 * 2026-09-11 probe (`ae:totals+sumIf+quantile`) rather than written to suit the
 * parser.
 *
 * `meta`, `rows` and `rows_before_limit_at_least` are kept even though nothing
 * reads them: the fixture's job is to be the response, so that a parser which
 * one day starts depending on a sibling key is exercised against the real
 * neighbourhood rather than against a two-key object.
 *
 * THE TYPES ARE THE POINT. `requests` and `agent_requests` are `UInt64` and
 * arrive as JSON STRINGS; `p50` is `Float64` and arrives as a NUMBER, and as
 * the number 0. One row, one query, both spellings -- which is the asymmetry
 * `finiteNumber` exists for and the one a "simplification" would break.
 */
const MEASURED_TOTALS = {
  meta: [
    { name: 'requests', type: 'UInt64' },
    { name: 'agent_requests', type: 'UInt64' },
    { name: 'p50', type: 'Float64' },
  ],
  data: [{ requests: '1041', agent_requests: '314', p50: 0 }],
  rows: 1,
  rows_before_limit_at_least: 305,
};

/**
 * THE RECORDED BY-ROUTE-CLASS RESPONSE (`ae:groupBy`), the third transcription.
 *
 * It is the only measured evidence about a GROUPED row, and `breakdownRows`
 * makes two demands of one -- a non-empty string label and a `finiteNumber`
 * count. Here they are met by `String` and `UInt64`-as-string, from the real
 * dataset, with the label vocabulary (`RouteClass`) that
 * src/lib/agent-intel/classify.ts closes. Without this fixture the breakdown
 * parse was exercised only against rows written to suit it.
 */
const MEASURED_ROUTES = {
  meta: [
    { name: 'route_class', type: 'String' },
    { name: 'requests', type: 'UInt64' },
  ],
  data: [
    { route_class: 'other', requests: '983' },
    { route_class: 'agent-signal', requests: '46' },
    { route_class: 'content', requests: '12' },
  ],
  rows: 3,
  rows_before_limit_at_least: 305,
};

/** The recorded empty grouped response (`ae:empty`): a real empty array, `rows: 0`. */
const MEASURED_EMPTY = {
  meta: [
    { name: 'agent', type: 'String' },
    { name: 'requests', type: 'UInt64' },
  ],
  data: [],
  rows: 0,
  rows_before_limit_at_least: 0,
};

/**
 * THE RECORDED AI GATEWAY RESPONSE (`gw:graphql`), copied verbatim including
 * the three fields `readSpend` deliberately no longer asks for.
 *
 * They stay in the fixture precisely BECAUSE the query drops them: a response
 * carrying more than the parse reads is the real condition, and a fixture
 * trimmed to the selection set would quietly stop testing that. What must not
 * happen is either of them reaching `GatewaySpend`, which the equality
 * assertion below is what catches.
 */
const MEASURED_SPEND = {
  data: {
    viewer: {
      accounts: [
        {
          aiGatewayRequestsAdaptiveGroups: [
            {
              count: 656,
              sum: {
                cachedRequests: 0,
                cost: 5.202603642412313,
                erroredRequests: 162,
                tokensIn: 1877268,
                tokensOut: 98659,
              },
            },
          ],
        },
      ],
    },
  },
  errors: null,
};

/** A gateway response with one group carrying exactly the fields the query asks for. */
const spendBody = (group: unknown, errors: unknown = null) => ({
  data: { viewer: { accounts: [{ aiGatewayRequestsAdaptiveGroups: [group] }] } },
  errors,
});

/** A `fetch` that must never be reached; passed where the answer is "no request". */
const never = () =>
  vi.fn<FetchImpl>(async () => {
    throw new Error('this test must not make a request');
  });

/** The body of one recorded call, as the string that reached the wire. */
const bodyOf = (call: Parameters<FetchImpl>) => String((call[1] as RequestInit).body);

beforeEach(() => {
  // The ambient backstop. Every test passes its own `fetchImpl`; if any code
  // path ignores it, this throws instead of reaching api.cloudflare.com.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('this suite must not use the global fetch');
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('the seam', () => {
  test("'stub' returns null without reading the secret or fetching", async () => {
    const read = vi.fn(async () => 'a-fixture-token');
    const wire = never();
    const result = await readAnalytics(
      env({
        RLME_ANALYTICS_MODE: 'stub',
        RLME_ANALYTICS_TOKEN: { get: read } as unknown as SecretsStoreSecret,
      }),
      NOW,
      30,
      wire,
    );
    expect(result).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(wire).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an unrecognised mode throws a plain Error rather than degrading quietly', async () => {
    // The same shape as every other seam in this repo: a value nobody meant to
    // set must be loud, because the alternative is a page that silently says
    // "not configured" forever.
    const wire = never();
    await expect(
      readAnalytics(env({ RLME_ANALYTICS_MODE: 'maybe' }), NOW, 30, wire),
    ).rejects.toThrow(/unrecognised RLME_ANALYTICS_MODE/);
    expect(wire).not.toHaveBeenCalled();
  });
});

describe('failing closed', () => {
  test('an unreadable secret is a null, not a zero and not a throw', async () => {
    // The expected state until the owner's Secrets Store entry is populated,
    // and the state every harness test in this repo runs in: miniflare's
    // `secrets_store_secrets` simulation makes `.get()` throw exactly this.
    const wire = never();
    const result = await readAnalytics(
      env({
        RLME_ANALYTICS_TOKEN: {
          get: async () => {
            throw new Error('Secret "RLME_ANALYTICS_TOKEN" not found');
          },
        } as SecretsStoreSecret,
      }),
      NOW,
      30,
      wire,
    );
    expect(result).toBeNull();
    expect(wire).not.toHaveBeenCalled();
  });

  test('an empty secret is a null, and is not sent as a bearer token', async () => {
    const wire = never();
    const result = await readAnalytics(
      env({ RLME_ANALYTICS_TOKEN: { get: async () => '' } as SecretsStoreSecret }),
      NOW,
      30,
      wire,
    );
    expect(result).toBeNull();
    expect(wire).not.toHaveBeenCalled();
  });

  test('a secret that is not a string never reaches the wire as "Bearer undefined"', async () => {
    // The binding's type says `Promise<string>`, so this looks impossible and is
    // not: a rotated or mis-bound secret is a real state, and without the
    // `typeof` check the module would spend a round trip to be told 401 while
    // putting the literal text `Bearer undefined` in an edge log.
    const wire = never();
    const result = await readAnalytics(
      env({
        RLME_ANALYTICS_TOKEN: {
          get: async () => undefined,
        } as unknown as SecretsStoreSecret,
      }),
      NOW,
      30,
      wire,
    );
    expect(result).toBeNull();
    expect(wire).not.toHaveBeenCalled();
  });

  test('THE SECRET IS READ ONCE PER CALL, not once per query', async () => {
    // Three queries used to mean three Secrets Store reads for one page render
    // -- three independent chances to fail, and a state where two queries could
    // carry a token the third could not get.
    const read = vi.fn(async () => 'a-fixture-token');
    const wire = answering({ data: [] });
    await readAnalytics(
      env({ RLME_ANALYTICS_TOKEN: { get: read } as unknown as SecretsStoreSecret }),
      NOW,
      30,
      wire,
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(wire).toHaveBeenCalledTimes(3);
  });

  test('a non-200 is a null, with a body the parse would otherwise have read', async () => {
    // `answering({ data: [] }, 403)` is what this used to send, and it was
    // green whether or not `query` checked the status: an empty `totals` is a
    // `null` by itself. `EVERY_SHAPE` satisfies all three queries at once, so
    // the status check is the only thing between a 403 and three published
    // figures -- the same correction as the gateway half's own non-200 test.
    const wire = answering(EVERY_SHAPE, 403);
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });

  test('a network failure is a null', async () => {
    const wire = vi.fn<FetchImpl>(async () => {
      throw new TypeError('network');
    });
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });

  test('a body that is not JSON is a null', async () => {
    const wire = vi.fn<FetchImpl>(async () => new Response('<html>an error page</html>'));
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });

  test('AN ENVELOPE THIS BUILD DOES NOT RECOGNISE IS A NULL', async () => {
    // The assertion the whole module is built around. `data` is now measured to
    // be the right key (2026-09-11), so this is no longer insurance against a
    // guess -- it is what keeps a CHANGE to that envelope off the page as an
    // absence. `result` is the plausible alternative spelling, and the day the
    // API starts using it /ops says "not configured" rather than "0 requests".
    const wire = answering({ result: [{ requests: 5 }], success: true });
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });

  test('one failing query out of three fails the whole read', async () => {
    // Partial truth is the one outcome worse than silence here: a page showing
    // a request total with an empty agent breakdown reads as "no agents came",
    // which is a different claim from "this could not be read".
    let call = 0;
    const wire = vi.fn<FetchImpl>(async () => {
      call += 1;
      return call === 2
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ data: [] }));
    });
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });

  test('AN EMPTY totals ARRAY IS A NULL, NOT A PUBLISHED ZERO', async () => {
    // The module's headline rule, in the one place the code used to invert it:
    // `totals[0] ?? {}` turned zero rows into `Number(undefined ?? 0)` === 0,
    // and /ops rendered a confident `0` for "Requests that reached the Worker"
    // and "Requests from agents" -- the invisible lie that whole rule exists to
    // prevent.
    //
    // WHY AN EMPTY `totals` IS DIFFERENT FROM AN EMPTY `byAgent`, which the
    // test below asserts IS a real answer: the totals query carries no
    // `GROUP BY`, so the engine returns exactly one row for any window,
    // including a window nothing happened in -- where that row holds a genuine
    // 0. Zero ROWS from an ungrouped aggregate is not "nothing happened", it is
    // "this is not the envelope this build assumed". The breakdown queries DO
    // group, so zero rows there is a measurement and is published as one.
    expect(await readAnalytics(env(), NOW, 30, answering({ data: [] }))).toBeNull();
  });

  test('A NON-NUMERIC TOTAL IS A NULL, NOT THE STRING "NaN" ON THE PAGE', async () => {
    // `Number()` alone is a null-shaped guard, not a number-shaped one: any
    // non-null, non-numeric value became `NaN`, and /ops renders
    // `NaN.toLocaleString()` as the literal text "NaN" beside a label that
    // reads as a measurement.
    const wire = inOrder([
      { data: [{ requests: 'many', agent_requests: '30', p50: '41.5' }] },
      { data: [] },
      { data: [] },
    ]);
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });

  test('a non-numeric agent_requests is a null too', async () => {
    const wire = inOrder([
      { data: [{ requests: '120', agent_requests: {}, p50: '41.5' }] },
      { data: [] },
      { data: [] },
    ]);
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });

  test('a breakdown row this build cannot read fails the whole read', async () => {
    // ALL OR NOTHING rather than skipping the bad row. A dropped line is the
    // same invisible lie as a zero: the list still renders, still adds up to
    // something, and nothing on the page says a row is missing.
    const wire = inOrder([
      TOTALS_ROW,
      { data: [{ agent: 'ClaudeBot', requests: 'lots' }] },
      { data: [] },
    ]);
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });

  test('a breakdown row with no label at all fails the whole read', async () => {
    // The `String(row.agent)` this replaced rendered the literal text
    // "undefined" as an agent name, which is a row on a public page claiming a
    // client by that name visited.
    const wire = inOrder([TOTALS_ROW, { data: [{ requests: '20' }] }, { data: [] }]);
    expect(await readAnalytics(env(), NOW, 30, wire)).toBeNull();
  });
});

describe('the query text', () => {
  test('counts with SUM(_sample_interval) rather than count(), in every query', async () => {
    // The module's own comment calls this "the single most likely way for /ops
    // to be quietly wrong": `count()` counts STORED rows and under-reports
    // exactly when traffic is high enough for the page to be interesting.
    const wire = answering({ data: [] });
    await readAnalytics(env(), NOW, 30, wire);

    const bodies = wire.mock.calls.map(bodyOf);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).toContain('SUM(_sample_interval)');
      // CASE-INSENSITIVE: SQL keywords are conventionally upper-cased, so a
      // `COUNT()` that slipped in is the likelier spelling of this defect and a
      // case-sensitive pattern would wave it straight through.
      expect(body).not.toMatch(/\bcount\(\)/i);
    }
  });

  test('the window bound reaches the wire as a toDateTime with no timezone suffix', async () => {
    const wire = answering({ data: [] });
    await readAnalytics(env(), NOW, 30, wire);

    for (const call of wire.mock.calls) {
      expect(bodyOf(call)).toContain("timestamp >= toDateTime('2026-08-10 12:00:00')");
    }
  });

  test('the account id shapes the URL and the token is sent as a bearer', async () => {
    const wire = answering({ data: [] });
    await readAnalytics(env(), NOW, 30, wire);

    const [url, init] = wire.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/an-account/analytics_engine/sql',
    );
    // By KEY, not by value: asserting the value would put a fixture credential
    // into a failure message, and the bug worth catching is a request that
    // forgot to carry one.
    expect(Object.keys(init.headers as Record<string, string>)).toContain('authorization');
    expect(init.method).toBe('POST');
  });
});

describe('a recognised envelope', () => {
  const traffic = async (): Promise<AgentTraffic | null> =>
    await readAnalytics(
      env(),
      NOW,
      30,
      inOrder([
        { data: [{ requests: '120', agent_requests: '30', p50: '41.5' }] },
        {
          data: [
            { agent: 'ClaudeBot', requests: '20' },
            { agent: 'GPTBot', requests: '10' },
          ],
        },
        { data: [{ route_class: 'writing', requests: '80' }] },
      ]),
    );

  test('the three responses become one AgentTraffic, with numbers as numbers', async () => {
    // The strings are deliberate. A SQL API answering over HTTP is entitled to
    // return numerics as strings, and a page that renders `"120"` where it
    // means 120 is the kind of defect that survives review.
    expect(await traffic()).toEqual({
      windowDays: 30,
      requests: 120,
      agentRequests: 30,
      byAgent: [
        { agent: 'ClaudeBot', requests: 20 },
        { agent: 'GPTBot', requests: 10 },
      ],
      byRouteClass: [{ routeClass: 'writing', requests: 80 }],
      p50Ms: 41.5,
    });
  });

  test('THE MEASURED ENVELOPE PARSES, UInt64 STRINGS AND Float64 NUMBERS ALIKE', async () => {
    // The one test in this file whose fixture is a RECORDING rather than a
    // construction, and the asymmetry it pins is the thing most likely to be
    // "simplified" away: in the recorded row `requests` and `agent_requests`
    // are UInt64 and arrive as the strings "1041" and "314", while `p50` is
    // Float64 and arrives as the number 0. A coercion narrowed to numbers would
    // null both counts and keep the latency; one narrowed to strings would do
    // the reverse. Either renders as "not configured" on a page whose read
    // worked perfectly, which is the failure nobody goes looking for.
    //
    // `p50Ms: 0` IS PARSED CORRECTLY AND IS NOT A LATENCY. The module's rule is
    // that a zero must never stand in for a read that failed, not that zero is
    // unsayable -- and this zero is what the engine answered. What it is NOT is
    // evidence of a fast site: `double2` is `Date.now() - started` inside a
    // Worker, whose clock advances only on I/O, so a median of exactly 0 over
    // 1041 requests is structural. The assertion here is about the parse; the
    // figure's meaning is recorded at `p50Ms` in src/lib/ops/analytics.ts and
    // on the tile itself.
    //
    // ALL THREE FIXTURES ARE RECORDINGS, which is the other half of the point:
    // the totals row, the empty grouped response (a real `data: []` with
    // `rows: 0`, so it lands as an empty list rather than the null an absent
    // key would produce) and the by-route-class rows, so `breakdownRows` is
    // exercised against measured labels and measured UInt64-string counts.
    const result = await readAnalytics(
      env(),
      NOW,
      30,
      inOrder([MEASURED_TOTALS, MEASURED_EMPTY, MEASURED_ROUTES]),
    );
    expect(result).toEqual({
      windowDays: 30,
      requests: 1041,
      agentRequests: 314,
      byAgent: [],
      byRouteClass: [
        { routeClass: 'other', requests: 983 },
        { routeClass: 'agent-signal', requests: 46 },
        { routeClass: 'content', requests: 12 },
      ],
      p50Ms: 0,
    });
  });

  test('an empty WINDOW is zeros rather than null -- silence is not failure', async () => {
    // The distinction the page depends on: `null` means "could not be read",
    // and a window nothing happened in means "nothing happened", which is a
    // real answer and is published as one.
    //
    // THE TOTALS ROW IS PRESENT AND HOLDS 0, which is what an ungrouped
    // aggregate returns for an empty window; the two GROUPED queries return no
    // rows, which is what THEY return for one. Those are different events and
    // the module now tells them apart -- an empty `totals` array is a `null`
    // (asserted in `failing closed` above), because an ungrouped aggregate
    // cannot legitimately produce zero rows.
    const wire = inOrder([
      { data: [{ requests: 0, agent_requests: 0, p50: null }] },
      { data: [] },
      { data: [] },
    ]);
    expect(await readAnalytics(env(), NOW, 30, wire)).toEqual({
      windowDays: 30,
      requests: 0,
      agentRequests: 0,
      byAgent: [],
      byRouteClass: [],
      p50Ms: null,
    });
  });

  test('a non-numeric p50 drops the latency figure rather than publishing "NaN ms"', async () => {
    // `quantileWeighted` over an empty window is exactly where
    // ClickHouse-family engines emit `nan`/`inf`. The 2026-09-11 probe measured
    // the function ANSWERING (200, with `p50` populated) but not what it does
    // with no rows under it, so this stays a constructed fixture. /ops renders
    // `${Math.round(p50Ms)} ms`, so an unguarded coercion published the literal
    // string "NaN ms".
    //
    // A `null` HERE RATHER THAN A FAILED READ, unlike the two counts: dropping
    // the latency figure and rendering its absence is the plan's pre-agreed
    // fallback for this query, because it is the least valuable number on the
    // page and the only one with no second source. The counts stay real.
    const result = await readAnalytics(
      env(),
      NOW,
      30,
      inOrder([
        { data: [{ requests: '120', agent_requests: '30', p50: 'nan' }] },
        { data: [] },
        { data: [] },
      ]),
    );
    expect(result?.p50Ms).toBeNull();
    expect(result?.requests).toBe(120);
    expect(result?.agentRequests).toBe(30);
  });

  test('an absent p50 is null rather than 0 -- the fallback the plan pre-agreed', async () => {
    // `quantileWeighted` is ClickHouse-shaped and was the dialect risk this
    // fallback was agreed against; the probe measured it working, so the
    // fallback is not in use. It stays asserted because the property it
    // protects outlives the reason: whatever makes the median unreadable, the
    // value that must never appear on the page is a 0 ms one that nobody
    // measured.
    const result = await readAnalytics(
      env(),
      NOW,
      30,
      inOrder([
        { data: [{ requests: 5, agent_requests: 1, p50: null }] },
        { data: [] },
        { data: [] },
      ]),
    );
    expect(result?.p50Ms).toBeNull();
    expect(result?.requests).toBe(5);
  });
});

describe('the AE_BLOB_FIELDS guard', () => {
  /**
   * Reordering the real constant is not something a test can do, so the module
   * is re-imported against a mocked `record.ts`. This is the only assertion
   * anywhere that the guard can actually fail -- which was the point of making
   * it a throw rather than `void AE_BLOB_FIELDS`.
   */
  const withFields = async (fields: string[], wire: ReturnType<typeof answering>) => {
    vi.resetModules();
    vi.doMock('../src/lib/agent-intel/record', () => ({ AE_BLOB_FIELDS: fields }));
    const module = await import('../src/lib/ops/analytics');
    try {
      return await module.readAnalytics(env(), NOW, 30, wire);
    } finally {
      vi.doUnmock('../src/lib/agent-intel/record');
      vi.resetModules();
    }
  };

  const REAL = ['agent_class', 'agent', 'route_class', 'referrer_class', 'surface', 'status_class'];

  test('the real order passes the guard', async () => {
    // `EVERY_SHAPE` rather than `{ data: [] }`: an empty `totals` is now a
    // deliberate `null`, so the old fixture would have made this test pass for
    // the wrong reason -- green whether the guard threw or the parse refused.
    await expect(withFields([...REAL], answering(EVERY_SHAPE))).resolves.not.toBeNull();
  });

  test('swapping the first two positions throws before any query runs', async () => {
    const wire = never();
    await expect(withFields(['agent', 'agent_class', ...REAL.slice(2)], wire)).rejects.toThrow(
      /AE_BLOB_FIELDS was reordered/,
    );
    expect(wire).not.toHaveBeenCalled();
  });

  test('moving ONLY blob3 throws too', async () => {
    // The position the first version of this guard did not check. `blob3` is
    // `route_class`, which the by-route-class query groups by -- a reorder that
    // left the first two alone would have relabelled that whole breakdown while
    // passing a two-position check.
    const wire = never();
    await expect(
      withFields(['agent_class', 'agent', 'surface', 'route_class'], wire),
    ).rejects.toThrow(/AE_BLOB_FIELDS was reordered/);
    expect(wire).not.toHaveBeenCalled();
  });

  test('the guard runs BEFORE the secret is read', async () => {
    // Ordering worth pinning: a reorder is a programming error and must be loud
    // whether or not the page is configured. If the token read came first, the
    // throw would be unreachable in every unconfigured environment -- which is
    // all of them today.
    const read = vi.fn(async () => 'a-fixture-token');
    vi.resetModules();
    vi.doMock('../src/lib/agent-intel/record', () => ({
      AE_BLOB_FIELDS: ['agent', 'agent_class', ...REAL.slice(2)],
    }));
    const module = await import('../src/lib/ops/analytics');
    try {
      await expect(
        module.readAnalytics(
          env({ RLME_ANALYTICS_TOKEN: { get: read } as unknown as SecretsStoreSecret }),
          NOW,
          30,
          never(),
        ),
      ).rejects.toThrow(/AE_BLOB_FIELDS was reordered/);
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/lib/agent-intel/record');
      vi.resetModules();
    }
  });
});

/**
 * The gateway read, against the response the 2026-09-11 probe recorded.
 *
 * THE TEST THAT USED TO LIVE HERE ASSERTED `null` UNCONDITIONALLY, pinning a
 * deliberate gap: the endpoint was unsettled and the envelope unmeasured, so
 * there was no parse to test and a blind one would have looked finished while
 * returning `null` forever. It was written to fail the moment the function
 * started working, and it did its job -- the probe ran, the GraphQL dataset
 * answered, the REST route 403'd, and what follows is the parse of what came
 * back rather than of what anyone expected.
 */
describe('readSpend', () => {
  test('THE MEASURED GATEWAY RESPONSE BECOMES A GatewaySpend', async () => {
    // The recorded body, three of whose fields this build deliberately does not
    // ask for -- `erroredRequests`, `tokensIn`, `tokensOut`. `toEqual` against
    // the exact four-key object is what proves none of them leaked into the
    // interface behind a spread: per-token figures are out of scope for a
    // public page (09 §2), and an interface carrying data the page will not
    // render is the defect this branch already fixed once.
    //
    // `cost` IS DOLLARS AND IS NOT ROUNDED HERE. /ops does the `toFixed(2)`;
    // rounding in the read would throw away precision that a later section
    // (or a reader's own arithmetic) might want, and would hide a unit change
    // upstream behind a plausible-looking figure.
    const wire = vi.fn<FetchImpl>(async () => new Response(JSON.stringify(MEASURED_SPEND)));
    expect(await readSpend(env(), NOW, 30, wire)).toEqual({
      windowDays: 30,
      costUsd: 5.202603642412313,
      requests: 656,
      cachedRequests: 0,
    });
  });

  test('the request is the measured one: POST to the GraphQL endpoint, bearer, window bounds', async () => {
    const wire = vi.fn<FetchImpl>(async () => new Response(JSON.stringify(MEASURED_SPEND)));
    await readSpend(env(), NOW, 30, wire);

    const [url, init] = wire.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(init.method).toBe('POST');
    // By KEY, not by value, for the same reason as the analytics assertion
    // above: the bug worth catching is a request that forgot to carry one, and
    // asserting the value would put a fixture credential in a failure message.
    expect(Object.keys(init.headers as Record<string, string>)).toContain('authorization');

    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(body.variables).toEqual({
      account: 'an-account',
      gateway: 'a-gateway',
      // SECONDS PRECISION, NO MILLISECONDS, AND PINNED RATHER THAN DERIVED.
      // The probe recorded responses only -- nothing that was sent -- so the
      // `Time` scalar's tolerance is the one input here this repo cannot check
      // against the real API. It matters more than an unmeasured thing usually
      // does because its failure has a silent branch: a literal the scalar
      // REJECTS is a 200 with errors and a blank section, but one it ACCEPTS
      // AND READS DIFFERENTLY is a well-formed figure over the wrong window,
      // which nothing downstream can detect. Holding the spelling still is the
      // only guard available from here.
      since: '2026-08-10T12:00:00Z',
      until: '2026-09-09T12:00:00Z',
    });
    // The filter keys those variables feed, so that a rename on either side is
    // a failure here rather than a 200 with an `errors` array in production.
    // That the WINDOW is a parameter at all is the next test's property, not
    // this one's.
    expect(body.query).toContain('datetime_geq');
    expect(body.query).toContain('datetime_leq');
  });

  test('THE WINDOW IS A PARAMETER: a shorter one moves the lower bound and nothing else', async () => {
    // /ops passes the same `WINDOW_DAYS` here as to `readAnalytics`, so two
    // figures on one page measured over two different windows would be the
    // quietest wrong answer this section could give.
    const wire = vi.fn<FetchImpl>(async () => new Response(JSON.stringify(MEASURED_SPEND)));
    const result = await readSpend(env(), NOW, 7, wire);

    expect(result?.windowDays).toBe(7);
    const body = JSON.parse(String((wire.mock.calls[0] as [string, RequestInit])[1].body)) as {
      variables: Record<string, string>;
    };
    expect(body.variables.since).toBe('2026-09-02T12:00:00Z');
    expect(body.variables.until).toBe('2026-09-09T12:00:00Z');
  });

  test('IT ASKS FOR NOTHING IT DOES NOT RENDER', async () => {
    // The spec constraint as an assertion rather than as a comment. The probe
    // returned token counts; this page does not publish them (09 §2), so the
    // query does not request them -- fetching a field nothing renders spends a
    // rate-limited token's round trip on data no reader will ever see, which is
    // the same defect the two unrendered Analytics Engine breakdowns were.
    //
    // NOTE WHAT THIS DOES NOT PROVE: that the narrowed selection set is
    // accepted. The recording holds responses and no requests, so the query
    // text -- its field spellings, its `limit`, this selection -- is how the
    // probe was written rather than a transcript of what it sent. A GraphQL
    // selection is a subset of what came back, which is why the narrowing is
    // safe to make blind; it is not the same as having seen it answered.
    const wire = vi.fn<FetchImpl>(async () => new Response(JSON.stringify(MEASURED_SPEND)));
    await readSpend(env(), NOW, 30, wire);

    const body = String((wire.mock.calls[0] as [string, RequestInit])[1].body);
    expect(body).toContain('cost');
    expect(body).toContain('cachedRequests');
    for (const field of ['erroredRequests', 'tokensIn', 'tokensOut']) {
      expect(body).not.toContain(field);
    }
  });

  describe('the seam', () => {
    test("'stub' returns null without reading the secret or fetching", async () => {
      const read = vi.fn(async () => 'a-fixture-token');
      const wire = never();
      const result = await readSpend(
        env({
          RLME_ANALYTICS_MODE: 'stub',
          RLME_ANALYTICS_TOKEN: { get: read } as unknown as SecretsStoreSecret,
        }),
        NOW,
        30,
        wire,
      );
      expect(result).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(wire).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    test('an unrecognised mode throws here too', async () => {
      // The same rule as `readAnalytics`, asserted separately because it is a
      // second copy of the check rather than a shared one: a seam that threw on
      // one half of the page and shrugged on the other would be worse than
      // either behaviour consistently.
      const wire = never();
      await expect(readSpend(env({ RLME_ANALYTICS_MODE: 'maybe' }), NOW, 30, wire)).rejects.toThrow(
        /unrecognised RLME_ANALYTICS_MODE/,
      );
      expect(wire).not.toHaveBeenCalled();
    });

    test('an unreadable secret is a null and opens no socket', async () => {
      const wire = never();
      const result = await readSpend(
        env({
          RLME_ANALYTICS_TOKEN: {
            get: async () => {
              throw new Error('Secret "RLME_ANALYTICS_TOKEN" not found');
            },
          } as SecretsStoreSecret,
        }),
        NOW,
        30,
        wire,
      );
      expect(result).toBeNull();
      expect(wire).not.toHaveBeenCalled();
    });

    test('the secret is read once', async () => {
      const read = vi.fn(async () => 'a-fixture-token');
      const wire = vi.fn<FetchImpl>(async () => new Response(JSON.stringify(MEASURED_SPEND)));
      await readSpend(
        env({ RLME_ANALYTICS_TOKEN: { get: read } as unknown as SecretsStoreSecret }),
        NOW,
        30,
        wire,
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(wire).toHaveBeenCalledTimes(1);
    });
  });

  describe('failing closed', () => {
    test('A NON-200 IS A NULL, and the body is deliberately a parseable one', async () => {
      // THE FIXTURE IS THE MEASURED SUCCESS BODY AT STATUS 403, which looks
      // perverse and is the only way this test asserts what its name says. A
      // realistic 403 body (`{"success":false,"errors":[...]}` -- what the REST
      // route answered the probe) is ALSO rejected by the `errors` gate and the
      // shape guards below it, so the test would stay green with the status
      // check deleted and would be pinning nothing. Handing the parse a body it
      // would happily read makes the status check the only thing standing
      // between a 403 and three published figures.
      const wire = vi.fn<FetchImpl>(
        async () => new Response(JSON.stringify(MEASURED_SPEND), { status: 403 }),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('A 200 CARRYING A GraphQL errors ARRAY IS A NULL', async () => {
      // The failure mode a status check alone would publish straight onto the
      // page: GraphQL answers 200 for a query error -- an unknown field, a
      // filter key spelled wrongly, a datetime the `Time` scalar rejects.
      //
      // THE FIXTURE IS THE DANGEROUS SPELLING, not the common one, for the same
      // reason as the test above. A query error usually nulls the data as well,
      // and that shape is already caught twice over by the `accounts` guards
      // below. What only this gate catches is a PARTIALLY answered query:
      // every number the parse wants present, an `errors` array beside it, and
      // nothing else to tell the two apart.
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(
            JSON.stringify({
              ...spendBody({ count: 656, sum: { cost: 5.2, cachedRequests: 0 } }),
              errors: [{ message: 'unknown field "cost"' }],
            }),
          ),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();

      // THE ERRORS THEMSELVES REACH THE LOG, asserted because the version that
      // did not was indistinguishable from this one on the page and useless in
      // observability. This is where the unmeasured `Time` spelling lands, and
      // "the gateway query answered 200 with errors" without the complaint in
      // it leaves an operator with a blank tile and nothing to act on. GraphQL
      // errors are query-shape complaints: no credential, no visitor data.
      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining('200 with errors'),
        [{ message: 'unknown field "cost"' }],
      );
    });

    test('AN EMPTY errors ARRAY IS A NULL TOO', async () => {
      // Not a shape this API was seen to produce and not one the GraphQL
      // specification sanctions -- which makes it an envelope this build does
      // not recognise, and those are nulls. The cheap alternative (treat `[]`
      // as success) would be this module deciding that a response it has never
      // seen is fine.
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(
            JSON.stringify({
              ...spendBody({ count: 656, sum: { cost: 5.2, cachedRequests: 0 } }),
              errors: [],
            }),
          ),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('NO errors KEY AT ALL PARSES, because that is what the spec says success looks like', async () => {
      // The one non-null in this block, and it is here rather than above
      // because it pins the boundary of the gate rather than a figure.
      // Cloudflare sends `errors: null`; the specification says a clean
      // response omits the key. Accepting both is what keeps this parse tied to
      // the protocol rather than to one server's habit.
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [
                    {
                      aiGatewayRequestsAdaptiveGroups: [
                        { count: 656, sum: { cost: 5.2, cachedRequests: 0 } },
                      ],
                    },
                  ],
                },
              },
            }),
          ),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toEqual({
        windowDays: 30,
        costUsd: 5.2,
        requests: 656,
        cachedRequests: 0,
      });
    });

    test('a network failure is a null', async () => {
      const wire = vi.fn<FetchImpl>(async () => {
        throw new TypeError('network');
      });
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    /**
     * The three 200s that used to leave this module as a `TypeError` rather
     * than as the `null` its contract promises.
     *
     * THE PARSE RUNS OUTSIDE THE `try`, deliberately -- a network failure and
     * an unrecognised envelope are two different log lines -- so a throw there
     * escapes `readSpend` entirely. /ops catches it and still renders, which is
     * exactly why nothing failed: the defect was invisible on the page and
     * visible only as a `TypeError` filed under a message about a cache read,
     * pointing an operator at the wrong system.
     *
     * All three are shapes a JSON API is allowed to send: `null` is a legal
     * JSON document, and a `null` inside an array is legal anywhere.
     */
    test('a body that is the JSON literal null is a null, not a TypeError', async () => {
      const wire = vi.fn<FetchImpl>(async () => new Response('null'));
      await expect(readSpend(env(), NOW, 30, wire)).resolves.toBeNull();
    });

    test('a null inside the accounts array is a null, not a TypeError', async () => {
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(JSON.stringify({ data: { viewer: { accounts: [null] } }, errors: null })),
      );
      await expect(readSpend(env(), NOW, 30, wire)).resolves.toBeNull();
    });

    test('a null inside the groups array is a null, not a TypeError', async () => {
      const wire = vi.fn<FetchImpl>(async () => new Response(JSON.stringify(spendBody(null))));
      await expect(readSpend(env(), NOW, 30, wire)).resolves.toBeNull();
    });

    test('a body that is not JSON is a null', async () => {
      const wire = vi.fn<FetchImpl>(async () => new Response('<html>an error page</html>'));
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('a missing accounts array is a null', async () => {
      // The envelope-moved case: `viewer` answers, `accounts` does not. This is
      // the gateway's version of the `{ result: [...] }` assertion above.
      const wire = vi.fn<FetchImpl>(
        async () => new Response(JSON.stringify({ data: { viewer: {} }, errors: null })),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('an empty accounts array is a null', async () => {
      // What a wrong `accountTag` looks like from here: a well-formed 200 with
      // nobody in it. Publishing $0.00 for that would be a number about an
      // account this site does not own.
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(JSON.stringify({ data: { viewer: { accounts: [] } }, errors: null })),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('AN EMPTY GROUPS ARRAY IS A NULL, NOT $0.00', async () => {
      // The deliberate asymmetry with `byAgent`, where zero rows IS a
      // measurement and is published as one. The difference is that an empty
      // `byAgent` can only mean "no agent requests", while an empty group here
      // is ambiguous between "nothing was spent", "the gateway id does not
      // match" and "the window bounds were read differently than meant" -- and
      // the probe's window had traffic in it, so which one it is has never been
      // measured. Three headline cost figures are not the place to guess.
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(
            JSON.stringify({
              data: { viewer: { accounts: [{ aiGatewayRequestsAdaptiveGroups: [] }] } },
              errors: null,
            }),
          ),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('more than one group is a null rather than the first row published as the total', async () => {
      // The query requests no grouping dimension, so one group is the whole
      // answer. If that ever stops being true, reading `[0]` would publish a
      // fraction of the spend as the total -- a wrong number that looks exactly
      // like a right one.
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [
                    {
                      aiGatewayRequestsAdaptiveGroups: [
                        { count: 400, sum: { cost: 3, cachedRequests: 0 } },
                        { count: 256, sum: { cost: 2.2, cachedRequests: 0 } },
                      ],
                    },
                  ],
                },
              },
              errors: null,
            }),
          ),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('A NON-FINITE cost IS A NULL, NOT "$NaN" ON THE PAGE', async () => {
      // /ops renders `$${costUsd.toFixed(2)}`, and `NaN.toFixed(2)` is the
      // string "NaN" -- printed beside a dollar sign, under a label that reads
      // as a measurement.
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(
            JSON.stringify(spendBody({ count: 656, sum: { cost: 'free', cachedRequests: 0 } })),
          ),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('an absent cachedRequests fails the whole read rather than rendering two of three', async () => {
      // No pre-agreed fallback here, unlike `p50Ms`: all three tiles are
      // rendered, none has a second source, and a section showing two of them
      // invites a reader to work out which number it could not get.
      const wire = vi.fn<FetchImpl>(
        async () => new Response(JSON.stringify(spendBody({ count: 656, sum: { cost: 5.2 } }))),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('a group with no sum at all is a null', async () => {
      const wire = vi.fn<FetchImpl>(
        async () => new Response(JSON.stringify(spendBody({ count: 656 }))),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('a non-numeric count is a null', async () => {
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(
            JSON.stringify(spendBody({ count: null, sum: { cost: 5.2, cachedRequests: 0 } })),
          ),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toBeNull();
    });

    test('a count that arrives as a UInt64 STRING is still a number on the way out', async () => {
      // `count` came back as a JSON number from the gateway and as a string
      // from Analytics Engine, for the same kind of column. Since one API in
      // this module already does that, the parse accepts both here rather than
      // depending on which of the two habits this endpoint keeps.
      const wire = vi.fn<FetchImpl>(
        async () =>
          new Response(
            JSON.stringify(spendBody({ count: '656', sum: { cost: 5.2, cachedRequests: '4' } })),
          ),
      );
      expect(await readSpend(env(), NOW, 30, wire)).toEqual({
        windowDays: 30,
        costUsd: 5.2,
        requests: 656,
        cachedRequests: 4,
      });
    });
  });
});
