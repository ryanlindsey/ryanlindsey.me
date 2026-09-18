import { expect, test } from 'vitest';
import { payloadOf, rpc, type EvalsFetcher } from '../workers/mcp/src/evals-client';
import { runTierCase } from '../workers/mcp/src/evals-run';
import { BUNDLED_CASES } from '../workers/mcp/src/evals-cases';

/**
 * The transport half of the scheduled runner (issue #291, task 4), which is
 * the part of it a test can reach.
 *
 * WHAT IS BEING TESTED AND WHY IT IS ONLY THIS. `evals-client.ts` is a port of
 * evals/run.mjs's `rpc`, `payloadOf`, `askOnce`, `ask` and `askJudge`, and
 * nothing downstream of a model call can run under this harness at all -- `AI`
 * is a service Worker here, so `env.AI.run()` is a TypeError, and the three
 * engine seams are off. What IS reachable is the shape of the request the
 * runner sends and the parse of the response it gets back, because both take
 * their fetcher as an argument rather than reading a binding. That is what the
 * injected `EvalsFetcher` is for.
 *
 * So these are characterization tests over a port: they pin the two properties
 * a careless edit would lose -- the keepalive parse, which is a bug that has
 * already happened once, and the `tier` suite's anonymity, which is the whole
 * meaning of that suite.
 */

/** A response built the way the Streamable HTTP transport builds one. */
const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const sseResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });

/** Records every request it is handed and answers from a queue of responses. */
function stubFetcher(answer: (url: string, init?: RequestInit) => Response): {
  fetcher: EvalsFetcher;
  requests: { url: string; init?: RequestInit }[];
} {
  const requests: { url: string; init?: RequestInit }[] = [];
  return {
    requests,
    fetcher: {
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        return Promise.resolve(answer(url, init));
      }) as EvalsFetcher['fetch'],
    },
  };
}

// --- payloadOf ------------------------------------------------------------

test('payloadOf returns a plain JSON body untouched', () => {
  const response = jsonResponse({ ok: true });
  expect(payloadOf(response, '{"ok":true}')).toBe('{"ok":true}');
});

test('payloadOf reads the data line out of one SSE frame', () => {
  const response = sseResponse('event: message\ndata: {"ok":true}\n\n');
  expect(payloadOf(response, 'event: message\ndata: {"ok":true}\n\n')).toBe('{"ok":true}');
});

test('payloadOf skips an SSE comment line, which is the bug that already happened', () => {
  // The keepalive. A slow `analyze_fit` gets one, the old prefix test called
  // the body "not SSE" because it began with `:` rather than `event:`, and the
  // whole stream went to JSON.parse. evals/run.mjs records the measurement;
  // this is the assertion that keeps the port from losing the fix.
  const text = ': keepalive\n\nevent: message\ndata: {"ok":true}\n\n';
  expect(payloadOf(sseResponse(text), text)).toBe('{"ok":true}');
});

test('payloadOf throws naming the status when an event stream carries no data line', () => {
  const text = ': keepalive\n\n';
  expect(() => payloadOf(sseResponse(text, 503), text)).toThrow(/503.*no data line/);
});

// --- the bearer, present and absent --------------------------------------

const headerOf = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name];

test('rpc presents a bearer when it is given one, and none when it is not', async () => {
  const stub = stubFetcher(() => jsonResponse({ result: {} }));
  await rpc(stub.fetcher, 'tools/list', {});
  await rpc(stub.fetcher, 'tools/list', {}, 'a-token');

  expect(headerOf(stub.requests[0]!.init, 'authorization')).toBeUndefined();
  expect(headerOf(stub.requests[1]!.init, 'authorization')).toBe('Bearer a-token');
  // Both go to this Worker's own origin rather than to a derived one.
  expect(stub.requests.map((request) => request.url)).toEqual([
    'https://mcp.ryanlindsey.me/mcp',
    'https://mcp.ryanlindsey.me/mcp',
  ]);
});

test('runTierCase presents no bearer on any call it makes', async () => {
  // THE WHOLE SUITE. `tier` asserts what an ANONYMOUS caller can see -- that a
  // gated tool is not listed and that no public surface says what the private
  // tier exists to keep unsaid. A bearer on any of these calls would make
  // every assertion in it pass for the wrong reason, and nothing about the
  // code's shape would look wrong.
  const stub = stubFetcher(() =>
    jsonResponse({
      result: {
        tools: [{ name: 'get_contact' }, { name: 'get_post', inputSchema: { required: ['slug'] } }],
        instructions: 'Published writing, case studies and a resume.',
      },
    }),
  );

  const result = await runTierCase(stub.fetcher, BUNDLED_CASES.tier[0]!);

  expect(result.ok, result.notes).toBe(true);
  expect(stub.requests.length).toBeGreaterThan(0);
  for (const request of stub.requests) {
    expect(headerOf(request.init, 'authorization')).toBeUndefined();
  }
  // And it called the no-argument tool while skipping the one with a required
  // argument, which is what makes `surfaces` the public tier's whole output.
  const called = stub.requests
    .map(
      (request) => JSON.parse(String(request.init?.body)) as { method: string; params?: unknown },
    )
    .filter((body) => body.method === 'tools/call')
    .map((body) => (body.params as { name: string }).name);
  expect(called).toEqual(['get_contact']);
});
