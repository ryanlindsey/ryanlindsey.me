import { AE_BLOB_FIELDS } from '../agent-intel/record';

// The credentialed half of /ops (06 §1). Two HTTPS reads, both of which need an
// account API token, because NEITHER Analytics Engine NOR AI Gateway has a
// binding-side read -- the `AE` binding writes and cannot query, and the
// gateway's numbers are not exposed to a Worker at all.
//
// WHICH gateway endpoint carries those numbers is SETTLED, MEASURED 2026-09-11:
// the GraphQL dataset `aiGatewayRequestsAdaptiveGroups`, not the REST route
// `/accounts/{account}/ai-gateway/gateways/{id}`, which answers 403 to this
// token. `readSpend` below reads the first and the block at that function
// records both bodies. wrangler.jsonc's comment beside `RLME_ANALYTICS_TOKEN`
// says the same thing; if one of these is ever edited, edit the other.
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
// THAT RULE IS NUMBER-SHAPED, NOT NULL-SHAPED, and the difference is where it
// used to leak (final-review Important 3 and 4). `Number(x ?? 0)` answers `NaN`
// for any non-numeric `x` and `0` for an absent one, and both reach the page as
// a rendered figure -- "NaN ms" and "0" respectively. So every value this
// module publishes goes through `finiteNumber` below, an empty `totals` is a
// `null` rather than a zero, and a breakdown row this build cannot read is a
// `null` for the whole read rather than a silently dropped line.
//
// ------------------------------------------------------------------------
// BOTH ENVELOPES MEASURED 2026-09-11. Everything below is recorded, not
// assumed.
// ------------------------------------------------------------------------
//
// The plan's Step 3 ran: a temporary route on the site Worker, reading
// `RLME_ANALYTICS_TOKEN` through its binding (the only way to read a Secrets
// Store value -- it is write-only to the CLI and the API, which return
// metadata), under `wrangler dev --remote` against the real account. The route
// was deleted before committing. Five probes.
//
// THIS COMMENT IS THE RECORD, AND THAT IS WHY IT QUOTES SO MUCH. The raw bodies
// were written to the plan's own working notes under `.superpowers/`, which
// .gitignore excludes -- so what is transcribed here and at `readSpend` is what
// a future reader gets, and the fixtures in tests/ops-analytics.test.ts are the
// other copy. Do not thin either one out on the assumption that the file is
// findable.
//
// WHAT THE RECORDING DOES NOT CONTAIN: the requests. It holds five labelled
// responses and nothing that was sent -- no URL, no header, no SQL text, no
// GraphQL document, no variables. So every claim below about a RESPONSE is
// record, and every claim anywhere in this file about what was SENT (the exact
// query text, the `limit`, the selection set, the datetime spelling, the REST
// route's spelling) is recollection of how the probe was run. Where that
// difference can bite, it is said at the line.
//
// What the probes establish, for the Analytics Engine half:
//
//   - THE SQL ENVELOPE IS `{ meta: [{name,type},...], data: [...], rows,
//     rows_before_limit_at_least }`. `payload.data` is the row array, which is
//     what `query` below reads -- confirmed, where it used to be a guess that
//     merely failed closed.
//   - TYPES ARE MIXED WITHIN ONE ROW, and this is the finding worth having gone
//     and looked for. A `UInt64` aggregate comes back as a JSON STRING
//     (`"requests": "1041"`, `"agent_requests": "314"`) while a `Float64` comes
//     back as a NUMBER (`"p50": 0`) -- in the same row, from the same query. A
//     coercion that handled only one of the two would be right about half this
//     module's fields and silently wrong about the other half, which is why
//     `finiteNumber` takes both and why a test pins the asymmetry.
//   - A GROUPED ROW CARRIES ITS LABEL AS A `String` AND ITS COUNT AS A `UInt64`
//     STRING (probe `ae:groupBy`, the by-route-class query):
//
//       {"meta":[{"name":"route_class","type":"String"},
//                {"name":"requests","type":"UInt64"}],
//        "data":[{"route_class":"other","requests":"983"},
//                {"route_class":"agent-signal","requests":"46"},
//                {"route_class":"content","requests":"12"}],
//        "rows":3,"rows_before_limit_at_least":305}
//
//     So `breakdownRows`'s two demands -- a non-empty string label, a
//     `finiteNumber` count -- are both satisfied by the real thing rather than
//     by a fixture written to suit them, and the label vocabulary on the wire
//     is `RouteClass` exactly as src/lib/agent-intel/classify.ts closes it.
//   - AN EMPTY GROUPED RESULT IS `data: []` WITH `rows: 0` -- a real empty
//     array, not an absent key and not a `null`. That is what lets an empty
//     `byAgent` stay a measurement while an empty `totals` stays a `null`.
//   - `p50` CAME BACK AS 0 OVER 1041 REQUESTS, WHICH IS NOT A LATENCY. See the
//     note on `p50Ms` at the end of `readAnalytics`: the figure is structurally
//     near-zero for this Worker, the probe is evidence that the FUNCTION
//     resolved (`meta` types it `Float64`) and no evidence at all about
//     response times. Do not read that 0 as a fast site.
//
// The gateway half is recorded at `readSpend`, where the parse is.
//
// THE TWO SQL DIALECT RISKS ARE CLOSED, MEASURED WORKING. `sumIf` and
// `quantileWeighted` are ClickHouse-shaped and were the two most likely things
// the Analytics Engine SQL API might not carry; the probe sent both in one
// statement -- `sumIf(_sample_interval, blob1 = 'agent')` and
// `quantileWeighted(0.5)(double2, _sample_interval)` -- and got 200 with both
// columns populated. So the queries below are shaped this way BY PREFERENCE,
// not around a limit, which is the thing a future reader needs to know. The
// fallbacks agreed in advance are NOT IN USE and are kept here only so that a
// dialect change has an answer ready rather than a relitigation: (1) drop
// `p50Ms` and have /ops render the latency figure as "not published" -- it is
// the least valuable number on the page and the only one with no second
// source; (2) replace `sumIf` with a SECOND query whose `WHERE` carries
// `blob1 = 'agent'`, one more round trip inside a 60-second cache.
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
 * The Secrets Store read, ONCE per exported call rather than once per query.
 *
 * It used to sit inside `query`, which meant three reads of the same secret for
 * one page render -- three chances to fail independently, and a state where two
 * queries could carry a token the third could not get.
 *
 * `readSpend` READS IT AGAIN, and that second read is correct rather than a
 * regression of the same defect: /ops caches the two halves under separate keys
 * (src/pages/ops.astro), so they are two independent reads that can be
 * configured, fail and expire separately. One read per call is the rule; one
 * read per page is not.
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
    // is a null, not a crash and not an empty page. `data` is now MEASURED to
    // be the row array (2026-09-11, see the top of this file), so this line is
    // no longer what makes a guess safe -- it is what keeps a future change to
    // that envelope off the page as an absence rather than as a zero.
    return Array.isArray(payload.data) ? (payload.data as Record<string, unknown>[]) : null;
  } catch (error) {
    console.error('ops: the analytics query failed', error);
    return null;
  }
}

/**
 * A response field as a real number, or `null` when it is not one.
 *
 * THE FAIL-CLOSED INSTINCT OF `Array.isArray` IN `query`, APPLIED TO A VALUE.
 * `Number()` is the wrong guard on its own and was the one this file used:
 * `Number(undefined)` is `NaN`, `Number(null)` and `Number('')` are `0`, and
 * both land on /ops as a published figure ("NaN ms", "0") that a reader cannot
 * tell from a measurement. `Number.isFinite` catches the first; refusing
 * anything that is not a number or a non-blank string catches the second.
 *
 * A STRING IS ACCEPTED ON PURPOSE, AND THE MEASUREMENT SAYS SO RATHER THAN
 * CAUTION. The 2026-09-11 probe (top of this file) returned `UInt64` aggregates
 * as JSON STRINGS -- `"requests": "1041"` -- and `Float64` as a NUMBER --
 * `"p50": 0` -- in the same row of the same response. So both branches below
 * are live on every real read, and "simplifying" this to `Number.isFinite(x)`
 * would null every count on the page while leaving the latency figure working;
 * "simplifying" it to `Number(x)` would put `0` and `NaN` back on the page.
 * tests/ops-analytics.test.ts pins that asymmetry against the measured row for
 * exactly this reason. What this stays strict about is the RESULT being a
 * finite number, which is the property /ops depends on.
 *
 * `nan` AND `inf` ARE THE REAL CASES, not hypotheticals: `quantileWeighted`
 * over an empty window is exactly where ClickHouse-family engines emit them,
 * and whether they arrive as those literals, as JSON `null`, or as something
 * else, every spelling lands on `null` here.
 */
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A response field as an object whose keys are safe to read, or `null`.
 *
 * `finiteNumber`'S INSTINCT ONE LEVEL UP, and it exists because `typeof null`
 * is `'object'` and optional chaining does not save a dereference of a value
 * that IS null: `(null).foo` throws, and a JSON body is allowed to contain
 * `null` anywhere a reader expects an object. `readSpend` walks four levels of
 * someone else's envelope, so each level goes through this rather than through
 * a cast that TypeScript believes and the runtime does not.
 *
 * A THROW WOULD NOT BE A CRASH, AND THAT IS WHY IT HAD TO BE FIXED RATHER THAN
 * TOLERATED. src/pages/ops.astro catches it, so the page still renders -- but
 * the module's stated contract is that every failure is a `null`, and an
 * exception leaves that contract as a `TypeError` logged under a message about
 * a cache read, pointing the operator at the wrong system.
 */
function objectField(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * One `GROUP BY` query's rows as label/count pairs, or `null` if ANY row is not
 * the shape this build recognises.
 *
 * ALL OR NOTHING, rather than skipping the rows it cannot read. A dropped row
 * is the same invisible lie as a zero: the breakdown still renders, still adds
 * up to something, and nothing on the page says a line is missing. An
 * unrecognised row means the envelope is not what this build assumed, which is
 * the `null` case the whole module is built around.
 *
 * The label must be a non-empty string because it is rendered verbatim. It
 * comes from a bounded vocabulary either way -- `blob2` is
 * `Classification.agent` and `blob3` is `Classification.routeClass`, both closed
 * sets in src/lib/agent-intel/classify.ts, never raw user-agent text -- so this
 * check is about the envelope rather than about sanitising the value.
 */
function breakdownRows(
  rows: Record<string, unknown>[],
  labelField: string,
): { label: string; requests: number }[] | null {
  const parsed: { label: string; requests: number }[] = [];
  for (const row of rows) {
    const label = row[labelField];
    const requests = finiteNumber(row.requests);
    if (typeof label !== 'string' || label === '' || requests === null) return null;
    parsed.push({ label, requests });
  }
  return parsed;
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
    // THE TWO BREAKDOWNS ARE BOTH RENDERED, and that is the answer to
    // final-review Important 2 rather than a comment excusing it. They used to
    // be built and referenced nowhere outside this module and its test, which
    // meant every cache miss spent three round trips against a rate-limited
    // token to publish one query's worth of numbers -- and, because the
    // `null` check above is a conjunction, a failure in either unused query
    // blanked the three figures that WERE rendered. /ops now publishes both
    // beneath the metric grid, so all three round trips reach the page.
    //
    // THE LABELS ARE SAFE TO RENDER because neither column is free text.
    // `blob2` is `Classification.agent` -- one of the named crawlers in
    // `KNOWN_AGENTS`, or `first-party`/`http-client`/`other-bot`/`unknown` --
    // and `blob3` is `RouteClass`, three values. src/lib/agent-intel/classify.ts
    // is where both vocabularies are closed, and it reads no raw UA into either
    // one. That is what keeps /ops aggregate-and-public-tier-only (09 §2) with
    // a per-client breakdown on it.
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

  // AN EMPTY `totals` IS A NULL, NOT A ZERO. That query carries no `GROUP BY`,
  // so the engine returns exactly one row for any window, including a window
  // nothing happened in -- where the row is genuinely `0`, which is a real
  // answer and is published as one. Zero ROWS is a different event: it means
  // the response is not the shape this build assumed, and the previous
  // `totals[0] ?? {}` answered that by rendering `0` for "Requests that reached
  // the Worker" and "Requests from agents" (final-review Important 4). That is
  // the module's own headline rule inverted, in the one place it mattered most.
  //
  // The contrast with `byAgent` below is the whole point and is why these two
  // emptinesses are handled differently: those queries DO group, so zero rows
  // there means no agent requests in the window, which is a measurement.
  if (totals.length === 0) return null;

  const first = totals[0];
  const requests = finiteNumber(first.requests);
  const agentRequests = finiteNumber(first.agent_requests);
  if (requests === null || agentRequests === null) return null;

  const byAgent = breakdownRows(agents, 'agent');
  const byRouteClass = breakdownRows(routes, 'route_class');
  if (byAgent === null || byRouteClass === null) return null;

  return {
    windowDays,
    requests,
    agentRequests,
    byAgent: byAgent.map((row) => ({ agent: row.label, requests: row.requests })),
    byRouteClass: byRouteClass.map((row) => ({ routeClass: row.label, requests: row.requests })),
    // `null` RATHER THAN A FAILED READ, and it is the only field treated this
    // way. An absent or unreadable p50 is the plan's pre-agreed fallback (see
    // the SQL-dialect note at the top of this file): /ops drops the latency
    // figure and renders its absence, because it is the least valuable number
    // on the page and the only one with no second source. The two counts above
    // have no such fallback, so they fail the whole read instead.
    //
    // WHAT THIS NUMBER ACTUALLY MEASURES, AND IT IS NOT ROUND-TRIP LATENCY.
    // `double2` is `Date.now() - started` around `route()` in src/worker.ts, and
    // a Worker's `Date.now()` DOES NOT ADVANCE during synchronous execution --
    // it moves when the isolate waits on I/O. So this median is the time the
    // Worker spent waiting on something else (D1, KV, a service binding, the
    // model), not the time a reader waited for the page, and it excludes
    // network time entirely.
    //
    // THE MEASURED 0 IS THAT, NOT A FAST SITE. The 2026-09-11 probe returned
    // `p50: 0` over 1041 requests, which is what a Worker whose median request
    // renders from memory looks like -- it is structural, and a reader seeing
    // "Median response time — 0 ms" would take it for a claim about speed.
    // /ops therefore carries a note on that tile saying what the figure is; the
    // label itself overstates it and is the owner's to settle (see the task
    // report). Recorded here so nobody "fixes" a 0 that is not broken.
    p50Ms: finiteNumber(first.p50),
  };
}

const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/**
 * The query, narrowed to the three fields /ops renders.
 *
 * RECOLLECTION, NOT RECORD, and the distinction matters here more than
 * anywhere else in this file: the probe's recording holds the five RESPONSES
 * and nothing that was sent, so the field spellings below are how the query was
 * written at the time rather than a transcript. What the recording does prove
 * is that SOME query answered 200 with this dataset name, this nesting and
 * these leaf names in the body -- a strong constraint on the spelling, not a
 * copy of it. A misspelling anywhere here is a 200 with an `errors` array,
 * which `readSpend` reads as `null` and logs with the complaint in it.
 *
 * `limit: 50` IS THE VALUE THE PROBE USED AND IS DELIBERATELY NOT TIGHTENED TO
 * 1. The selection asks for no grouping dimension, so this dataset returns one
 * aggregate group per matching window -- one is what came back. A `limit: 1`
 * would make that unfalsifiable by truncating any other answer into the
 * expected shape; at 50, a response carrying more than one group is visible,
 * and `readSpend` treats it as an envelope this build does not recognise
 * rather than reading the first row and under-reporting the rest.
 */
const SPEND_QUERY = `query OpsSpend($account: String!, $gateway: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      aiGatewayRequestsAdaptiveGroups(
        limit: 50
        filter: { gateway: $gateway, datetime_geq: $since, datetime_leq: $until }
      ) {
        count
        sum { cost cachedRequests }
      }
    }
  }
}`;

/**
 * An instant in the spelling Cloudflare's GraphQL `Time` scalar takes.
 *
 * SECONDS PRECISION RATHER THAN `toISOString()`'s MILLISECONDS. The probe's
 * recording holds responses only, so what was sent here is recollection like
 * the query text; RFC 3339 to the second is the form Cloudflare's own examples
 * use and the narrower of the two spellings, so it is what this sends.
 *
 * THE FAILURE MODE HAS TWO BRANCHES AND ONLY ONE OF THEM IS SAFE, which an
 * earlier version of this note missed by stopping at the first:
 *
 *   - A LITERAL THE SCALAR REJECTS is a 200 with an `errors` array, which
 *     `readSpend` reads as `null`. Blank section, never a number, and the
 *     errors are logged with the reason in them.
 *   - A LITERAL THE SCALAR ACCEPTS BUT READS DIFFERENTLY -- a naive local time,
 *     a date-only string, an offset silently taken as UTC -- is a 200 with
 *     `errors: null` and a perfectly well-formed group in it. The window is
 *     then not the window /ops labels, and NOTHING in this module can tell:
 *     the figure is plausible, the envelope is right, and the page says 30 days
 *     under a number measured over something else.
 *
 * That second branch is why the spelling is pinned by a test rather than left
 * to `toISOString()`, and it is the strongest argument for a follow-up probe
 * that records the REQUEST beside the response: the window bound is the one
 * input here whose error is invisible.
 */
const graphqlTime = (at: Date): string => `${at.toISOString().slice(0, 19)}Z`;

/**
 * The gateway's own 30-day spend and cache-hit numbers (06 §1's "Model & cost").
 *
 * Same token, same seam, same failure contract, and the same reason for
 * publishing it at all: 06 §1 calls real cost numbers "a differentiator and a
 * great screenshot", and a cost page that rounds to a marketing number is
 * neither.
 *
 * GRAPHQL, MEASURED 2026-09-11, AND THE REST ROUTE IS RULED OUT FOR NOW. The
 * probe described at the top of this file called both possibilities with this
 * token. What the recording holds is two labelled responses:
 *
 *   - `gw:rest` ANSWERED 403 `{"success":false,"errors":[{"code":10000,
 *     "message":"Authentication error"}]}`. The label is the probe's, and the
 *     route it stands for -- `GET /accounts/{account}/ai-gateway/gateways/{id}`
 *     -- is recollection, because the recording holds no requests. So what is
 *     established is that the REST attempt was refused, and the likeliest
 *     reading is that the token's AI Gateway Read scope does not open it; a
 *     wrong path or a malformed header would look the same from here. The
 *     conclusion is the same either way and is the useful part: do not reach
 *     for REST again without new evidence, because the GraphQL route works and
 *     this one cost a round trip to be told no.
 *   - `gw:graphql` ANSWERED 200 with real numbers, from a POST to
 *     `https://api.cloudflare.com/client/v4/graphql`. That is what this reads.
 *
 * THE ENVELOPE, verbatim from that probe -- a window with traffic in it:
 *
 *   {"data":{"viewer":{"accounts":[{"aiGatewayRequestsAdaptiveGroups":
 *     [{"count":656,"sum":{"cachedRequests":0,"cost":5.202603642412313,
 *       "erroredRequests":162,"tokensIn":1877268,"tokensOut":98659}}]}]}},
 *    "errors":null}
 *
 * So `count` is requests through the gateway, `sum.cost` is DOLLARS as a JSON
 * number (5.2026... of them -- not micro-dollars, not a string, and not
 * pre-rounded), and `sum.cachedRequests` is the cache-hit count. Three fields,
 * the three figures on the page.
 *
 * WHAT THE `gateway:` FILTER COVERS, AND IT IS NOT THE WHOLE INFERENCE BILL.
 * The query filters on this account's `RLME_AI_GATEWAY_ID`, so a call is in
 * these numbers only if it passed a `gateway:` option to `env.AI.run`. Three
 * call sites do -- chat, fit and the judge (src/lib/{chat,fit,judge}/engine.ts)
 * -- and the two embedding call sites do not (src/lib/corpus.ts,
 * src/lib/mcp/search.ts). The embeddings are NOT free and are NOT off-gateway
 * in a billing sense: `env.AI.run` bills through Unified Billing either way
 * (day 1's measurement, `gatewayMetadata.keySource: "Unified"`, recorded in
 * src/lib/judge/engine.ts and src/components/ArchitectureDiagram.astro). What
 * the option buys is ATTRIBUTION in the gateway's own logs, which is exactly
 * the dataset above -- so this is the gateway's accounting for three of the
 * five inference surfaces, and /ops says so on the tile rather than letting
 * "Inference spend" imply the other two.
 *
 * `erroredRequests`, `tokensIn` AND `tokensOut` ARE NOT REQUESTED, though the
 * probe returned all three. Per-token figures are out of scope for this page
 * (09 §2 keeps it aggregate and public-tier only), and fetching a field nothing
 * renders is the exact defect this branch already fixed once for the Analytics
 * Engine breakdowns (final-review Important 2): a round trip whose result
 * nobody can see. If a later section renders them, widen `SPEND_QUERY` and
 * `GatewaySpend` together, in that order.
 *
 * A 200 IS NOT A SUCCESS HERE, which is the one way this read differs in kind
 * from the SQL one above. GraphQL answers 200 with a populated `errors` array
 * for a query error -- an unknown field, a filter key spelled wrongly, a
 * datetime the `Time` scalar rejects -- so `response.ok` is the first of two
 * gates rather than the only one. The measured success carried `"errors":null`.
 */
export async function readSpend(
  env: AnalyticsEnv,
  now: Date,
  windowDays = 30,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewaySpend | null> {
  // The same seam as `readAnalytics`, with the same two rules: 'stub' answers
  // before the secret is read or a socket is opened, and a value nobody meant
  // to set is loud rather than a page that quietly says "not configured"
  // forever. tests/workers.ts sets it for the whole harness.
  const mode = env.RLME_ANALYTICS_MODE;
  if (mode !== undefined && mode !== 'stub') {
    throw new Error(`unrecognised RLME_ANALYTICS_MODE: ${mode}`);
  }
  if (mode === 'stub') return null;

  const token = await readToken(env);
  if (token === null) return null;

  let payload: unknown;
  try {
    const response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: SPEND_QUERY,
        variables: {
          account: env.RLME_ACCOUNT_ID,
          gateway: env.RLME_AI_GATEWAY_ID,
          since: graphqlTime(new Date(now.getTime() - windowDays * 86_400_000)),
          until: graphqlTime(now),
        },
      }),
    });
    if (!response.ok) {
      console.error(`ops: the gateway query answered ${response.status}`);
      return null;
    }
    payload = await response.json();
  } catch (error) {
    console.error('ops: the gateway query failed', error);
    return null;
  }

  // EVERY LEVEL BELOW GOES THROUGH `objectField`, INCLUDING THIS ONE, and the
  // reason is that the parse runs OUTSIDE the try above -- deliberately, so
  // that a network failure and an unrecognised envelope stay two different log
  // lines, and so that no future `return null` inside the try can be mistaken
  // for a caught throw. That only works if nothing here can throw. Three
  // spellings could, before this: a body that is the JSON literal `null`, an
  // `accounts` array holding a `null`, and a groups array holding one. All
  // three are 200s, all three are things a JSON API is allowed to send, and all
  // three used to leave this module as a `TypeError` instead of as the `null`
  // its contract promises.
  const body = objectField(payload);
  if (body === null) return null;

  // GATE TWO, and the reason a status check alone would publish nonsense here.
  //
  // TWO SPELLINGS PASS: `errors: null`, which is what the probe's success
  // carried, and NO `errors` KEY AT ALL, which is what the GraphQL
  // specification says a clean response looks like. Cloudflare sends the first;
  // the second is accepted because refusing it would make this module depend on
  // a habit rather than on the protocol.
  //
  // EVERYTHING ELSE FAILS, an EMPTY ARRAY INCLUDED. `errors: []` is not a shape
  // this API was seen to produce and not one the specification sanctions, so it
  // means the response is not the one this build parses -- and the cost of
  // being wrong about that is a blank section, against publishing a figure out
  // of a half-answered query.
  const errors = body.errors;
  if (errors !== null && errors !== undefined) {
    // THE ARRAY ITSELF, not just the fact of it. This is where the one
    // unmeasured thing in this read lands -- a `Time` literal the scalar
    // rejects -- and a GraphQL error says which field or filter it disliked.
    // Query-shape complaints carry no credential and no visitor data; the
    // operator gets them in Workers observability, where the alternative is a
    // sentence saying only that something was wrong.
    console.error('ops: the gateway query answered 200 with errors', errors);
    return null;
  }

  const accounts = objectField(objectField(body.data)?.viewer)?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return null;

  const groups = objectField(accounts[0])?.aiGatewayRequestsAdaptiveGroups;

  // ZERO GROUPS IS A `null`, NOT `$0.00`. The closest thing in this module is
  // not `byAgent` but the ungrouped `totals` query above, which is also a
  // `null` on zero rows and for the same reason: nothing about an empty result
  // from an aggregate says which of "nothing happened" and "this is not the
  // answer I asked for" produced it. `byAgent` is the EXCEPTION rather than the
  // rule, and it is the exception because its emptiness is locally verifiable
  // -- the totals row beside it carries `agent_requests`, so "no agent rows"
  // can be checked against a number this build already has. There is no second
  // source here: a wrong gateway id, a filter key spelled wrongly and a window
  // boundary the `Time` scalar read differently all produce the same empty
  // array as a genuinely quiet month, and the figures it feeds are the headline
  // cost numbers on the page.
  //
  // HOW TO SETTLE IT, since it is settleable and this comment should not
  // outlive its excuse: one probe with a far-past window (say a month in 2020,
  // before the account existed) answers what an EMPTY result looks like here.
  // If that comes back as a group of zeros rather than as no group, then an
  // empty array is unambiguously "not the answer I asked for" and this stays;
  // if it comes back empty, the two cases are genuinely indistinguishable and
  // this stays for a better-documented reason. Either way, record it here.
  //
  // MORE THAN ONE GROUP IS ALSO A `null`: the query asks for no grouping
  // dimension, so one group is the whole answer, and reading `[0]` of a longer
  // list would publish a fraction of the spend as the total.
  if (!Array.isArray(groups) || groups.length !== 1) return null;

  const group = objectField(groups[0]);
  const sum = objectField(group?.sum);
  const requests = finiteNumber(group?.count);
  const costUsd = finiteNumber(sum?.cost);
  const cachedRequests = finiteNumber(sum?.cachedRequests);
  // ALL THREE OR NOTHING. Every one of them is rendered, none has a second
  // source, and there is no equivalent here of `p50Ms`'s pre-agreed fallback --
  // a spend section showing two of its three tiles would be a page inviting a
  // reader to work out which number it could not get.
  if (requests === null || costUsd === null || cachedRequests === null) return null;

  return { windowDays, costUsd, requests, cachedRequests };
}
