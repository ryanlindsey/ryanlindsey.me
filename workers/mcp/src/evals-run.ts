// The four suites, one case at a time (issue #291). Transport from
// ./evals-client.ts, judgment from src/lib/evals/checks.ts, case shape from
// src/lib/evals/record.ts -- this module is the wiring between them and holds
// no comparison of its own.
//
// ONE CASE PER CALL, which is the difference from evals/run.mjs's `runTier`,
// `runFit`, `runChat` and `runLeak`. Those functions loop and pace; these do
// neither, because the workflow drives the loop (one `step.do` per case, so a
// resumed instance replays the cases it already finished rather than re-paying
// for them) and owns the pacing (a real twenty-five-second wait belongs in a
// `step.sleep`, which suspends the instance, not in a `setTimeout`, which
// holds an invocation open). See ./evals-workflow.ts.
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
  toolUnavailable,
} from '../../../src/lib/evals/checks';
import type {
  ChatCase,
  FitCase,
  LeakCase,
  LoadedCase,
  TierCase,
} from '../../../src/lib/evals/cases';
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
 * `fit`: one `analyze_fit` call, judged by `fitProblems`.
 *
 * THE THREE BRANCHES BEFORE THE CHECKS ARE ABOUT WHAT CAME BACK OVER THE
 * WIRE, and they stay here rather than moving into src/lib/evals/checks.ts
 * with the rest: a refused tool, a payload that is not JSON and a report that
 * fails the schema are all facts about the response, and `fitProblems` is a
 * function of a report that already parsed.
 *
 * An earlier version of this comment called all three transport failures, and
 * a refused tool is not always one. A refusal carrying the `unavailable`
 * reason (`toolUnavailable`) means no model answer exists, and it is recorded
 * as `unreached` so `summarize` keeps it out of the graded counts (issue
 * #427). Every other refusal, a truncated or unparseable answer among them, is
 * a graded failure, because those are what this suite exists to catch.
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
  const answer = await rpc(
    fetcher,
    'tools/call',
    { name: 'analyze_fit', arguments: { target_description: testCase.target_description } },
    token,
  );
  if (answer.result?.isError) {
    const outcome = toolUnavailable(answer) ? unreached : fail;
    return outcome(
      testCase.id,
      `tool refused: ${answer.result.content?.[0]?.text ?? ''}`,
      testCase.local,
    );
  }

  let payload: { report?: unknown; citations_dropped?: number };
  try {
    payload = JSON.parse(answer.result?.content?.[0]?.text ?? '') as typeof payload;
  } catch {
    return fail(testCase.id, 'the tool did not return JSON', testCase.local);
  }

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
 * `chat`: one grounded turn, the deterministic checks, then the judge.
 *
 * THE JUDGE RUNS LAST AND ONLY ON AN ANSWER THAT SURVIVED THE CHECKS. Scoring
 * an answer already known to be wrong spends a model call to learn nothing --
 * the ordering is the caller's job on both sides of the split, which is what
 * src/lib/evals/checks.ts's own header says and why `judgeProblems` only
 * scores a verdict it is handed.
 */
export async function runChatCase(
  fetcher: EvalsFetcher,
  testCase: LoadedCase<ChatCase>,
  token: string,
): Promise<CaseResult> {
  const expect = testCase.expect ?? {};
  const answer = await ask(fetcher, testCase.question, token);
  const problems = chatProblems(testCase, answer);

  if (problems.length === 0 && expect.judge) {
    const verdict = await askJudge(fetcher, expect.judge.criteria, answer.answer, token);
    problems.push(...judgeProblems(verdict));
  }

  if (problems.length === 0) return pass(testCase.id, testCase.local);
  // `unreached` rather than `fail` when the model never answered, so a suite
  // made only of these records "did not run" (src/lib/evals/record.ts).
  return reachedNoModel(answer)
    ? unreached(testCase.id, problems.join('; '), testCase.local)
    : fail(testCase.id, problems.join('; '), testCase.local);
}

/**
 * `leak`: one probe of one case file (09 §2).
 *
 * EVERY PROBE IS ITS OWN RESULT rather than one pass/fail for the file, so a
 * red run names the question that leaked instead of the case that contains
 * eight of them. That is why this takes an index and not a case: the caller
 * iterates the questions, and each one is its own `step.do` and its own row in
 * the notes. The probes deliberately avoid the banned vocabulary --
 * `banned_patterns` is what the ANSWERS are scanned for, so a probe built from
 * that list would only prove the model can echo.
 */
export async function runLeakProbe(
  fetcher: EvalsFetcher,
  testCase: LoadedCase<LeakCase>,
  index: number,
  token: string,
): Promise<CaseResult> {
  const question = testCase.questions[index]!;
  const id = `${testCase.id}[${index}]`;
  const answer = await ask(fetcher, question, token);
  const problems = leakProblems(testCase, answer);

  if (problems.length === 0 && testCase.judge) {
    const verdict = await askJudge(fetcher, testCase.judge.criteria, answer.answer, token);
    problems.push(...judgeProblems(verdict));
  }

  if (problems.length === 0) return pass(id, testCase.local);
  const notes = `"${question}" -- ${problems.join('; ')}`;
  return reachedNoModel(answer)
    ? unreached(id, notes, testCase.local)
    : fail(id, notes, testCase.local);
}
