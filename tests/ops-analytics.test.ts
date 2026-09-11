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
 * WHAT THIS SUITE CANNOT PROVE, said out loud because the gap is unusually
 * large here: neither API has ever been answered by the real service. The
 * plan's measuring step could not run (the two failures are recorded at the top
 * of src/lib/ops/analytics.ts), so every response below is a FIXTURE OF A
 * GUESS -- the `{ data: [...] }` envelope is what this build assumes Analytics
 * Engine returns, not what it was seen to return. A green run here means the
 * module handles that envelope and fails closed on everything else; it does not
 * mean the envelope is right.
 *
 * That is exactly why the failure assertions outnumber the success ones. The
 * property this page actually depends on is that an unrecognised response
 * yields `null` rather than a zero, and that property holds whatever the real
 * shape turns out to be.
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

  test('a non-200 is a null', async () => {
    expect(await readAnalytics(env(), NOW, 30, answering({ data: [] }, 403))).toBeNull();
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
    // The assertion the whole module is built around, and the one that matters
    // most given that the real envelope has never been measured. `result` here
    // is a plausible alternative spelling of `data`; if that is what the API
    // actually returns, /ops says "not configured" rather than "0 requests".
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
    // ClickHouse-family engines emit `nan`/`inf`, on an envelope this build has
    // never measured. /ops renders `${Math.round(p50Ms)} ms`, so an unguarded
    // coercion published the literal string "NaN ms".
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
    // `quantileWeighted` is ClickHouse-shaped and unconfirmed against the real
    // SQL API. If it is not supported the agreed answer is to drop the figure
    // and have /ops render "not published"; either way the value that must
    // never appear is a 0 ms median.
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

describe('readSpend', () => {
  test('RETURNS NULL UNCONDITIONALLY, because the response was never measured', async () => {
    // Pinning a deliberate gap, not a behaviour. Neither the AI Gateway
    // ENDPOINT nor its envelope has been settled -- the two possibilities are
    // named at the head of src/lib/ops/analytics.ts -- so there is no parse to
    // test, and a plausible parse written blind would look finished, typecheck,
    // and return null forever against a real response that differs by one field
    // name, which is indistinguishable on the page from "not configured".
    //
    // WHOEVER WRITES THAT PARSE MUST DELETE THIS TEST. That is the point of it:
    // it fails the moment the function starts working, so the gap cannot be
    // closed without someone reading the comment above it.
    expect(await readSpend(env())).toBeNull();
    expect(await readSpend(env({ RLME_ANALYTICS_MODE: 'stub' }))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
