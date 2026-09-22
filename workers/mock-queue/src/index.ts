import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * Test-only stand-in for the `EVENTS` queue producer binding. See
 * wrangler.jsonc in this directory for why it exists and how it is wired.
 *
 * It emulates none of Queues: no batching, no delivery, no retries, no dead
 * letter. The house rule for every mock here is to answer the one contract the
 * code under test actually uses and nothing more, and that contract is
 * `env.EVENTS.send(event)` -- one call, in three places
 * (workers/mcp/src/fit-start.ts, workers/mcp/src/chat.ts, src/worker.ts).
 * `sendBatch` is deliberately absent: nothing calls it, and a mock that
 * answers a call no caller makes is a moving part protecting nothing. So is
 * the `reset()` workers/mock-ae carries. Every producer in this system sends
 * from `ctx.waitUntil`, so a message from the previous test can land during
 * this one and clearing the array is a race; the reader below is filtered by
 * report id instead, which is the same way the audit-row case in
 * tests/fit-start.test.ts finds its own row by `grant_jti` rather than by
 * recency.
 *
 * WHAT IT IS FOR IS THE READ-BACK. A message sent under the real local
 * simulation is delivered to the site Worker's consumer and then dropped by
 * `RLME_NOTIFY_MODE: 'stub'`, so nothing a test can reach ever holds it.
 * Pointing the binding here makes the send observable, which is what lets
 * tests/fit-start.test.ts assert that a finished run notifies at all and, more
 * to the point, assert WHAT the message carries: the queue is the one surface
 * in this system whose contents are copied into an email and leave Cloudflare,
 * and src/lib/agent-intel/intent.ts's rule about carrying nothing a caller
 * typed is only enforced by something reading the message back.
 *
 * THE OVERRIDE CHANGES THE SHAPE OF THE BINDING, exactly as workers/mock-ai
 * records for `AI`: `bindingOverrides` installs a SERVICE binding, so `env.EVENTS`
 * is a `Fetcher` here rather than a `Queue`, and `send` is an RPC call rather
 * than a local enqueue. Two things follow. The message body has to survive
 * structured cloning, which every `IntentEvent` does. And the call is a real
 * round trip that returns a promise, so a producer that does not await it is
 * relying on timing -- which is why the one producer this mock was written for
 * awaits its send.
 */
const sent: unknown[] = [];

export default class MockQueue extends WorkerEntrypoint {
  /** What the Worker under test calls through the `EVENTS` binding. */
  send(body: unknown): void {
    sent.push(body);
  }

  /**
   * Every message this Worker has been sent. What the test reads back.
   *
   * A COPY rather than the live array: an RPC return is copied across the
   * boundary anyway, and a caller that held the live one would be reading a
   * list that grows under it while it asserts.
   */
  messages(): unknown[] {
    return [...sent];
  }

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    return new Response(
      `mock-queue has no HTTP routes (${request.method} ${pathname}). Call ` +
        `send/messages as RPC methods instead.\n`,
      { status: 404 },
    );
  }
}
