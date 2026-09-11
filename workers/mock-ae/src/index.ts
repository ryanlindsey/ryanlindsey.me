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
 * THE ASYNC SEAM THIS INTRODUCES IS WORTH NAMING. The real
 * `AnalyticsEngineDataset.writeDataPoint()` is documented as synchronous and
 * non-blocking -- `record.ts`'s own comment is explicit that it is neither
 * `await`ed nor wrapped in `ctx.waitUntil()` for exactly that reason. A
 * service-binding RPC call is NOT synchronous: it returns a Promise, and nothing
 * in `recordAgentEvent` awaits it. Measured empirically (see the fix report for
 * task 13a) rather than assumed: the call lands before the Worker under test's
 * response is fully read by the test's `fetch()`, because several `await`s
 * still separate that call from the response actually leaving the Worker.
 * That is a property of this specific route (refuse, which returns
 * synchronously after the call), not a general guarantee -- it is why this
 * mock is used for that call site and not offered as a general substitute for
 * `AE` everywhere.
 */
let points: AnalyticsEngineDataPoint[] = [];

export default class MockAnalyticsEngine extends WorkerEntrypoint {
  /** What the Worker under test calls through the `AE` binding. */
  writeDataPoint(dataPoint: AnalyticsEngineDataPoint): void {
    points.push(dataPoint);
  }

  /** Every point recorded since the last `reset()`. What the test reads back. */
  points(): AnalyticsEngineDataPoint[] {
    return points;
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
