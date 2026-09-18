// The deterministic half of each eval suite (04 §4), lifted unchanged from
// evals/run.mjs's runTier/runFit/runChat/runLeak. Each function returns the
// problems it found, `[]` for a pass -- never throws, never awaits, never
// touches a binding. The transport that produces `listedToolNames`,
// `surfaces`, `report` and `answer` stays in the caller on both sides of the
// split: evals/run.mjs today, the MCP Worker's scheduled runner in Task 4.
//
// THE JUDGE RUNS LAST, AND ONLY ON AN ANSWER THAT ALREADY PASSED THESE.
// `judgeProblems` just scores a verdict it is handed; the ordering itself is
// the caller's job, exactly as it is in evals/run.mjs's `runChat` and
// `runLeak` today -- scoring an answer already known to be wrong spends a
// model call to learn nothing.

import type { FitReport } from '../fit/schema';
import type { ChatCase, FitCase, LeakCase, TierCase } from './cases';

/**
 * `tier`: a hidden tool that is listed to an anonymous caller, or a banned
 * pattern that matches anything the public tier says. `surfaces` is every
 * string the caller collected -- the handshake's instructions, the tool and
 * resource listings, and the output of every no-argument tool -- searched as
 * one set rather than reported per-surface, matching `runTier`.
 */
export function tierProblems(
  testCase: TierCase,
  listedToolNames: string[],
  surfaces: string[],
): string[] {
  const problems: string[] = [];

  for (const hidden of testCase.hidden_tools) {
    if (listedToolNames.includes(hidden))
      problems.push(`${hidden} is listed to an anonymous caller`);
  }

  for (const source of testCase.banned_patterns) {
    const pattern = new RegExp(source, 'i');
    for (const surface of surfaces) {
      if (pattern.test(surface)) problems.push(`public surface matched /${source}/`);
    }
  }

  return problems;
}

/**
 * `fit`: the checks `runFit` runs against a schema-valid, citation-enforced
 * report. `citationsDropped` is `payload.citations_dropped`, already resolved
 * by the caller -- this function only compares it, the same way `runFit`
 * compares `payload.citations_dropped ?? 0`.
 */
export function fitProblems(
  testCase: FitCase,
  report: FitReport,
  citationsDropped: number,
): string[] {
  const expect = testCase.expect;
  const strong = report.requirement_map.filter((entry) => entry.strength === 'strong').length;
  const problems: string[] = [];

  if (report.requirement_map.length < (expect.min_requirements ?? 0)) {
    problems.push(
      `${report.requirement_map.length} requirements, expected >= ${expect.min_requirements}`,
    );
  }
  if (expect.min_gaps !== undefined && report.gaps.length < expect.min_gaps) {
    // The honesty contract (03 §4), as a check: a partial or mismatched
    // description that produces no gaps is a flattering engine, and this is
    // the cheapest place to catch one.
    problems.push(`${report.gaps.length} gaps, expected >= ${expect.min_gaps}`);
  }
  if (expect.min_strong !== undefined && strong < expect.min_strong) {
    problems.push(`${strong} strong ratings, expected >= ${expect.min_strong}`);
  }
  if (expect.max_strong !== undefined && strong > expect.max_strong) {
    problems.push(`${strong} strong ratings, expected <= ${expect.max_strong}`);
  }
  if (citationsDropped > (expect.max_dropped_citations ?? 0)) {
    problems.push(`${citationsDropped} citations dropped as unresolvable`);
  }
  // Every surviving citation resolved against the live corpus, because
  // `enforceCitations` already dropped the ones that did not -- so this
  // asserts the engine's own check ran rather than re-doing it.
  const uncited = report.requirement_map.filter(
    (entry) => entry.strength !== 'none' && entry.evidence.length === 0,
  );
  if (uncited.length > 0) problems.push(`${uncited.length} rated requirements carry no evidence`);

  return problems;
}

/**
 * Which `[n]` markers in an answer name a source that does not exist. A
 * module-level helper in evals/run.mjs until now; exported here because
 * `chatProblems` needs it and so will the Worker runner's own reporting.
 */
export function invalidCitations(answer: string, sourceCount: number): number[] {
  const invalid = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    if (n < 1 || n > sourceCount) invalid.add(n);
  }
  return [...invalid];
}

/**
 * `chat`: the deterministic half of `runChat`, run before the judge and
 * regardless of whether one is configured for this case.
 */
export function chatProblems(
  testCase: ChatCase,
  answer: { sources: unknown[]; answer: string; cited: unknown[]; error: string | null },
): string[] {
  const expect = testCase.expect ?? {};
  const problems: string[] = [];

  if (answer.error !== null) problems.push(`the endpoint refused with "${answer.error}"`);
  if (expect.min_sources !== undefined && answer.sources.length < expect.min_sources) {
    problems.push(
      `retrieved ${answer.sources.length} sources, expected at least ${expect.min_sources}`,
    );
  }
  if (expect.min_cited !== undefined && answer.cited.length < expect.min_cited) {
    problems.push(`cited ${answer.cited.length} sources, expected at least ${expect.min_cited}`);
  }
  const invalid = invalidCitations(answer.answer, answer.sources.length);
  if (expect.max_invalid_citations !== undefined && invalid.length > expect.max_invalid_citations) {
    problems.push(`cited ${invalid.length} source(s) that do not exist: ${invalid.join(', ')}`);
  }
  for (const banned of expect.banned_substrings ?? []) {
    if (answer.answer.includes(banned)) problems.push(`the answer contains "${banned}"`);
  }

  return problems;
}

/**
 * `leak`: the deterministic half of `runLeak`, one probe at a time -- the
 * caller is what makes every probe its own result, not this function.
 */
export function leakProblems(
  testCase: LeakCase,
  answer: { answer: string; error: string | null },
): string[] {
  const problems: string[] = [];

  if (answer.error !== null) problems.push(`the endpoint refused with "${answer.error}"`);
  for (const source of testCase.banned_patterns ?? []) {
    const pattern = new RegExp(source, 'i');
    if (pattern.test(answer.answer)) problems.push(`the answer matches ${pattern}`);
  }

  return problems;
}

/**
 * Scores a judge verdict, for `chat` and `leak` alike. `null` means the judge
 * did not run at all -- `JudgeUnavailable`, a rate limit exhausted past its
 * retry, or a response that did not parse -- and that is recorded as a failed
 * case rather than a skipped one: reporting it as a pass would hide a suite
 * that scored nothing behind a green result.
 */
export function judgeProblems(
  verdict: { verdict: string; score: number; reasons: string[] } | null,
): string[] {
  if (verdict === null) return ['the judge did not run'];
  if (verdict.verdict !== 'pass') {
    return [`judge: ${verdict.reasons.join('; ')} (score ${verdict.score})`];
  }
  return [];
}
