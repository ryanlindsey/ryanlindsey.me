import { expect, test, vi } from 'vitest';
import { rpc, type McpClientEnv } from '../src/lib/fit/client';

// `rpc`'s SSE READER. The site talks to the MCP Worker over Streamable
// HTTP, which answers `tools/call` as `text/event-stream`, and this file is the
// only place that framing is asserted. It had NO coverage at all until now --
// tests/fit-client.test.ts is `newReportId` and nothing else -- and the cost of
// that was the whole feature: `fit_reports` held zero rows from #37 until this
// fix, against 28 recorded `analyze_fit` calls.
//
// WHAT THE OLD READER DID, because the shape of these tests follows from it:
//
//   text.startsWith('event:') || text.startsWith('data:')
//     ? text.split('\n').find((line) => line.startsWith('data:'))
//     : text
//
// Two independent defects. It decided the body was SSE by looking at the FIRST
// BYTES, and it took the FIRST `data:` line in the whole stream. Both hold for
// a response that arrives as one frame, which is every call the site makes
// except one.
//
// MEASURED against the deployed Workers on 2026-09-18, trace
// 77c557ab4623b2fa059f29c7f75053b2: `analyze_fit` ran 78,222 ms and returned
// `outcome: 'ok'`, the site's own span shows the POST answering 200 in 81 ms
// with the body streamed behind it, and the request ended
// `mcp: unparseable response (200)` -> `unreachable`. The engine was never the
// problem; this reader was.
//
// The 15-SECOND NUMBER is not arbitrary and is the reason `tools/list` and
// `/grant` never showed this. @modelcontextprotocol/sdk arms
// `armSseKeepAlive(options.keepAliveMs ?? DEFAULT_SSE_KEEP_ALIVE_MS)` on the
// POST response stream (server/webStandardStreamableHttp.js), the default is
// 15,000 ms, and each tick writes `': keepalive\n\n'`. So any call answering in
// under 15 seconds opens `event: message` and parses; any call taking longer
// opens `: keepalive` and does not. `analyze_fit` is the only call the site
// makes that crosses that line.
//
// WHAT #269 CHANGED HERE, AND WHAT IT DID NOT. These cases used to drive
// `callAnalyzeFit`, the site's `analyze_fit` caller, because that was the one
// function that reached `rpc`. #269 deleted it: `/fit/run` asks the MCP Worker
// to open a run and redirects, and `startAnalyzeFit` gets plain JSON back in
// milliseconds, so nothing the site sends today crosses the fifteen-second
// line. The cases now drive `rpc` directly, which is why the client exports
// it, and they are about the SSE READER rather than about the fit tool -- the
// tool result below is a realistic envelope and nothing more. Keeping them is
// the point: a reader that looks correct because nothing currently provokes it
// is exactly the state this file was written to end.

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
 * An `McpClientEnv` whose binding answers with the frames `body` composes.
 *
 * `body` is handed the REQUEST'S OWN id and echoes it, which is what a JSON-RPC
 * server does and what the reader now matches on. Written that way rather than
 * with a literal because `nextId` in the client is module scope: it increments
 * across every call in the process, so a hard-coded id passes or fails
 * depending on which tests ran first. That is a property of the client worth
 * knowing about, and a test that depends on it is a test that lies later.
 *
 * The service binding is the ONE thing stubbed here, and it has to be: a
 * `Fetcher` is a runtime handle with no constructor a test process can call.
 * Everything downstream of it -- the SSE framing, the JSON-RPC envelope, the
 * tool result, the parse -- is the real code under test.
 */
function envReturning(body: (id: unknown) => string, status = 200): McpClientEnv {
  return {
    MCP: {
      fetch: vi.fn(async (_url: unknown, init: { body: string }) => {
        const { id } = JSON.parse(init.body) as { id: unknown };
        return new Response(body(id), {
          status,
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    } as unknown as Fetcher,
  };
}

/**
 * The `tools/call` the site used to make, issued straight at `rpc`.
 *
 * The METHOD AND ARGUMENTS ARE INERT -- the binding is stubbed and answers the
 * same frames whatever is asked. They are the real ones anyway, because a
 * fixture that names the call it stands for is the one a reader can check
 * against the server.
 */
function toolsCall(env: McpClientEnv) {
  return rpc(env, 'token', 'tools/call', {
    name: 'analyze_fit',
    arguments: { target_description: 'a description' },
  });
}

test('reads the result through the keep-alive frames of a long call', async () => {
  // THE PRODUCTION FAILURE, reproduced. Five ticks is what a 78-second call
  // produced at the 15-second default; one would be enough to break the old
  // reader, and five is what was actually measured.
  const body = (id: unknown) => KEEPALIVE.repeat(5) + messageFrame(fitResult(id));

  const message = await toolsCall(envReturning(body));

  // `rpc` THROWS `mcp: unparseable response` when no frame answers the id, so
  // reaching a `result` at all is the assertion. That throw is what reached
  // production as `unreachable`.
  expect(message.result).toBeDefined();
});

test('skips a notification frame that arrives before the response', async () => {
  // The SECOND defect, independent of the first: this stream opens `event:`,
  // so the old reader took its SSE branch -- and then took the first `data:`
  // line, which belongs to a notification carrying no `result`. That landed on
  // `body.error || result === undefined` in `callAnalyzeFit`, which answered
  // `unreachable` and logged NOTHING. Fixing only the keep-alive prefix would
  // leave this standing.
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info' },
  };
  const body = (id: unknown) => messageFrame(notification) + messageFrame(fitResult(id));

  const message = await toolsCall(envReturning(body));

  // `rpc` THROWS `mcp: unparseable response` when no frame answers the id, so
  // reaching a `result` at all is the assertion. That throw is what reached
  // production as `unreachable`.
  expect(message.result).toBeDefined();
});

/** The same stub, but answering with no `content-type` header at all. */
function envReturningUntyped(body: (id: unknown) => string): McpClientEnv {
  return {
    MCP: {
      fetch: vi.fn(async (_url: unknown, init: { body: string }) => {
        const { id } = JSON.parse(init.body) as { id: unknown };
        return new Response(body(id), { status: 200 });
      }),
    } as unknown as Fetcher,
  };
}

test('reads a plain JSON body, the other response mode Streamable HTTP defines', async () => {
  // Not a new behaviour and not hypothetical: the spec lets the server answer
  // `tools/call` as `application/json`, and the reader has to keep handling
  // that now that the SSE path is a frame walk rather than a line search.
  const body = (id: unknown) => JSON.stringify(fitResult(id));

  const message = await toolsCall(envReturningUntyped(body));

  // `rpc` THROWS `mcp: unparseable response` when no frame answers the id, so
  // reaching a `result` at all is the assertion. That throw is what reached
  // production as `unreachable`.
  expect(message.result).toBeDefined();
});

test('reads an SSE body that arrives with no content-type header', async () => {
  // THE REGRESSION GUARD for the fix itself. The old reader sniffed the first
  // bytes, so it read SSE whatever the header said; keying on `content-type`
  // alone would lose that. Deciding by the header is right -- it is the
  // contract rather than a guess -- but it must not be the ONLY thing tried,
  // because a body that parses as neither mode is a failure worth reporting
  // and a body that parses as one of them is not.
  const body = (id: unknown) => KEEPALIVE + messageFrame(fitResult(id));

  const message = await toolsCall(envReturningUntyped(body));

  // `rpc` THROWS `mcp: unparseable response` when no frame answers the id, so
  // reaching a `result` at all is the assertion. That throw is what reached
  // production as `unreachable`.
  expect(message.result).toBeDefined();
});
