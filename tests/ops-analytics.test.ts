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
 * `fetch` IS STUBBED GLOBALLY rather than injected. Every other network-reading
 * module in this repo takes a `fetchImpl` parameter (src/lib/turnstile.ts), and
 * that is the better pattern; `readAnalytics`'s signature is fixed by the plan's
 * published interface, so the seam here is `vi.stubGlobal`. The stub throws by
 * default, so a test that expects NO request proves it by passing rather than by
 * quietly reaching the real api.cloudflare.com.
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
type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** One stubbed `fetch` returning the same body to all three queries. */
const answering = (body: unknown, status = 200) =>
  vi.fn<FetchImpl>(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  // The default: any request at all is a failure, not a pass-through.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('this suite must not make a request');
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
    const result = await readAnalytics(
      env({
        RLME_ANALYTICS_MODE: 'stub',
        RLME_ANALYTICS_TOKEN: { get: read } as unknown as SecretsStoreSecret,
      }),
      NOW,
    );
    expect(result).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an unrecognised mode throws a plain Error rather than degrading quietly', async () => {
    // The same shape as every other seam in this repo: a value nobody meant to
    // set must be loud, because the alternative is a page that silently says
    // "not configured" forever.
    await expect(readAnalytics(env({ RLME_ANALYTICS_MODE: 'maybe' }), NOW)).rejects.toThrow(
      /unrecognised RLME_ANALYTICS_MODE/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('failing closed', () => {
  test('an unreadable secret is a null, not a zero and not a throw', async () => {
    // The expected state until the owner's Secrets Store entry is populated,
    // and the state every test in this repo runs in.
    const result = await readAnalytics(
      env({
        RLME_ANALYTICS_TOKEN: {
          get: async () => {
            throw new Error('Secret "RLME_ANALYTICS_TOKEN" not found');
          },
        } as SecretsStoreSecret,
      }),
      NOW,
    );
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an empty secret is a null, and is not sent as a bearer token', async () => {
    const result = await readAnalytics(
      env({ RLME_ANALYTICS_TOKEN: { get: async () => '' } as SecretsStoreSecret }),
      NOW,
    );
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a non-200 is a null', async () => {
    vi.stubGlobal('fetch', answering({ data: [] }, 403));
    expect(await readAnalytics(env(), NOW)).toBeNull();
  });

  test('a network failure is a null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    expect(await readAnalytics(env(), NOW)).toBeNull();
  });

  test('a body that is not JSON is a null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>an error page</html>')),
    );
    expect(await readAnalytics(env(), NOW)).toBeNull();
  });

  test('AN ENVELOPE THIS BUILD DOES NOT RECOGNISE IS A NULL', async () => {
    // The assertion the whole module is built around, and the one that matters
    // most given that the real envelope has never been measured. `result` here
    // is a plausible alternative spelling of `data`; if that is what the API
    // actually returns, /ops says "not configured" rather than "0 requests".
    vi.stubGlobal('fetch', answering({ result: [{ requests: 5 }], success: true }));
    expect(await readAnalytics(env(), NOW)).toBeNull();
  });

  test('one failing query out of three fails the whole read', async () => {
    // Partial truth is the one outcome worse than silence here: a page showing
    // a request total with an empty agent breakdown reads as "no agents came",
    // which is a different claim from "this could not be read".
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return call === 2
          ? new Response('nope', { status: 500 })
          : new Response(JSON.stringify({ data: [] }));
      }),
    );
    expect(await readAnalytics(env(), NOW)).toBeNull();
  });
});

describe('the query text', () => {
  test('counts with SUM(_sample_interval) rather than count(), in every query', async () => {
    // The module's own comment calls this "the single most likely way for /ops
    // to be quietly wrong": `count()` counts STORED rows and under-reports
    // exactly when traffic is high enough for the page to be interesting.
    const stub = answering({ data: [] });
    vi.stubGlobal('fetch', stub);
    await readAnalytics(env(), NOW);

    const bodies = stub.mock.calls.map((call) => String((call[1] as RequestInit).body));
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).toContain('SUM(_sample_interval)');
      expect(body).not.toMatch(/\bcount\(\)/);
    }
  });

  test('the window bound reaches the wire as a toDateTime with no timezone suffix', async () => {
    const stub = answering({ data: [] });
    vi.stubGlobal('fetch', stub);
    await readAnalytics(env(), NOW, 30);

    for (const call of stub.mock.calls) {
      expect(String((call[1] as RequestInit).body)).toContain(
        "timestamp >= toDateTime('2026-08-10 12:00:00')",
      );
    }
  });

  test('the account id shapes the URL and the token is sent as a bearer', async () => {
    const stub = answering({ data: [] });
    vi.stubGlobal('fetch', stub);
    await readAnalytics(env(), NOW);

    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
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
  /** Three different bodies, one per query, in the order `Promise.all` issues them. */
  const inOrder = (bodies: unknown[]) => {
    let call = -1;
    return vi.fn<FetchImpl>(async () => {
      call += 1;
      return new Response(JSON.stringify(bodies[call]));
    });
  };

  const traffic = async (): Promise<AgentTraffic | null> => {
    vi.stubGlobal(
      'fetch',
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
    return await readAnalytics(env(), NOW, 30);
  };

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

  test('an empty result set is zeros rather than null -- silence is not failure', async () => {
    // The distinction the page depends on: `null` means "could not be read",
    // and an empty dataset means "nothing happened", which is a real answer.
    vi.stubGlobal('fetch', answering({ data: [] }));
    expect(await readAnalytics(env(), NOW, 30)).toEqual({
      windowDays: 30,
      requests: 0,
      agentRequests: 0,
      byAgent: [],
      byRouteClass: [],
      p50Ms: null,
    });
  });

  test('an absent p50 is null rather than 0 -- the fallback the plan pre-agreed', async () => {
    // `quantileWeighted` is ClickHouse-shaped and unconfirmed against the real
    // SQL API. If it is not supported the agreed answer is to drop the figure
    // and have /ops render "not published"; either way the value that must
    // never appear is a 0 ms median.
    vi.stubGlobal(
      'fetch',
      inOrder([
        { data: [{ requests: 5, agent_requests: 1, p50: null }] },
        { data: [] },
        { data: [] },
      ]),
    );
    const result = await readAnalytics(env(), NOW, 30);
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
  const withFields = async (fields: string[]) => {
    vi.resetModules();
    vi.doMock('../src/lib/agent-intel/record', () => ({ AE_BLOB_FIELDS: fields }));
    const module = await import('../src/lib/ops/analytics');
    try {
      return await module.readAnalytics(env(), NOW);
    } finally {
      vi.doUnmock('../src/lib/agent-intel/record');
      vi.resetModules();
    }
  };

  const REAL = ['agent_class', 'agent', 'route_class', 'referrer_class', 'surface', 'status_class'];

  test('the real order passes the guard', async () => {
    vi.stubGlobal('fetch', answering({ data: [] }));
    await expect(withFields([...REAL])).resolves.not.toBeNull();
  });

  test('swapping the first two positions throws before any query runs', async () => {
    await expect(withFields(['agent', 'agent_class', ...REAL.slice(2)])).rejects.toThrow(
      /AE_BLOB_FIELDS was reordered/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test('moving ONLY blob3 throws too', async () => {
    // The position the first version of this guard did not check. `blob3` is
    // `route_class`, which the by-route-class query groups by -- a reorder that
    // left the first two alone would have relabelled that whole breakdown while
    // passing a two-position check.
    await expect(withFields(['agent_class', 'agent', 'surface', 'route_class'])).rejects.toThrow(
      /AE_BLOB_FIELDS was reordered/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('readSpend', () => {
  test('RETURNS NULL UNCONDITIONALLY, because the response was never measured', async () => {
    // Pinning a deliberate gap, not a behaviour. The AI Gateway envelope has
    // never been seen (see the head of src/lib/ops/analytics.ts for why the
    // probe could not run), so there is no parse to test -- and a plausible
    // parse written blind would look finished, typecheck, and return null
    // forever against a real response that differs by one field name, which is
    // indistinguishable on the page from "not configured".
    //
    // WHOEVER WRITES THAT PARSE MUST DELETE THIS TEST. That is the point of it:
    // it fails the moment the function starts working, so the gap cannot be
    // closed without someone reading the comment above it.
    expect(await readSpend(env())).toBeNull();
    expect(await readSpend(env({ RLME_ANALYTICS_MODE: 'stub' }))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
