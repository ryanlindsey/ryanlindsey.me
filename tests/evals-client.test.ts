import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { askOnce, payloadOf, rpc, type EvalsFetcher } from '../workers/mcp/src/evals-client';
import { runFitCase, runTierCase } from '../workers/mcp/src/evals-run';
import { BUNDLED_CASES } from '../workers/mcp/src/evals-cases';
import { EVALS_USER_AGENT } from '../src/lib/evals/plan';
import { TOOL_REASON_META_KEY } from '../src/lib/mcp/tool-reason';

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
 *
 * The last test in this file is a different kind: a source scan rather than a
 * call, pinning the `tier` suite's surface list against evals/run.mjs's. It is
 * here because this file is where `runTierCase` is already exercised, and its
 * own comment says what it is for and what was not done instead.
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
//
// The frame walk itself -- notifications, foreign ids, a missing header -- is
// driven through `rpc` in tests/evals-client-sse.test.ts. These pin the
// function's own contract: it returns the parsed message answering `id`.

test('payloadOf reads a plain JSON body', () => {
  const response = jsonResponse({ id: 1, ok: true });
  expect(payloadOf(response, '{"id":1,"ok":true}', 1)).toEqual({ id: 1, ok: true });
});

test('payloadOf reads the data line out of one SSE frame', () => {
  const text = 'event: message\ndata: {"id":1,"ok":true}\n\n';
  expect(payloadOf(sseResponse(text), text, 1)).toEqual({ id: 1, ok: true });
});

test('payloadOf skips an SSE comment line, which is the bug that already happened', () => {
  // The keepalive. A slow `analyze_fit` gets one, the old prefix test called
  // the body "not SSE" because it began with `:` rather than `event:`, and the
  // whole stream went to JSON.parse. evals/run.mjs records the measurement;
  // this is the assertion that keeps the port from losing the fix.
  const text = ': keepalive\n\nevent: message\ndata: {"id":1,"ok":true}\n\n';
  expect(payloadOf(sseResponse(text), text, 1)).toEqual({ id: 1, ok: true });
});

test('payloadOf throws naming the status when an event stream carries no answer', () => {
  const text = ': keepalive\n\n';
  expect(() => payloadOf(sseResponse(text, 503), text, 1)).toThrow(/503.*no message answering/);
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

// --- the user agent, which is what keeps this run out of /ops -------------

test('every request the scheduled runner makes names itself in the user agent', async () => {
  // WHY A HEADER AND NOT A FLAG. This run's calls are indistinguishable from a
  // stranger's by design -- the `tier` suite is anonymous on purpose, and the
  // `/chat` turns present a grant like any other client -- so the only thing
  // that can tell them apart downstream is what they say they are. The
  // precedent is src/pages/chat/send.ts's `ryanlindsey-me-chat/1` and
  // src/lib/fit/client.ts's `ryanlindsey-me-fit/1`, both set for the same
  // reason: so the transcript and /ops can tell one caller from another.
  //
  // WHAT DEPENDS ON IT. `recordToolCall` stores the header verbatim in
  // `mcp_tool_calls.user_agent` and `handleChat` maps it to
  // `chat_turns.surface`, and src/lib/ops/metrics.ts excludes both in SQL. A
  // request that arrives without it is published as visitor traffic.
  const stub = stubFetcher(() => jsonResponse({ result: {} }));
  await rpc(stub.fetcher, 'tools/list', {});
  await askOnce(stub.fetcher, 'a question', 'a-token');

  expect(stub.requests.length).toBe(2);
  for (const request of stub.requests) {
    expect(headerOf(request.init, 'user-agent')).toBe(EVALS_USER_AGENT);
  }
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

// --- the tier surface list, pinned across both runners --------------------

/**
 * One function's body, from its declaration to the first `}` in column zero.
 *
 * Both files are Prettier-formatted, so a closing brace at the start of a line
 * ends a top-level function in either of them. Whole-line `//` comments go
 * first, for the reason tests/evals-schedule.test.ts gives about its own scan:
 * a method name quoted in a comment must not read as a call.
 */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `no declaration matching ${declaration}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  expect(end, `the declaration ${declaration} is not terminated in column zero`).toBeGreaterThan(
    start,
  );
  return source
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * The JSON-RPC methods a body calls, in source order. `rpc(` takes its fetcher
 * first in the Worker's runner and not at all in evals/run.mjs, so the optional
 * `fetcher,` is what makes one pattern read both.
 */
function rpcSequence(body: string): string[] {
  return [...body.matchAll(/\brpc\(\s*(?:fetcher,\s*)?'([^']+)'/g)].map((match) => match[1]!);
}

test('the tier suite collects the same surfaces in both runners', async () => {
  // WHAT GOES WRONG WITHOUT THIS, and it is the failure that flatters. `tier`
  // is the private-tier invisibility gate: it asks the public tier for
  // everything it says and scans the lot for what must not be there. Add a
  // fifth surface to evals/run.mjs -- a third resource listing, a new
  // no-argument tool's output, anything -- and the scheduled runner keeps
  // checking four, reports 1/1 every single day, and nothing anywhere goes
  // red. A gate that shrinks silently is worse than one that is missing,
  // because the green row on /ops says it ran.
  //
  // SHARING THE TRANSPORT WOULD BE THE BETTER ANSWER, and it was deliberately
  // not taken here. `EvalsFetcher` is already a parameter, so `runTierCase`
  // could be the one implementation and evals/run.mjs could call it through a
  // fetcher of its own -- one sequence, and no drift left to pin. That is a
  // reshaping of the manual runner's transport at the end of a branch about to
  // become a pull request, and it carries more risk than this finding does.
  // Pinning drift structurally is what this repository does instead:
  // tests/mcp-env.test.ts regenerates a binding list and fails in both
  // directions, tests/evals-cases.test.ts pins the case bundle against the
  // directory from both ends, tests/tier-invisibility.test.ts fails if a word
  // appears in the code of three named files.
  const manual = bodyOf(await readFile('evals/run.mjs', 'utf8'), 'async function runTier()');
  const scheduled = bodyOf(
    await readFile('workers/mcp/src/evals-run.ts', 'utf8'),
    'export async function runTierCase(',
  );

  const sequence = rpcSequence(manual);
  // The one way this could go green while proving nothing: a pattern that
  // matches no call in either file.
  expect(sequence.length, 'no rpc calls found in runTier').toBeGreaterThan(0);
  expect(rpcSequence(scheduled), 'the two tier runners disagree about what they ask for').toEqual(
    sequence,
  );

  // And the filter that decides WHICH tools are called, which the method
  // sequence alone cannot see: both runners skip a tool carrying a required
  // argument, and a runner that stopped doing so would be calling a different
  // set of tools while still matching the sequence above exactly.
  const filter = '(tool.inputSchema?.required ?? []).length > 0';
  expect(manual, `evals/run.mjs no longer carries ${filter}`).toContain(filter);
  expect(scheduled, `evals-run.ts no longer carries ${filter}`).toContain(filter);
});

// --- runFitCase's refusal branch (issue #427) --------------------------------
//
// `toolUnavailable` is unit-tested in tests/evals-checks.test.ts; these pin
// the wiring, so a refusal saying no model answer exists is recorded as
// `unreached` and every other refusal stays a graded failure. The refusal is
// echoed under the request's own id, because `payloadOf` matches on it.

function refusingFetcher(meta: Record<string, unknown> | undefined): EvalsFetcher {
  return stubFetcher((_url, init) => {
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    return jsonResponse({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'The fit engine could not be reached right now.' }],
        ...(meta ? { _meta: meta } : {}),
      },
    });
  }).fetcher;
}

const FIT_CASE = { id: 'fit/strong', target_description: 'x', expect: {}, local: false };

test('runFitCase: a refusal carrying the unavailable reason is unreached, not a graded failure', async () => {
  const result = await runFitCase(
    refusingFetcher({ [TOOL_REASON_META_KEY]: 'unavailable' }),
    FIT_CASE,
    'token',
  );
  expect(result).toEqual({
    id: 'fit/strong',
    ok: false,
    notes: 'tool refused: The fit engine could not be reached right now.',
    local: false,
    unreached: true,
  });
});

test('runFitCase: a refusal without the reason stays a graded failure', async () => {
  const result = await runFitCase(refusingFetcher(undefined), FIT_CASE, 'token');
  expect(result.ok).toBe(false);
  expect(result.unreached).toBeUndefined();
  expect(result.notes).toBe('tool refused: The fit engine could not be reached right now.');
});
