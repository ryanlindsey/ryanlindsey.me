import { expect, test, vi } from 'vitest';
import { rpc, type EvalsFetcher } from '../workers/mcp/src/evals-client';

// THE SSE READER, driven through `rpc` in workers/mcp/src/evals-client.ts.
// Streamable HTTP answers `tools/call` as `text/event-stream`, and this file is
// where that framing is asserted against the one reader with a live caller:
// the scheduled eval run, which reaches `/mcp` over the `SELF` binding.
//
// THIS FILE WAS tests/fit-client-sse.test.ts UNTIL #351, and drove
// src/lib/fit/client.ts's `rpc`. That reader lost its last production caller in
// #269 and was kept exported only so these cases could reach it, because it was
// the repository's only correct frame walk while `payloadOf` here still took
// the first `data:` line. #351 moved the walk into `payloadOf`, repointed these
// cases, and deleted the site's copy. The history below is why the cases have
// the shape they do.
//
// It had NO coverage at all until #37's fix -- tests/fit-client.test.ts was
// `newReportId` and nothing else -- and the cost of that was the whole feature:
// `fit_reports` held zero rows from #37 until the fix, against 28 recorded
// `analyze_fit` calls.
//
// WHAT THE OLD READER DID, because the shape of these tests follows from it:
//
//   text.startsWith('event:') || text.startsWith('data:')
//     ? text.split('\n').find((line) => line.startsWith('data:'))
//     : text
//
// Two independent defects. It decided the body was SSE by looking at the FIRST
// BYTES, and it took the FIRST `data:` line in the whole stream. Both hold for
// a response that arrives as one frame, which was every call the site made
// except one. `payloadOf` had already fixed the first and still carried the
// second until #351.
//
// MEASURED against the deployed Workers on 2026-09-18, trace
// 77c557ab4623b2fa059f29c7f75053b2: `analyze_fit` ran 78,222 ms and returned
// `outcome: 'ok'`, the site's own span shows the POST answering 200 in 81 ms
// with the body streamed behind it, and the request ended
// `mcp: unparseable response (200)` -> `unreachable`. The engine was never the
// problem; the reader was.
//
// The 15-SECOND NUMBER is not arbitrary and is the reason `tools/list` and
// `/grant` never showed this. @modelcontextprotocol/sdk arms
// `armSseKeepAlive(options.keepAliveMs ?? DEFAULT_SSE_KEEP_ALIVE_MS)` on the
// POST response stream (server/webStandardStreamableHttp.js), the default is
// 15,000 ms, and each tick writes `': keepalive\n\n'`. So any call answering in
// under 15 seconds opens `event: message` and parses; any call taking longer
// opens `: keepalive` and does not. The scheduled `fit` suite's `analyze_fit`
// crosses that line on every case.

/** One `event: message` frame, exactly as `writeSSEEvent` composes it. */
function messageFrame(message: unknown, eventId?: string): string {
  let frame = 'event: message\n';
  // Written only when the server has an event store configured, so it is
  // OPTIONAL rather than decorative -- a reader keying on line position rather
  // than on the `data:` prefix breaks the day resumability is turned on.
  if (eventId !== undefined) frame += `id: ${eventId}\n`;
  return frame + `data: ${JSON.stringify(message)}\n\n`;
}

/** The SDK's keep-alive tick: an SSE COMMENT, which carries no data at all. */
const KEEPALIVE = ': keepalive\n\n';

/** A successful `tools/call` envelope for `analyze_fit`. */
function fitResult(id: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ report: { verdict: 'strong' }, audience: 'acme', model: 'x' }),
        },
      ],
    },
  };
}

/**
 * A fetcher that answers with the frames `body` composes.
 *
 * `body` is handed the REQUEST'S OWN id and echoes it, which is what a JSON-RPC
 * server does and what the reader matches on. Written that way rather than
 * with a literal because `rpcId` in the client is module scope: it increments
 * across every call in the process, so a hard-coded id passes or fails
 * depending on which tests ran first. That is a property of the client worth
 * knowing about, and a test that depends on it is a test that lies later.
 *
 * `contentType` null sends no header at all, for the case below that needs it.
 */
function fetcherReturning(
  body: (id: unknown) => string,
  { status = 200, contentType = 'text/event-stream' as string | null } = {},
): EvalsFetcher {
  return {
    fetch: vi.fn(async (_url: unknown, init: { body: string }) => {
      const { id } = JSON.parse(init.body) as { id: unknown };
      return new Response(body(id), {
        status,
        headers: contentType === null ? {} : { 'content-type': contentType },
      });
    }),
  } as unknown as EvalsFetcher;
}

/**
 * The `tools/call` the scheduled `fit` suite makes, issued straight at `rpc`.
 *
 * The METHOD AND ARGUMENTS ARE INERT -- the fetcher is stubbed and answers the
 * same frames whatever is asked. They are the real ones anyway, because a
 * fixture that names the call it stands for is the one a reader can check
 * against the server.
 */
function toolsCall(fetcher: EvalsFetcher) {
  return rpc(
    fetcher,
    'tools/call',
    { name: 'analyze_fit', arguments: { target_description: 'a description' } },
    'token',
  );
}

test('reads the result through the keep-alive frames of a long call', async () => {
  // THE PRODUCTION FAILURE, reproduced. Five ticks is what a 78-second call
  // produced at the 15-second default; one would be enough to break the old
  // reader, and five is what was actually measured.
  const body = (id: unknown) => KEEPALIVE.repeat(5) + messageFrame(fitResult(id));

  const message = await toolsCall(fetcherReturning(body));

  expect(message.result).toBeDefined();
});

test('skips a notification frame that arrives before the response', async () => {
  // THE DEFECT #351 FIXED. This stream opens `event:`, and its first `data:`
  // line belongs to a notification carrying no `result`. The first-line reader
  // returned that notification as the answer, and the suite then scored a
  // message with no `result` -- a transport defect reading as a bad eval.
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info' },
  };
  const body = (id: unknown) => messageFrame(notification) + messageFrame(fitResult(id));

  const message = await toolsCall(fetcherReturning(body));

  expect(message.result).toBeDefined();
});

test('skips a frame answering a different id', async () => {
  // The same property from the other side: a frame carrying a `result` is not
  // the answer unless it carries this request's id.
  const body = (id: unknown) =>
    messageFrame({ jsonrpc: '2.0', id: 'someone-else', result: { stale: true } }) +
    messageFrame(fitResult(id));

  const message = await toolsCall(fetcherReturning(body));

  expect(message.result).not.toHaveProperty('stale');
  expect(message.result?.content).toBeDefined();
});

test('throws naming the status when no frame answers the id', async () => {
  // Silently taking the wrong frame would be worse than saying nothing was
  // found, and a throw is what the workflow turns into an `incomplete` row.
  const body = () => KEEPALIVE + messageFrame({ jsonrpc: '2.0', method: 'notifications/message' });

  await expect(toolsCall(fetcherReturning(body, { status: 503 }))).rejects.toThrow(
    /503.*no message answering/,
  );
});

test('reads a plain JSON body, the other response mode Streamable HTTP defines', async () => {
  // Not a new behaviour and not hypothetical: the spec lets the server answer
  // `tools/call` as `application/json`, and the reader has to keep handling
  // that now that the SSE path is a frame walk rather than a line search.
  const body = (id: unknown) => JSON.stringify(fitResult(id));

  const message = await toolsCall(fetcherReturning(body, { contentType: 'application/json' }));

  expect(message.result).toBeDefined();
});

test('reads an SSE body that arrives with no content-type header', async () => {
  // THE REGRESSION GUARD carried over from the site's reader, which sniffed
  // the first bytes and so read SSE whatever the header said. Deciding by the
  // header is right -- it is the contract rather than a guess -- but it must
  // not be the ONLY thing tried.
  const body = (id: unknown) => KEEPALIVE + messageFrame(fitResult(id));

  const message = await toolsCall(fetcherReturning(body, { contentType: null }));

  expect(message.result).toBeDefined();
});
