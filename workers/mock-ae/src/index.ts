import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Test-only stand-in for the Analytics Engine binding. See wrangler.jsonc in
 * this directory for why it exists and how it is wired.
 *
 * It does NOT emulate Analytics Engine's storage or its query API -- that is a
 * hosted SQL service this repo has no local equivalent for, the same reason
 * mock-browser does not speak CDP. It answers the one contract
 * `src/lib/agent-intel/record.ts`'s `recordAgentEvent` uses:
 * `AnalyticsEngineDataset.writeDataPoint()`. Unlike mock-ai and mock-browser,
 * that contract is a plain method call rather than an HTTP request, so this
 * Worker is reached two different ways for two different purposes:
 *
 *   1. THE WORKER UNDER TEST calls `env.AE.writeDataPoint(point)` through the
 *      `AE` binding, which `bindingOverrides: { AE: 'mock-ae' }` points here.
 *      Cloudflare's service-binding RPC turns that into a call to
 *      `writeDataPoint` below.
 *   2. THE TEST calls `points()`/`reset()` directly on this SAME named worker
 *      (`server.getWorker('mock-ae').getExport()`, exactly as
 *      tests/resume-pdf.test.ts already calls `lastRenderUrl()`/`reset()` on
 *      mock-browser) to read back what path 1 wrote.
 *
 * Both paths reach the same running instance of this Worker, so the
 * module-scope array below is shared between them without any transport of
 * its own.
 *
 * MEASURED TO LAND IN TIME, NOT GUARANTEED TO. The real
 * `AnalyticsEngineDataset.writeDataPoint()` is documented as synchronous and
 * non-blocking -- `record.ts`'s own comment is explicit that it is neither
 * `await`ed nor wrapped in `ctx.waitUntil()` for exactly that reason. A
 * service-binding RPC call is NOT synchronous: it returns a Promise, and
 * nothing in `recordAgentEvent` awaits it. The call reliably lands before the
 * Worker under test's response is fully read by the test's `fetch()`, but
 * that is a MEASUREMENT (repeated runs, recorded in the fix report for task
 * 13a) rather than a mechanism this file can point to and trust. An earlier
 * version of this comment claimed "several `await`s" separate the call from
 * the response leaving the Worker; that overstated the margin -- it is one or
 * two microtask hops, not several real `await`s -- and is corrected here
 * because a claimed mechanism invites a future reader to trust it past the
 * point it was ever load-bearing (task-13a-findings-final.md item 6). If a
 * future route reaches this seam through a longer async path, measure again
 * before trusting it there; tests/chat-endpoint.test.ts's `vi.waitFor` around
 * the one call site that uses this mock is the belt to this comment's braces.
 */
let points: AnalyticsEngineDataPoint[] = [];

const encoder = new TextEncoder();

/** Analytics Engine's own published limits, all four enforced below. */
const MAX_BLOBS = 20;
const MAX_DOUBLES = 20;
const MAX_INDEXES = 1;
const MAX_INDEX_BYTES = 96;
const MAX_BLOBS_BYTES = 5120;

/**
 * Throws on anything the real binding would refuse -- task-13a-findings-final.md
 * item 5. Without this the double validated NOTHING, so it could report
 * success where the real binding would not: `dataPointFor`
 * (src/lib/agent-intel/record.ts) emits 6 blobs, 2 doubles and 1 index today,
 * comfortably inside every limit below, but `AE_BLOB_FIELDS`'s own contract is
 * explicitly APPEND -- a future task that appends past one of these caps would
 * go green here and fail in production. This mock exists specifically to stop
 * a silently-green AE path; leaving its own limits unenforced was the one gap
 * in that.
 */
function assertWithinLimits(dataPoint: AnalyticsEngineDataPoint): void {
  const blobs = dataPoint.blobs ?? [];
  const doubles = dataPoint.doubles ?? [];
  const indexes = dataPoint.indexes ?? [];
  if (blobs.length > MAX_BLOBS) {
    throw new Error(
      `mock-ae: ${blobs.length} blobs exceeds the real binding's cap of ${MAX_BLOBS}`,
    );
  }
  if (doubles.length > MAX_DOUBLES) {
    throw new Error(
      `mock-ae: ${doubles.length} doubles exceeds the real binding's cap of ${MAX_DOUBLES}`,
    );
  }
  if (indexes.length > MAX_INDEXES) {
    throw new Error(
      `mock-ae: ${indexes.length} indexes exceeds the real binding's cap of ${MAX_INDEXES}`,
    );
  }
  for (const index of indexes) {
    const bytes = encoder.encode(String(index)).length;
    if (bytes > MAX_INDEX_BYTES) {
      throw new Error(
        `mock-ae: an index of ${bytes} bytes exceeds the real binding's cap of ${MAX_INDEX_BYTES}`,
      );
    }
  }
  const blobBytes = blobs.reduce((total, blob) => total + encoder.encode(String(blob)).length, 0);
  if (blobBytes > MAX_BLOBS_BYTES) {
    throw new Error(
      `mock-ae: ${blobBytes} bytes of blobs exceeds the real binding's cap of ${MAX_BLOBS_BYTES}`,
    );
  }
}

export default class MockAnalyticsEngine extends WorkerEntrypoint {
  /** What the Worker under test calls through the `AE` binding. */
  writeDataPoint(dataPoint: AnalyticsEngineDataPoint): void {
    assertWithinLimits(dataPoint);
    points.push(dataPoint);
  }

  /**
   * Every point recorded since the last `reset()`. What the test reads back.
   *
   * A COPY, not the live array (task-13a-findings-final.md item 10): the live
   * array returned directly meant a reference a test held onto silently went
   * stale the moment `reset()` next ran, because `reset()` reassigns the
   * module binding rather than truncating the array in place. Copying here
   * makes every call's result independent of whatever happens to `points`
   * afterward, which is the property a caller actually wants from a "what has
   * been recorded" read.
   */
  points(): AnalyticsEngineDataPoint[] {
    return [...points];
  }

  /** Returns to first-boot state so one test cannot leak into the next. */
  reset(): void {
    points = [];
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    return new Response(
      `mock-ae has no HTTP routes (${request.method} ${pathname}). Call ` +
        `writeDataPoint/points/reset as RPC methods instead.\n`,
      { status: 404 },
    );
  }
}
