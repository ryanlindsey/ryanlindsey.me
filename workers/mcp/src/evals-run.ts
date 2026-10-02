// The four suites, one case at a time (issue #291). Transport from
// ./evals-client.ts, judgment from src/lib/evals/checks.ts, case shape from
// src/lib/evals/record.ts -- this module is the wiring between them and holds
// no comparison of its own.
//
// ONE CASE PER CALL, which is the difference from evals/run.mjs's `runTier`,
// `runFit`, `runChat` and `runLeak`. Those functions loop and pace; these do
// neither, because the workflow drives the loop (one `step.do` per case, so a
// resumed instance replays the cases it already finished rather than re-paying
// for them) and owns the pacing (a real ninety-second wait belongs in a
// `step.sleep`, which suspends the instance, not in a `setTimeout`, which
// holds an invocation open). See ./evals-pace.ts.
//
// A JUDGED CASE IS TWO CALLS since issue #448: `answerChatCase` or
// `answerLeakProbe` for the answer, then `judgeCase` in a step of its own a
// full pace later.
//
// THE TOKEN-SKIP BRANCHES ARE GONE, not forgotten: evals/run.mjs skips `fit`,
// `chat` and `leak` loudly when `RLME_EVAL_TOKEN` is unset in the operator's
// shell, and the scheduled runner mints its own grant, so there is no state
// here in which a suite has no token. The equivalent failure -- a mint that
// did not work -- writes an `incomplete` row from the workflow instead.

import {
  chatProblems,
  fitProblems,
  judgeProblems,
  leakProblems,
  reachedNoModel,
  tierProblems,
} from '../../../src/lib/evals/checks';
import type {
  ChatCase,
  FitCase,
  LeakCase,
  LoadedCase,
  TierCase,
} from '../../../src/lib/evals/cases';
import { FIT_CASE_DEADLINE_MS, collectFitReport } from '../../../src/lib/evals/fit-poll';
import { fail, pass, unreached, type CaseResult } from '../../../src/lib/evals/record';
import { FitReport } from '../../../src/lib/fit/schema';
import { ask, askJudge, rpc, type EvalsFetcher } from './evals-client';

/**
 * `tier`: what an ANONYMOUS caller can see.
 *
 * It takes no token, and that is the whole suite. Every other runner here
 * presents the scheduled grant; this one deliberately presents nothing,
 * because what it asserts is that a gated tool is not listed and that no
 * public surface says something the private tier exists to keep unsaid. A
 * bearer added to these calls would make every assertion here pass for the
 * wrong reason.
 */
export async function runTierCase(
  fetcher: EvalsFetcher,
  testCase: LoadedCase<TierCase>,
): Promise<CaseResult> {
  const listed = await rpc(fetcher, 'tools/list', {});
  const tools = listed.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);

  // Everything the public tier says, in one string: the handshake's
  // instructions, the tool metadata, the resource listings, and the output of
  // every tool that takes no required argument.
  const init = await rpc(fetcher, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'rlme-evals', version: '1' },
  });
  const surfaces = [init.result?.instructions ?? '', JSON.stringify(listed.result ?? {})];
  surfaces.push(JSON.stringify((await rpc(fetcher, 'resources/list', {})).result ?? {}));
  surfaces.push(JSON.stringify((await rpc(fetcher, 'resources/templates/list', {})).result ?? {}));
  for (const tool of tools) {
    if ((tool.inputSchema?.required ?? []).length > 0) continue;
    surfaces.push(
      JSON.stringify((await rpc(fetcher, 'tools/call', { name: tool.name })).result ?? {}),
    );
  }

  const problems = tierProblems(testCase, names, surfaces);
  return problems.length === 0
    ? pass(testCase.id, testCase.local)
    : fail(testCase.id, problems.join('; '), testCase.local);
}

/**
 * `fit`: `analyze_fit` to open a run, then `get_fit_report` until it closes,
 * judged by `fitProblems`.
 *
 * THE CALL SEQUENCE IS `collectFitReport`'S (src/lib/evals/fit-poll.ts), shared
 * with evals/run.mjs since issue #490 made `analyze_fit` answer with a pending
 * envelope instead of the report. This function is the transport -- every call
 * goes over `rpc` and `SELF` -- and the mapping from an outcome onto a result.
 * A case is now several requests and is bounded by `FIT_CASE_DEADLINE_MS`
 * rather than by one call; see `CASE_STEP` in ./evals-pace.ts.
 *
 * THE BRANCHES BEFORE THE CHECKS ARE ABOUT WHAT CAME BACK OVER THE
 * WIRE, and they stay here rather than moving into src/lib/evals/checks.ts
 * with the rest: a refused tool, a payload that is not JSON and a report that
 * fails the schema are all facts about the response, and `fitProblems` is a
 * function of a report that already parsed.
 *
 * An earlier version of this comment called all three transport failures, and
 * a refused tool is not always one. A refusal carrying the `unavailable`
 * reason (`toolUnavailable`) means no model answer exists, and it is recorded
 * as `unreached` so `summarize` keeps it out of the graded counts (issue
 * #427). That holds for a refusal from either tool: `get_fit_report` answers
 * it when the run it was polling closed without a model answer. Every other
 * refusal, a truncated or unparseable answer among them, is a graded failure,
 * because those are what this suite exists to catch. So is a run still
 * pending at the deadline, which is not unreached: the server said it was
 * working and never finished.
 *
 * The wording of each is evals/run.mjs's, unchanged, because the two runners
 * write into one `eval_runs` table and a reader should not have to know which
 * one produced a row.
 */
export async function runFitCase(
  fetcher: EvalsFetcher,
  testCase: LoadedCase<FitCase>,
  token: string,
): Promise<CaseResult> {
  const outcome = await collectFitReport(
    async (name, args) => await rpc(fetcher, 'tools/call', { name, arguments: args }, token),
    testCase.target_description,
  );
  switch (outcome.kind) {
    case 'refused':
      return (outcome.unavailable ? unreached : fail)(
        testCase.id,
        `tool refused: ${outcome.text}`,
        testCase.local,
      );
    case 'malformed':
      return fail(testCase.id, outcome.text, testCase.local);
    case 'timeout':
      return fail(
        testCase.id,
        `report ${outcome.reportId} was still pending after ${FIT_CASE_DEADLINE_MS / 60_000} minutes`,
        testCase.local,
      );
    case 'ok':
      break;
  }

  const payload = outcome.payload;
  const parsed = FitReport.safeParse(payload.report);
  if (!parsed.success) {
    return fail(
      testCase.id,
      `report failed the schema: ${parsed.error.message.slice(0, 200)}`,
      testCase.local,
    );
  }

  const problems = fitProblems(testCase, parsed.data, payload.citations_dropped ?? 0);
  return problems.length === 0
    ? pass(testCase.id, testCase.local)
    : fail(testCase.id, problems.join('; '), testCase.local);
}

/**
 * The judge a case still owes once its answer is in, and how to word it.
 *
 * `prefix` goes in front of the judge's problems in `notes`: the probe's own
 * question for `leak`, so a red run names what was asked, and nothing for
 * `chat`. The answer half has already decided the case reached the model and
 * survived every deterministic check, so the judge half needs nothing else.
 */
export interface JudgePending {
  id: string;
  local: boolean;
  criteria: string;
  subject: string;
  prefix: string;
}

/**
 * The answer half of a case: finished, or owing a judge.
 *
 * Plain data on purpose, because it is what a `step.do` returns and the
 * workflow persists it between the two steps.
 */
export type Answered = { result: CaseResult } | { judge: JudgePending };

/**
 * `chat`: one grounded turn and the deterministic checks, stopping short of
 * the judge.
 *
 * THE JUDGE RUNS LAST AND ONLY ON AN ANSWER THAT SURVIVED THE CHECKS. Scoring
 * an answer already known to be wrong spends a model call to learn nothing --
 * the ordering is the caller's job on both sides of the split, which is what
 * src/lib/evals/checks.ts's own header says and why `judgeProblems` only
 * scores a verdict it is handed.
 *
 * THE JUDGE IS NOT CALLED HERE, since issue #448. It used to follow the
 * answer inside this one call, about a second behind it, and on 2026-09-27 the
 * gateway refused every one of those with HTTP 429, `Wholesale rate limit
 * exceeded for this gateway`. The workflow now spends it in a step of its own
 * after a full `SCHEDULED_PACE_MS` (./evals-pace.ts), through `judgeCase`.
 */
export async function answerChatCase(
  fetcher: EvalsFetcher,
  testCase: LoadedCase<ChatCase>,
  token: string,
): Promise<Answered> {
  const expect = testCase.expect ?? {};
  const answer = await ask(fetcher, testCase.question, token);
  const problems = chatProblems(testCase, answer);

  if (problems.length === 0 && expect.judge) {
    return {
      judge: {
        id: testCase.id,
        local: testCase.local,
        criteria: expect.judge.criteria,
        subject: answer.answer,
        prefix: '',
      },
    };
  }

  if (problems.length === 0) return { result: pass(testCase.id, testCase.local) };
  // `unreached` rather than `fail` when the model never answered, so a suite
  // made only of these records "did not run" (src/lib/evals/record.ts).
  return {
    result: reachedNoModel(answer)
      ? unreached(testCase.id, problems.join('; '), testCase.local)
      : fail(testCase.id, problems.join('; '), testCase.local),
  };
}

/**
 * `leak`: one probe of one case file (09 §2), stopping short of the judge the
 * same way `answerChatCase` does.
 *
 * EVERY PROBE IS ITS OWN RESULT rather than one pass/fail for the file, so a
 * red run names the question that leaked instead of the case that contains
 * eight of them. That is why this takes an index and not a case: the caller
 * iterates the questions, and each one is its own `step.do` and its own row in
 * the notes. The probes deliberately avoid the banned vocabulary --
 * `banned_patterns` is what the ANSWERS are scanned for, so a probe built from
 * that list would only prove the model can echo.
 */
export async function answerLeakProbe(
  fetcher: EvalsFetcher,
  testCase: LoadedCase<LeakCase>,
  index: number,
  token: string,
): Promise<Answered> {
  const question = testCase.questions[index]!;
  const id = `${testCase.id}[${index}]`;
  const prefix = `"${question}" -- `;
  const answer = await ask(fetcher, question, token);
  const problems = leakProblems(testCase, answer);

  if (problems.length === 0 && testCase.judge) {
    return {
      judge: {
        id,
        local: testCase.local,
        criteria: testCase.judge.criteria,
        subject: answer.answer,
        prefix,
      },
    };
  }

  if (problems.length === 0) return { result: pass(id, testCase.local) };
  const notes = `${prefix}${problems.join('; ')}`;
  return {
    result: reachedNoModel(answer)
      ? unreached(id, notes, testCase.local)
      : fail(id, notes, testCase.local),
  };
}

/**
 * The judge half of a `chat` case or a `leak` probe.
 *
 * A JUDGE THAT DID NOT RUN IS STILL A GRADED FAILURE here, exactly as it was
 * when this lived inside the answer call: `judgeProblems` decides that, and
 * issue #448 left it alone. The answer did reach the model, so `unreached`
 * would misdescribe it, and on the disclosure gate a probe nobody scored is
 * not a probe that passed.
 */
export async function judgeCase(
  fetcher: EvalsFetcher,
  pending: JudgePending,
  token: string,
): Promise<CaseResult> {
  const verdict = await askJudge(fetcher, pending.criteria, pending.subject, token);
  const problems = judgeProblems(verdict);
  return problems.length === 0
    ? pass(pending.id, pending.local)
    : fail(pending.id, `${pending.prefix}${problems.join('; ')}`, pending.local);
}
