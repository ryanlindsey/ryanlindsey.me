import { AE_BLOB_FIELDS } from '../agent-intel/record';

// The credentialed half of /ops (06 §1). Two HTTPS reads, both of which need an
// account API token, because NEITHER Analytics Engine NOR AI Gateway has a
// binding-side read -- the `AE` binding writes and cannot query, and the
// gateway's numbers are not exposed to a Worker at all.
//
// WHICH gateway endpoint carries those numbers is UNDETERMINED, and saying so
// is the honest state rather than a hedge: nobody here has called either of the
// two possibilities. They are the REST route
// `/accounts/{account}/ai-gateway/gateways/{id}` and the GraphQL dataset
// `aiGatewayRequestsAdaptiveGroups`, and the plan's Step 3 probe is what
// decides between them. `readSpend` below is empty for exactly this reason.
// wrangler.jsonc's comment beside `RLME_ANALYTICS_TOKEN` says the same thing;
// if one of these is ever edited, edit the other.
//
// That token is the only credential this project has that is not a deploy
// credential Cloudflare holds for itself (10 §3.1), so it is scoped to two
// read permissions, lives in Secrets Store, and is read by exactly this module.
//
// EVERY FAILURE RETURNS `null`, NEVER A ZERO. An absent secret, a non-200, an
// envelope this build does not recognise, a network failure -- all of them mean
// "this page cannot say", and the page renders that. A zero would be a lie on
// the one page whose entire premise is that the numbers are real, and it would
// be an invisible one: nobody reading "0 agents served" thinks to check whether
// the query ran.
//
// ------------------------------------------------------------------------
// NEITHER API HAS BEEN MEASURED. Read this before trusting anything below.
// ------------------------------------------------------------------------
//
// The plan's Step 3 was a single probe of each API through a temporary Worker
// route, whose whole purpose was to replace the guesses in this file with
// recorded fact. IT COULD NOT BE RUN (attempted 2026-09-11, both Workers):
//
//   - `wrangler dev --remote` answered HTTP 503 `error code: 1105` on every
//     route, so no request ever reached the Worker;
//   - plain `wrangler dev`, with `"remote": true` on the secrets-store entry,
//     reads the LOCAL store -- which is empty, by design, on every machine and
//     in CI -- and answered `Secret "RLME_ANALYTICS_TOKEN" not found`.
//
// A Secrets Store value is write-only: only a Worker binding can read one, and
// the CLI and API return metadata. So there is no third way to reach it from a
// shell, and the two envelopes below remain UNMEASURED. What that means for
// each half is different, and the difference is deliberate:
//
//   - `readAnalytics` SHIPS ON A GUESS THAT FAILS CLOSED. `payload.data` is
//     assumed to be the row array; it is guarded by `Array.isArray`, so an
//     envelope of any other shape yields `null` and /ops says the section is
//     not configured. Wrong-but-safe, and self-announcing the first time
//     anyone looks at a real response.
//   - `readSpend` SHIPS WITH NO PARSE AT ALL, for the reason written at that
//     function.
//
// TWO SQL DIALECT RISKS, ALSO UNCONFIRMED, and their fallbacks were agreed in
// advance so that whoever first sees a real error does not have to relitigate
// them. `sumIf` and `quantileWeighted` are ClickHouse-shaped and are the two
// most likely things the Analytics Engine SQL API does not carry. If it does
// not: (1) DROP `p50Ms` entirely and have /ops render the latency figure as
// "not published" -- it is the least valuable number on the page and the only
// one with no second source; (2) replace `sumIf` with a SECOND query whose
// `WHERE` carries `blob1 = 'agent'`, which is one more round trip inside a
// 60-second cache and costs nothing anyone will notice. Do not let /ops slip
// over either. Record what the API actually said here when you find out --
// a future reader needs to know whether a query is shaped this way because of
// a limit or by preference.
//
// THERE IS NO SITEWIDE ERROR-RATE QUERY HERE, AND ONE MUST NOT BE ADDED. Every
// chat row in this dataset carries `status_class = '2xx'`, refusals included,
// because `POST /chat` always answers 200 and puts the error in a frame inside
// the stream (src/lib/agent-intel/record.ts's `statusClass`, workers/mcp's chat
// handler). An error rate spanning chat therefore reads a constant 0% for the
// surface most likely to be failing, which is worse than publishing nothing.
// The spec never asks for one. Chat health lives in `chat_turns.outcome`, in
// D1, where a failed turn is actually recorded as one.

export interface AnalyticsEnv {
  RLME_ANALYTICS_TOKEN: SecretsStoreSecret;
  RLME_ACCOUNT_ID: string;
  RLME_AI_GATEWAY_ID: string;
  /** Test-only seam beside the secret it stands in for; `'stub'` returns null without reading or fetching. */
  RLME_ANALYTICS_MODE?: string;
}

export interface AgentTraffic {
  windowDays: number;
  requests: number;
  agentRequests: number;
  byAgent: { agent: string; requests: number }[];
  byRouteClass: { routeClass: string; requests: number }[];
  p50Ms: number | null;
}

export interface GatewaySpend {
  windowDays: number;
  costUsd: number;
  requests: number;
  cachedRequests: number;
}

const SQL_URL = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;

const DATASET = 'ryanlindsey_me_events';

/**
 * Counting here is `SUM(_sample_interval)`, not `count()`.
 *
 * Analytics Engine samples under load and stores one row standing for
 * `_sample_interval` real events. `count()` therefore counts STORED rows, which
 * is the same number until the day traffic is high enough to matter and then
 * silently under-reports exactly when the page becomes interesting. This is the
 * single most likely way for /ops to be quietly wrong, so it is written once,
 * here, and every query below goes through it.
 */
const COUNT = 'SUM(_sample_interval)';

/**
 * The Secrets Store read, ONCE per `readAnalytics` call rather than once per
 * query.
 *
 * It used to sit inside `query`, which meant three reads of the same secret for
 * one page render -- three chances to fail independently, and a state where two
 * queries could carry a token the third could not get.
 *
 * `null` for every way the read can fail to produce a usable token:
 *
 *   - IT THROWS. The expected state before the owner's prerequisite lands, and
 *     also the state under the test harness: miniflare simulates
 *     `secrets_store_secrets` against a local store nothing has populated, so
 *     `.get()` raises `Secret "..." not found` (measured in day 5 Task 2 and
 *     recorded in tests/tier-grant.test.ts).
 *   - IT ANSWERS SOMETHING THAT IS NOT A NON-EMPTY STRING. The binding's type
 *     says `Promise<string>`, so the `typeof` check looks redundant and is not:
 *     a rotated-to-empty secret is a real state this repo has already had to
 *     handle once (tests/tier-grant.test.ts again), and without the check an
 *     `undefined` would reach the wire as the literal text `Bearer undefined`.
 *     That still fails closed on the 401, but it spends a round trip and puts a
 *     nonsense credential in someone's edge logs to do it.
 */
async function readToken(env: AnalyticsEnv): Promise<string | null> {
  let token: unknown;
  try {
    token = await env.RLME_ANALYTICS_TOKEN.get();
  } catch {
    return null;
  }
  if (typeof token !== 'string' || token === '') return null;
  return token;
}

async function query(
  env: AnalyticsEnv,
  token: string,
  sql: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>[] | null> {
  try {
    const response = await fetchImpl(SQL_URL(env.RLME_ACCOUNT_ID), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: sql,
    });
    if (!response.ok) {
      console.error(`ops: the analytics query answered ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as { data?: unknown };
    // Defensive rather than trusting: an envelope this build does not recognise
    // is a null, not a crash and not an empty page. `data` is a GUESS -- see the
    // unmeasured note at the top of this file -- and this line is what makes a
    // wrong guess safe.
    return Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : null;
  } catch (error) {
    console.error('ops: the analytics query failed', error);
    return null;
  }
}

/**
 * `fetchImpl` is injected, defaulted to the global `fetch`, so every existing
 * call site stays valid and the tests exercise the real request-shaping code
 * rather than a mock of it. The same pattern and the same reason as
 * `verifyTurnstile` (src/lib/turnstile.ts): the assertions worth having are
 * that the account id shapes the URL and that the token reaches the wire as a
 * bearer, and those are only available from inside the call.
 */
export async function readAnalytics(
  env: AnalyticsEnv,
  now: Date,
  windowDays = 30,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentTraffic | null> {
  const mode = env.RLME_ANALYTICS_MODE;
  if (mode !== undefined && mode !== 'stub') {
    throw new Error(`unrecognised RLME_ANALYTICS_MODE: ${mode}`);
  }
  if (mode === 'stub') return null;

  const since = `toDateTime('${new Date(now.getTime() - windowDays * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ')}')`;

  // blob1 is agent_class, blob2 is agent, blob3 is route_class -- POSITIONS,
  // not names, because the SQL API addresses columns by position and there are
  // no column names on the wire. The assertion below is the only thing tying
  // those positions to their meanings: if somebody reorders `AE_BLOB_FIELDS`,
  // every query in this file silently starts reading a different column, and
  // both sides stay internally consistent so nothing else catches it.
  //
  // A REAL CHECK, not `void AE_BLOB_FIELDS`. The import was originally there to
  // keep the two files findable from each other and was discarded with `void`,
  // which is a comment wearing a statement's clothes -- it cannot fail.
  //
  // All THREE positions this file reads are checked, not the first two: the
  // route-class query below groups by `blob3`, so a reorder that moved only
  // that field would pass a two-position check and relabel the whole
  // by-route-class breakdown.
  if (
    AE_BLOB_FIELDS[0] !== 'agent_class' ||
    AE_BLOB_FIELDS[1] !== 'agent' ||
    AE_BLOB_FIELDS[2] !== 'route_class'
  ) {
    throw new Error('ops: AE_BLOB_FIELDS was reordered; every query below is now wrong');
  }

  // ONE Secrets Store read for the whole page render, taken before the three
  // queries rather than inside each of them. An absent or unusable token is the
  // same `null` the queries would have produced, arrived at without opening a
  // socket.
  const token = await readToken(env);
  if (token === null) return null;

  const [totals, agents, routes] = await Promise.all([
    // `double2` is the request duration (`doubles: [1, durationMs]` in
    // src/lib/agent-intel/record.ts), and this median is SITEWIDE -- chat is
    // not filtered out of it, deliberately.
    //
    // The objection on file is that chat's `double2` covers the whole stream
    // rather than time-to-first-byte and so "drags the sitewide p50 up". That
    // is true of a MEAN and very nearly false of a MEDIAN, which is what
    // `quantileWeighted(0.5)` computes: chat is a small minority of the
    // requests that reach a Worker, so it moves the 50th percentile hardly at
    // all. Excluding it, meanwhile, would make a figure labelled "edge latency"
    // silently omit the slowest real surface on the site -- a number that looks
    // better by leaving out the part a reader most wants included.
    //
    // The condition under which this SHOULD change: chat becoming a large share
    // of Worker-reaching traffic. Then the median genuinely becomes a blend of
    // two different measurements, and the answer is to publish the two surfaces
    // separately (group by `blob5`, the surface) rather than to hide one.
    query(
      env,
      token,
      `SELECT ${COUNT} AS requests,
              sumIf(_sample_interval, blob1 = 'agent') AS agent_requests,
              quantileWeighted(0.5)(double2, _sample_interval) AS p50
         FROM ${DATASET} WHERE timestamp >= ${since}`,
      fetchImpl,
    ),
    query(
      env,
      token,
      `SELECT blob2 AS agent, ${COUNT} AS requests FROM ${DATASET}
        WHERE timestamp >= ${since} AND blob1 = 'agent'
        GROUP BY agent ORDER BY requests DESC LIMIT 15`,
      fetchImpl,
    ),
    query(
      env,
      token,
      `SELECT blob3 AS route_class, ${COUNT} AS requests FROM ${DATASET}
        WHERE timestamp >= ${since} GROUP BY route_class ORDER BY requests DESC`,
      fetchImpl,
    ),
  ]);

  if (totals === null || agents === null || routes === null) return null;

  const first = totals[0] ?? {};
  return {
    windowDays,
    requests: Number(first.requests ?? 0),
    agentRequests: Number(first.agent_requests ?? 0),
    byAgent: agents.map((row) => ({
      agent: String(row.agent),
      requests: Number(row.requests),
    })),
    byRouteClass: routes.map((row) => ({
      routeClass: String(row.route_class),
      requests: Number(row.requests),
    })),
    p50Ms: first.p50 === undefined || first.p50 === null ? null : Number(first.p50),
  };
}

/**
 * The gateway's own 30-day spend and cache-hit numbers (06 §1's "Model & cost").
 *
 * Same token, same failure contract, and the same reason for publishing it at
 * all: 06 §1 calls real cost numbers "a differentiator and a great screenshot",
 * and a cost page that rounds to a marketing number is neither.
 *
 * THIS RETURNS `null` UNCONDITIONALLY, AND THAT IS A DELIBERATE GAP RATHER THAN
 * AN OVERSIGHT. The AI Gateway response shape was NEVER MEASURED -- the probe
 * that was supposed to measure it could not be run at all, for the two reasons
 * recorded at the top of this file. No field name, no nesting and no unit
 * (dollars? micro-dollars? a string?) is known here.
 *
 * NOR IS THE ENDPOINT ITSELF SETTLED. Two possibilities, neither of them
 * called: the REST route `/accounts/{account}/ai-gateway/gateways/{id}` and the
 * GraphQL dataset `aiGatewayRequestsAdaptiveGroups`. They differ in more than
 * spelling -- one is
 * a GET against this account's `RLME_AI_GATEWAY_ID`, the other a POST of a
 * query document to a different host path -- so "write the parse" is not the
 * whole of the remaining work. Step 1 below decides which.
 *
 * The alternative was a plausible-looking parse, and it is strictly worse: it
 * would typecheck, read as finished, and return `null` forever against a real
 * envelope that differs by one field name -- which is INDISTINGUISHABLE on the
 * page from "not configured". An empty function says what is true. /ops renders
 * the spend section as not configured, which it is.
 *
 * TO FINISH THIS, in order:
 *   1. Run the plan's Step 3 probe (a temporary route on the site Worker, read
 *      through the binding, `wrangler dev --remote`) against BOTH of the
 *      possibilities above, and RECORD which one answers and its raw body --
 *      the envelope, the field names, the units, and what an empty window looks
 *      like -- in this comment.
 *   2. Write a parse against WHAT WAS RECORDED, returning `null` on anything
 *      that does not match it, exactly as `query` above does with
 *      `Array.isArray`. Take an injected `fetchImpl` while you are here, as
 *      `readAnalytics` does, so the request can be asserted from inside.
 *   3. Delete the probe route before committing AND before deploying:
 *      `wrangler deploy` bundles the working tree, not the committed tree, and
 *      this repo has already shipped a temporary token-signing endpoint to
 *      production once that way.
 * Until step 1 happens, leave this as it is. A number nobody checked is worse
 * on this page than no number.
 */
export async function readSpend(_env: AnalyticsEnv): Promise<GatewaySpend | null> {
  return null;
}
