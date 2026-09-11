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

/** Where the request was served: the site, the MCP endpoint, chat, or /fit. */
export type Surface = 'site' | 'mcp' | 'chat' | 'fit';

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
