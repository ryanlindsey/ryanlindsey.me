import type { Classification } from './classify';

// The Analytics Engine write half of 06 §3. One datapoint per request that
// reaches a Worker, and nothing else -- no sampling of our own, no batching, no
// second store.
//
// WHAT AN AE ROW MAY CARRY, as a rule rather than as a habit: a bounded label
// from a fixed vocabulary, and nothing a person could be picked out of. No IP,
// no raw user agent, no full path, no query string, no referrer URL -- only its
// class. /ai-policy (06 §2) publishes that promise; this module and
// ./classify.ts are the two files that keep it.
//
// The blob POSITIONS are a published contract. `src/lib/ops/analytics.ts`
// queries `blob1`..`blob6` by number, because that is the only way to address
// them in the SQL API -- there are no column names on the wire. Reordering this
// array silently re-labels every historical row in every /ops query, and no
// test outside `AE_BLOB_FIELDS` below can catch it, because both sides would
// still be internally consistent. Append; never insert, never reorder.

export const AE_BLOB_FIELDS = [
  'agent_class',
  'agent',
  'route_class',
  'referrer_class',
  'surface',
  'status_class',
] as const;

/** Where the request was served: the site, the MCP endpoint, chat, /fit or /search. */
export type Surface = 'site' | 'mcp' | 'chat' | 'fit' | 'search';

export interface AgentEvent {
  classification: Classification;
  surface: Surface;
  status: number;
  durationMs: number;
}

export interface RecorderEnv {
  AE: AnalyticsEngineDataset;
}

/**
 * `2xx`/`3xx`/`4xx`/`5xx`, never the code itself.
 *
 * A raw status is not identifying, but it is unbounded in the way that matters
 * to a column store: AE indexes and blobs are cheapest when their vocabulary is
 * small and fixed, and /ops asks "how many of these failed", never "how many
 * 418s". A bucket answers the question that gets asked and keeps the legend
 * above readable.
 */
function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return 'other';
}

/**
 * One row.
 *
 * `indexes` is the agent CLASS rather than the agent NAME, and the choice is
 * about sampling rather than about reporting. Analytics Engine samples per
 * index value under load, so a high-cardinality index means each individual
 * value is sampled independently and the smallest ones get noisy first --
 * exactly the crawlers whose first appearance is the interesting event. Three
 * values keeps every bucket dense; the name is still in `blob2`, where it costs
 * nothing to group by.
 *
 * `doubles[0]` is a literal 1. Counting in this store is
 * `SUM(_sample_interval)` rather than `count()` -- the sample interval is how
 * many real events a stored row stands for -- so a stored 1 is not what /ops
 * sums. It is here as the honest per-row weight and as the thing to multiply
 * when a future query needs a weighted average.
 */
export function dataPointFor(event: AgentEvent): AnalyticsEngineDataPoint {
  const { classification: c } = event;
  return {
    indexes: [c.agentClass],
    blobs: [
      c.agentClass,
      c.agent,
      c.routeClass,
      c.referrerClass,
      event.surface,
      statusClass(event.status),
    ],
    doubles: [1, event.durationMs],
  };
}

/**
 * Writes it, and swallows its own failure after logging.
 *
 * The same trade `recordToolCall` (src/lib/mcp/audit.ts) makes, for the same
 * reason and with a weaker justification available: analytics are not the
 * service, and a request must never fail because a counter did. `writeDataPoint`
 * is documented as non-blocking, so there is no `await` here and no
 * `waitUntil` -- adding either would suggest a durability this call does not
 * have.
 */
export function recordAgentEvent(env: RecorderEnv, event: AgentEvent): void {
  try {
    env.AE.writeDataPoint(dataPointFor(event));
  } catch (error) {
    console.error('agent-intel: the datapoint could not be written', error);
  }
}

/**
 * The fields a `/search` row APPENDS to the six above, at `blob7` and at
 * `doubles[2]` and `doubles[3]` (issue #146, epic #143).
 *
 * APPENDED, NEVER INSERTED, which is the rule `AE_BLOB_FIELDS` states at the
 * top of this file and the reason this is a separate array rather than three
 * more entries in that one. `blob1` through `blob6` mean exactly what they
 * meant before on a search row too, so every /ops query keeps working over a
 * dataset that now carries one more kind of row: the sitewide p50 reads
 * `double2` and gets this request's latency, the agent breakdown reads `blob1`
 * and gets an agent class, and the route-class breakdown reads `blob3` and gets
 * a real route class. A second dataset was the alternative and was rejected for
 * that reason, since it would have split the p50 rather than widened it.
 *
 * `search_type` is the FILTER THAT WAS ASKED FOR rather than the type of any
 * result, and it is `all` when the caller passed none. Four values, which is
 * what keeps it cheap to group by.
 *
 * NOTHING HERE IS THE QUERY, and that is the whole promise this surface makes.
 * A result count, a cache flag, a latency and a closed-set filter name say how
 * the feature is performing and say nothing about who asked what. /ai-policy
 * needs no new sentence and there is no retention entry, because there is
 * nothing retained to describe.
 */
export const AE_SEARCH_BLOB_FIELDS = ['search_type'] as const;

/** `doubles[2]` and `doubles[3]`. `doubles[0]` and `doubles[1]` are unchanged. */
export const AE_SEARCH_DOUBLE_FIELDS = ['result_count', 'cache_hit'] as const;

export interface SearchEventFields {
  /** How many results the caller was handed, after the type filter. */
  results: number;
  /** Whether the answer came from KV rather than from the index. */
  cacheHit: boolean;
  /** The filter the caller asked for, or `null` for an unfiltered search. */
  type: string | null;
}

/**
 * One `/search` row: the ordinary six blobs and two doubles, plus the three
 * fields above.
 *
 * `cacheHit` becomes 1 or 0 rather than a blob, because it is a rate to average
 * rather than a label to group by. `avg(double4)` over a window is the cache's
 * hit rate, which is the question anyone asks of it.
 */
export function searchDataPointFor(
  event: AgentEvent,
  search: SearchEventFields,
): AnalyticsEngineDataPoint {
  const base = dataPointFor(event);
  return {
    ...base,
    blobs: [...(base.blobs ?? []), search.type ?? 'all'],
    doubles: [...(base.doubles ?? []), search.results, search.cacheHit ? 1 : 0],
  };
}

/**
 * Writes it, swallowing its own failure exactly as `recordAgentEvent` does and
 * for the identical reason: a search must never fail because a counter did.
 */
export function recordSearchEvent(
  env: RecorderEnv,
  event: AgentEvent,
  search: SearchEventFields,
): void {
  try {
    env.AE.writeDataPoint(searchDataPointFor(event, search));
  } catch (error) {
    console.error('agent-intel: the search datapoint could not be written', error);
  }
}
