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
 * The JSON-RPC id. A module-level counter, as in evals/run.mjs, and it means
 * no more here than it does there: this transport is request/response, nothing
 * correlates on the id, and a workflow instance resumed in a fresh isolate
 * restarting the count is harmless for exactly that reason.
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
  const response = await fetcher.fetch(`${MCP_ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': EVALS_USER_AGENT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const text = await response.text();
  return JSON.parse(payloadOf(response, text)) as RpcResponse;
}

/**
 * The JSON body of a Streamable HTTP response, whether it arrived as JSON or as
 * one SSE frame.
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
 * Comment lines are skipped rather than parsed, which is what the SSE spec says
 * to do with them, and an absent `data:` line is a thrown error naming the
 * status rather than a `TypeError` on `undefined.slice`.
 *
 * PORTED WITH ITS COMMENT because the bug it records is the kind that comes
 * back: the scheduled `fit` suite meets a slow `analyze_fit` on exactly this
 * path, and it has no operator watching a terminal when it does.
 */
export function payloadOf(response: Response, text: string): string {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) return text;
  const data = text.split('\n').find((line) => line.startsWith('data:'));
  if (data === undefined) {
    throw new Error(
      `the endpoint answered ${response.status} with an event stream carrying no data line`,
    );
  }
  return data.slice(5).trim();
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
