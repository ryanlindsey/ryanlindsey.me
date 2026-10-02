// The fit suite's call sequence under the asynchronous `analyze_fit` (issue
// #490), as a function of a transport rather than of either runner.
//
// `analyze_fit` used to hold the connection for the whole Opus run and answer
// with the report. It now answers at once with a pending envelope, and
// `get_fit_report` is what returns the report: it long-polls and answers
// either the report or the same envelope again. Both runners -- the scheduled
// one over `SELF` (workers/mcp/src/evals-run.ts) and the owner-run one over
// the deployed endpoint (evals/run.mjs) -- follow that protocol, so what a
// response MEANS lives here and each runner keeps only its own transport.
// Judging is not here: the caller still grades the ok payload with
// `fitProblems`.

import { toolUnavailable } from './checks';

/**
 * How long one case may take from the `analyze_fit` call to a finished report.
 *
 * A run measured 59 to 104 s with a tail to 135 s on Opus 5 (issue #490), so
 * five minutes is more than twice the worst seen. It bounds a run that never
 * closes: `get_fit_report` already answers a failure for a stale row, so
 * reaching this means the server kept saying "pending" and that is a failed
 * case, not an unreached one. One `get_fit_report` call can run a further
 * `FIT_REPORT_WAIT_MS` past it, because the check is between calls.
 */
export const FIT_CASE_DEADLINE_MS = 5 * 60 * 1000;

/** The fields of a JSON-RPC answer this reads; the runners' own response types satisfy it. */
export interface FitToolAnswer {
  result?: {
    isError?: boolean;
    _meta?: Record<string, unknown>;
    content?: { text?: string }[];
    [key: string]: unknown;
  };
  error?: { message?: string };
}

export type FitCall = (name: string, args: Record<string, unknown>) => Promise<FitToolAnswer>;

export type FitOutcome =
  /** A finished report envelope, still to be parsed against the schema and graded. */
  | { kind: 'ok'; payload: { report?: unknown; citations_dropped?: number } }
  /** The tool refused. `unavailable` is `toolUnavailable`: no model answer exists, so unreached. */
  | { kind: 'refused'; unavailable: boolean; text: string }
  /** The run never closed within the deadline. A graded failure. */
  | { kind: 'timeout'; reportId: string }
  /** A response this protocol does not define. A graded failure. */
  | { kind: 'malformed'; text: string };

/**
 * Runs one case's calls: `analyze_fit`, then `get_fit_report` until the answer
 * is not pending, under `FIT_CASE_DEADLINE_MS`.
 *
 * NO SLEEP BETWEEN POLLS. `get_fit_report` holds the call for up to
 * `FIT_REPORT_WAIT_MS` itself, so the loop is paced by the server and a
 * client-side wait would only add latency.
 */
export async function collectFitReport(
  callTool: FitCall,
  targetDescription: string,
  options: { now?: () => number; deadlineMs?: number } = {},
): Promise<FitOutcome> {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? FIT_CASE_DEADLINE_MS;
  const started = now();

  let answer = await callTool('analyze_fit', { target_description: targetDescription });
  for (;;) {
    const step = classify(answer);
    if (step.kind !== 'pending') return step;
    if (now() - started >= deadlineMs) return { kind: 'timeout', reportId: step.reportId };
    answer = await callTool('get_fit_report', { report_id: step.reportId });
  }
}

type Step = FitOutcome | { kind: 'pending'; reportId: string };

function classify(answer: FitToolAnswer): Step {
  if (answer.result?.isError) {
    return {
      kind: 'refused',
      unavailable: toolUnavailable(answer),
      text: answer.result.content?.[0]?.text ?? '',
    };
  }
  if (!answer.result) {
    return { kind: 'refused', unavailable: false, text: answer.error?.message ?? '' };
  }

  let payload: { status?: unknown; report_id?: unknown; report?: unknown };
  try {
    payload = JSON.parse(answer.result.content?.[0]?.text ?? '') as typeof payload;
  } catch {
    return { kind: 'malformed', text: 'the tool did not return JSON' };
  }

  if (payload.status === 'ok') return { kind: 'ok', payload };
  if (payload.status === 'pending') {
    return typeof payload.report_id === 'string' && payload.report_id !== ''
      ? { kind: 'pending', reportId: payload.report_id }
      : { kind: 'malformed', text: 'the pending answer carried no report_id' };
  }
  return {
    kind: 'malformed',
    text: `the tool answered an unknown status: ${String(payload.status)}`,
  };
}
