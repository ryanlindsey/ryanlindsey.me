// The eval runner's transport (issue #291), ported from evals/run.mjs's `rpc`,
// `payloadOf`, `askOnce`, `ask` and `askJudge`.
//
// THE TRANSPORT IS ALL THAT IS PORTED. The judging lives in
// src/lib/evals/checks.ts and is shared with the manual runner rather than
// copied, which is the property the whole scheduled design rests on: two
// runners that agree because they call one function, not because two people
// kept two copies in step.
//
// IT TAKES ITS FETCHER AS AN ARGUMENT rather than reading a binding, so the
// caller decides what it is talking to. On the deployed path that is
// `env.SELF`, a service binding from this Worker to itself -- see
// workers/mcp/wrangler.jsonc for the measurement that chose it over a global
// fetch to this Worker's own custom domain, and workers/mcp/src/index.ts for
// the 522 that an unmeasured same-hostname fetch cost in issue #28.
//
// EVERY REQUEST IT MAKES NAMES ITSELF, and that is not cosmetic. These calls
// are deliberately indistinguishable from a stranger's to everything that
// decides what they may do -- `tier` is anonymous because that is what it
// asserts, and the rest present a grant like any other client -- so the
// `user-agent` is the only thing left that can tell them apart afterwards.
// `recordToolCall` stores it, `handleChat` maps it to a `chat_turns.surface`,
// and src/lib/ops/metrics.ts excludes both in SQL so a public page does not
// publish this Worker's own housekeeping as visitor traffic. The constant and
// the full reasoning are in src/lib/evals/plan.ts.

import { BACKOFF_MS, EVALS_USER_AGENT, RETRIES } from '../../../src/lib/evals/plan';
import { MCP_ORIGIN } from './origin';

/**
 * What the transport needs of a service binding: one method. The same
 * narrowing `DocumentsEnv.SITE`'s consumers apply in src/lib/mcp/documents.ts,
 * and for the same reason -- a parameter that names only what it calls can be
 * satisfied by a stub without impersonating a whole `Fetcher`.
 */
export type EvalsFetcher = Pick<Fetcher, 'fetch'>;

/**
 * The fields of a JSON-RPC response these suites read. Deliberately narrow: a
 * wider type would be a second, undocumented copy of the MCP result schema
 * living in a runner.
 */
export interface RpcToolDescriptor {
  name: string;
  inputSchema?: { required?: string[] };
}

export interface RpcResponse {
  result?: {
    tools?: RpcToolDescriptor[];
    instructions?: string;
    isError?: boolean;
    content?: { text?: string }[];
    [key: string]: unknown;
  };
  error?: { code?: number; message?: string };
}

/** One chat turn's frames, as `chatProblems` and `leakProblems` expect them. */
export interface ChatAnswer {
  sources: unknown[];
  answer: string;
  cited: unknown[];
  error: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The JSON-RPC id. A module-level counter, as in evals/run.mjs, and a workflow
 * instance resumed in a fresh isolate restarting the count is harmless: the id
 * only has to tell this request's answer apart from the other frames in its
 * own response stream, never from another request's.
 *
 * THAT IS A CORRECTION. This comment used to say nothing correlates on the id,
 * which was true and was the defect: `payloadOf` took the first `data:` line
 * in the stream, so a notification frame ahead of the answer was returned as
 * the answer (#351). It matches on the id now.
 */
let rpcId = 1;

/**
 * One JSON-RPC call against `/mcp`. `token` is optional, and its absence is
 * meaningful rather than a shortcut: the `tier` suite calls ANONYMOUSLY,
 * because what it asserts is what an unauthenticated caller can see.
 */
export async function rpc(
  fetcher: EvalsFetcher,
  method: string,
  params: Record<string, unknown>,
  token?: string,
): Promise<RpcResponse> {
  // HOISTED out of the body below, because the response has to be matched
  // against it: an SSE stream may carry frames that are not the answer to this
  // call, and `id` is the only thing that tells them apart.
  const id = rpcId++;
  const response = await fetcher.fetch(`${MCP_ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': EVALS_USER_AGENT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  return payloadOf(response, text, id);
}

/**
 * The JSON-RPC message answering `id`, whether the response arrived as JSON or
 * as an SSE stream.
 *
 * DECIDED BY CONTENT-TYPE, not by what the first line happens to be. The version
 * this replaces tested `text.startsWith('event:') || text.startsWith('data:')`,
 * which is true for every fast response and false for a slow one: SSE allows a
 * COMMENT line -- anything beginning with `:` -- and the transport sends
 * `: keepalive` to hold the connection open. `analyze_fit` is an Opus call over
 * the whole corpus and is slow enough to get one, so the body arrived as
 * `: keepalive\n\nevent: message\ndata: {...}`, the prefix test said "not SSE",
 * and the whole stream went to `JSON.parse`:
 *
 *   SyntaxError: Unexpected token ':', ": keepaliv"... is not valid JSON
 *
 * Nothing had ever exercised it. `tier` needs no token and answers fast enough
 * that no heartbeat is sent; `fit` needs one, and no token existed until the
 * signing-key bug in scripts/token.mjs was fixed -- so the first real `fit` run
 * in this repo's history was also the first thing to meet a keepalive.
 *
 * A REAL FRAME WALK rather than a line search, since #351, and that is the
 * other half of the same lesson. Two frame types break a reader that takes the
 * first `data:` line in the stream, and the version this replaces was guarded
 * against only the first:
 *
 * KEEP-ALIVES. @modelcontextprotocol/sdk arms
 * `armSseKeepAlive(options.keepAliveMs ?? DEFAULT_SSE_KEEP_ALIVE_MS)` on the
 * POST response stream (server/webStandardStreamableHttp.js), the default is
 * 15,000 ms, and each tick writes `': keepalive\n\n'` -- an SSE COMMENT, which
 * is the one frame type carrying no `data:` at all.
 *
 * NOTIFICATIONS. A frame before the response is still `event: message` with a
 * `data:` line, so a reader taking the first one gets a message with no
 * `result`. Matching on `id` is what makes that frame skippable rather than
 * fatal. The site's `/fit` client learned this at a measured cost:
 * `fit_reports` held ZERO rows from #37 until its fix, against 28 recorded
 * `analyze_fit` calls, while the engine itself was working -- trace
 * 77c557ab4623b2fa059f29c7f75053b2 on 2026-09-18 ran 78,222 ms, recorded
 * `outcome: 'ok'`, and ended `mcp: unparseable response (200)` on the reading
 * side. Here nobody would have been watching: a notification ahead of the
 * answer reads as a bad eval in `eval_runs` rather than as a transport defect.
 *
 * MOVED HERE FROM src/lib/fit/client.ts IN #351, where it had had no
 * production caller since #269 and was exported only so a test could reach it.
 * This is now the repository's one frame walk, and
 * tests/evals-client-sse.test.ts drives it.
 *
 * A frame carrying no `data:` line, or one whose data is not JSON, is SKIPPED
 * rather than refused: a comment is a legal frame and an unparseable one is not
 * ours to fail on. A stream with no frame answering `id` is a thrown error
 * naming the status -- silently taking the wrong frame would be worse than
 * saying nothing was found, and a throw is what `run()` turns into an
 * `incomplete` row (workers/mcp/src/evals-workflow.ts). An SSE error frame
 * carrying `id: null` is skipped too, so it surfaces as that throw rather than
 * as its own message; the row is the same either way.
 *
 * A JSON BODY IS NOT MATCHED ON `id`, deliberately. That mode carries exactly
 * one message, and a transport-level refusal -- a 401, a bad session -- comes
 * back as JSON with `id: null` and belongs in front of the caller rather than
 * behind a "no message answering" throw.
 *
 * THE CONTENT TYPE PICKS THE ORDER, not the only attempt. Streamable HTTP
 * defines exactly two response modes and names the one it used in this header,
 * so reading it is reading the contract rather than sniffing the first bytes.
 * Both are still tried, which the site's reader did as a regression guard: its
 * predecessor decided by content alone and so read SSE whatever the header
 * said. The two modes cannot be confused for each other -- an SSE body is never
 * valid JSON, and a JSON body has no frames -- so trying the second costs
 * nothing but the call.
 *
 * PORTED WITH ITS COMMENT because the bug it records is the kind that comes
 * back: the scheduled `fit` suite meets a slow `analyze_fit` on exactly this
 * path, and it has no operator watching a terminal when it does.
 */
export function payloadOf(response: Response, text: string, id: number): RpcResponse {
  const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const message = sse
    ? (sseMessage(text, id) ?? parseJson(text))
    : (parseJson(text) ?? sseMessage(text, id));
  if (message === null) {
    throw new Error(
      `the endpoint answered ${response.status} with no message answering request ${id}`,
    );
  }
  return message;
}

/** The SSE frame whose JSON-RPC message carries `id`, or `null`. */
function sseMessage(text: string, id: number): RpcResponse | null {
  // Frames are separated by a blank line, and a frame's `data:` lines are
  // joined with newlines -- both per the SSE grammar rather than per what this
  // server happens to emit today, because the reader is the half that has to
  // survive the server changing.
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (data === '') continue;
    const message = parseJson(data);
    if (message !== null && (message as { id?: unknown }).id === id) return message;
  }
  return null;
}

/** The whole body as one JSON-RPC message, or `null` if it is not JSON. */
function parseJson(text: string): RpcResponse | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as RpcResponse) : null;
  } catch {
    return null;
  }
}

/** Codes worth retrying: the endpoint could not reach the model, for now. */
const TRANSIENT = new Set(['unreachable']);

/**
 * Reads one chat turn off the wire, returning the frames the contract defines.
 *
 * THE TOKEN IS MANDATORY HERE, unlike in the `tier` suite where its absence is
 * the point: `POST /chat` admits a Turnstile response or an `evals` grant and
 * nothing else, and no runner can solve a challenge. The scheduled runner
 * always holds a grant, which is why the skip branches evals/run.mjs carries
 * for a missing `RLME_EVAL_TOKEN` have no counterpart here.
 *
 * `error` may arrive INSTEAD of `sources` (a guard refused) or AFTER deltas
 * (the upstream stream broke mid-answer). Both are collected; the caller
 * decides which matters.
 */
export async function askOnce(
  fetcher: EvalsFetcher,
  question: string,
  token: string,
): Promise<ChatAnswer> {
  const response = await fetcher.fetch(`${MCP_ORIGIN}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': EVALS_USER_AGENT,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question }),
  });
  const text = await response.text();
  let sources: unknown[] = [];
  let answer = '';
  let error: string | null = null;
  let cited: unknown[] = [];
  for (const frame of text.split('\n\n').filter(Boolean)) {
    const name = frame.match(/^event: (.+)$/m)?.[1];
    let data: { sources?: unknown[]; text?: string; cited?: unknown[]; code?: string } = {};
    try {
      data = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? '{}');
    } catch {
      continue;
    }
    if (name === 'sources') sources = data.sources ?? [];
    else if (name === 'delta') answer += data.text ?? '';
    else if (name === 'done') cited = data.cited ?? [];
    // `?? null` here and in evals/run.mjs's `askOnce`, moved together rather
    // than one side quietly differing -- see that function for why, and for
    // what the two used to report about one error frame with no `code`.
    else if (name === 'error') error = data.code ?? null;
  }
  return { sources, answer, cited, error };
}

/**
 * One chat turn, retried past a transient refusal.
 *
 * The LAST attempt's result is returned whatever it says, so a case that is
 * genuinely refused still reports the code rather than a retry count -- the
 * suite's job is to say what happened, and "unreachable after 3 attempts" is a
 * different and more useful fact than "unreachable".
 *
 * THIS BACKOFF IS A `setTimeout` AND THE PACING IS NOT, and the difference is
 * deliberate. The wait belongs to one attempt inside one case's `step.do`; the
 * twenty-five seconds between cases is the workflow's own `step.sleep`, which
 * suspends the instance instead of holding an invocation open. See
 * workers/mcp/src/evals-workflow.ts.
 */
export async function ask(
  fetcher: EvalsFetcher,
  question: string,
  token: string,
): Promise<ChatAnswer> {
  let result = await askOnce(fetcher, question, token);
  for (
    let attempt = 1;
    attempt <= RETRIES && result.error !== null && TRANSIENT.has(result.error);
    attempt += 1
  ) {
    await sleep(BACKOFF_MS * attempt);
    result = await askOnce(fetcher, question, token);
  }
  return result;
}

/** What `judge_answer` returns, and what `judgeProblems` scores. */
export interface JudgeVerdict {
  verdict: string;
  score: number;
  reasons: string[];
}

/**
 * Scores `subject` against `criteria` through the gated judge tool.
 *
 * A thrown judge is NOT a failed case: `JudgeUnavailable` means the scorer did
 * not run, and reporting that as a red case sends somebody after a prompt
 * regression that never happened. It returns null and the caller records the
 * case as unjudged -- `judgeProblems` (src/lib/evals/checks.ts) is what turns
 * that into the one problem it deserves.
 */
export async function askJudge(
  fetcher: EvalsFetcher,
  criteria: string,
  subject: string,
  token: string,
): Promise<JudgeVerdict | null> {
  const call = () =>
    rpc(fetcher, 'tools/call', { name: 'judge_answer', arguments: { criteria, subject } }, token);
  let answer = await call();
  // Retried for the same reason `ask` is: `judge_answer` spends a model call
  // through the same gateway, in the same burst, and a rate-limited judge
  // reports "the judge did not run" -- which reads like a broken tool rather
  // than a busy minute.
  for (
    let attempt = 1;
    attempt <= RETRIES && Boolean(answer.error || answer.result?.isError);
    attempt += 1
  ) {
    await sleep(BACKOFF_MS * attempt);
    answer = await call();
  }
  if (answer.error || answer.result?.isError) return null;
  try {
    return JSON.parse(answer.result?.content?.[0]?.text ?? '') as JudgeVerdict;
  } catch {
    return null;
  }
}
