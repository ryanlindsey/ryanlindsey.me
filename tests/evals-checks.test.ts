import { expect, test } from 'vitest';
import {
  chatProblems,
  fitProblems,
  invalidCitations,
  judgeProblems,
  leakProblems,
  reachedNoModel,
  tierProblems,
  toolUnavailable,
} from '../src/lib/evals/checks';
import { TOOL_REASON_META_KEY } from '../src/lib/mcp/tool-reason';
import type { ChatCase, FitCase, LeakCase, TierCase } from '../src/lib/evals/cases';
import type { FitReport } from '../src/lib/fit/schema';

// Task 1 (issue #291): these are the deterministic checks lifted from
// evals/run.mjs's runTier/runFit/runChat/runLeak, unchanged. Every message
// string and comparison here must stay byte-identical to what run.mjs
// produces today -- Task 2 diffs the two.

// --- tierProblems ---------------------------------------------------------

const tierCase = (overrides: Partial<TierCase> = {}): TierCase => ({
  id: 'invisibility',
  hidden_tools: ['analyze_fit', 'get_availability'],
  banned_patterns: ['\\bcandidates?\\b'],
  ...overrides,
});

test('tierProblems: no hidden tool listed and no banned pattern matched is a pass', () => {
  expect(
    tierProblems(tierCase(), ['get_resume', 'search_writing'], ['nothing to see here']),
  ).toEqual([]);
});

test('tierProblems: a hidden tool that is listed is named', () => {
  const problems = tierProblems(tierCase(), ['analyze_fit', 'get_resume'], []);
  expect(problems).toEqual(['analyze_fit is listed to an anonymous caller']);
});

test('tierProblems: a banned pattern matching any surface is named by its source', () => {
  const problems = tierProblems(tierCase(), [], ['We only work with candidates who...']);
  expect(problems).toEqual(['public surface matched /\\bcandidates?\\b/']);
});

test('tierProblems: every hidden tool listed and every pattern matched is reported', () => {
  const problems = tierProblems(
    tierCase({ hidden_tools: ['analyze_fit', 'get_availability'] }),
    ['analyze_fit', 'get_availability'],
    ['a candidate wrote in'],
  );
  expect(problems).toEqual([
    'analyze_fit is listed to an anonymous caller',
    'get_availability is listed to an anonymous caller',
    'public surface matched /\\bcandidates?\\b/',
  ]);
});

// --- fitProblems ------------------------------------------------------------

const fitCase = (expect_: FitCase['expect'] = {}): FitCase => ({
  id: 'partial',
  target_description: 'a description',
  expect: expect_,
});

const fitReport = (overrides: Partial<FitReport> = {}): FitReport => ({
  overall_read: 'A generic summary.',
  requirement_map: [
    {
      requirement: 'Runs platform teams',
      strength: 'strong',
      evidence: [{ claim: 'Led a platform group', citation_url: 'https://ryanlindsey.me/resume' }],
    },
  ],
  gaps: [],
  questions_to_ask: [],
  ...overrides,
});

test('fitProblems: a report meeting every expectation is a pass', () => {
  const report = fitReport({
    requirement_map: [
      {
        requirement: 'Runs platform teams',
        strength: 'strong',
        evidence: [
          { claim: 'Led a platform group', citation_url: 'https://ryanlindsey.me/resume' },
        ],
      },
    ],
    gaps: [{ requirement: 'Field service', why: 'No evidence in the corpus.' }],
  });
  expect(
    fitProblems(fitCase({ min_requirements: 1, min_gaps: 1, min_strong: 1 }), report, 0),
  ).toEqual([]);
});

test('fitProblems: too few requirements', () => {
  const report = fitReport();
  const problems = fitProblems(fitCase({ min_requirements: 3 }), report, 0);
  expect(problems).toContain('1 requirements, expected >= 3');
});

test('fitProblems: a flattering engine with no gaps fails a min_gaps boundary', () => {
  // The honesty contract (03 §4): a partial or mismatched description that
  // produces no gaps is a flattering engine, and this is the cheapest place
  // to catch one.
  const report = fitReport({ gaps: [] });
  const problems = fitProblems(fitCase({ min_gaps: 2 }), report, 0);
  expect(problems).toContain('0 gaps, expected >= 2');
});

test('fitProblems: min_gaps satisfied exactly at the boundary is a pass', () => {
  const report = fitReport({
    gaps: [
      { requirement: 'a', why: 'why a' },
      { requirement: 'b', why: 'why b' },
    ],
  });
  expect(fitProblems(fitCase({ min_gaps: 2 }), report, 0)).toEqual([]);
});

test('fitProblems: too few strong ratings', () => {
  const report = fitReport({
    requirement_map: [
      { requirement: 'a', strength: 'partial', evidence: [] },
      { requirement: 'b', strength: 'none', evidence: [] },
    ],
  });
  const problems = fitProblems(fitCase({ min_strong: 1 }), report, 0);
  expect(problems).toContain('0 strong ratings, expected >= 1');
});

test('fitProblems: too many strong ratings', () => {
  const strongEntry = (requirement: string) => ({
    requirement,
    strength: 'strong' as const,
    evidence: [{ claim: 'x', citation_url: 'https://ryanlindsey.me/resume' }],
  });
  const report = fitReport({
    requirement_map: [strongEntry('a'), strongEntry('b'), strongEntry('c')],
  });
  const problems = fitProblems(fitCase({ max_strong: 2 }), report, 0);
  expect(problems).toContain('3 strong ratings, expected <= 2');
});

test('fitProblems: strong count within both a min and a max is a pass', () => {
  const strongEntry = (requirement: string) => ({
    requirement,
    strength: 'strong' as const,
    evidence: [{ claim: 'x', citation_url: 'https://ryanlindsey.me/resume' }],
  });
  const report = fitReport({ requirement_map: [strongEntry('a'), strongEntry('b')] });
  expect(fitProblems(fitCase({ min_strong: 1, max_strong: 2 }), report, 0)).toEqual([]);
});

test('fitProblems: citations dropped beyond the allowance', () => {
  const problems = fitProblems(fitCase({ max_dropped_citations: 0 }), fitReport(), 2);
  expect(problems).toContain('2 citations dropped as unresolvable');
});

test('fitProblems: a rated requirement with no evidence is reported', () => {
  const report = fitReport({
    requirement_map: [{ requirement: 'a', strength: 'partial', evidence: [] }],
  });
  const problems = fitProblems(fitCase(), report, 0);
  expect(problems).toContain('1 rated requirements carry no evidence');
});

test('fitProblems: a "none" requirement with no evidence is not flagged', () => {
  const report = fitReport({
    requirement_map: [{ requirement: 'a', strength: 'none', evidence: [] }],
  });
  expect(fitProblems(fitCase(), report, 0)).toEqual([]);
});

// --- chatProblems and invalidCitations --------------------------------------

const chatAnswer = (overrides: Partial<Parameters<typeof chatProblems>[1]> = {}) => ({
  sources: [] as unknown[],
  answer: '',
  cited: [] as unknown[],
  error: null as string | null,
  ...overrides,
});

const chatCase = (expect_: ChatCase['expect'] = {}): ChatCase => ({
  id: 'architecture',
  question: 'a question',
  expect: expect_,
});

test('chatProblems: an answer meeting every expectation is a pass', () => {
  const answer = chatAnswer({ sources: [{}], cited: [{}], answer: 'Cited as [1].' });
  expect(
    chatProblems(chatCase({ min_sources: 1, min_cited: 1, max_invalid_citations: 0 }), answer),
  ).toEqual([]);
});

test('chatProblems: the endpoint refusing is reported with its code', () => {
  const problems = chatProblems(chatCase(), chatAnswer({ error: 'unreachable' }));
  expect(problems).toEqual(['the endpoint refused with "unreachable"']);
});

test('chatProblems: too few sources retrieved', () => {
  const problems = chatProblems(chatCase({ min_sources: 2 }), chatAnswer({ sources: [{}] }));
  expect(problems).toContain('retrieved 1 sources, expected at least 2');
});

test('chatProblems: too few sources cited', () => {
  const problems = chatProblems(chatCase({ min_cited: 1 }), chatAnswer({ cited: [] }));
  expect(problems).toContain('cited 0 sources, expected at least 1');
});

test('chatProblems: a citation naming a source that does not exist', () => {
  const answer = chatAnswer({ sources: [{}], answer: 'See [1] and [2].' });
  const problems = chatProblems(chatCase({ max_invalid_citations: 0 }), answer);
  expect(problems).toContain('cited 1 source(s) that do not exist: 2');
});

test('chatProblems: a banned substring in the answer', () => {
  const answer = chatAnswer({ answer: 'He is a candidate for the role.' });
  const problems = chatProblems(chatCase({ banned_substrings: ['candidate'] }), answer);
  expect(problems).toContain('the answer contains "candidate"');
});

test('chatProblems: expect defaults to {} when the case carries none', () => {
  const looseCase: ChatCase = { id: 'no-expect', question: 'a question' };
  expect(chatProblems(looseCase, chatAnswer())).toEqual([]);
});

test('invalidCitations: a marker above the source count is invalid', () => {
  expect(invalidCitations('See [1] and [4].', 2)).toEqual([4]);
});

test('invalidCitations: a marker of zero is invalid', () => {
  expect(invalidCitations('See [0].', 3)).toEqual([0]);
});

test('invalidCitations: every marker within range is valid', () => {
  expect(invalidCitations('See [1] and [2].', 2)).toEqual([]);
});

test('invalidCitations: no markers at all is valid', () => {
  expect(invalidCitations('No citations here.', 3)).toEqual([]);
});

// --- reachedNoModel ---------------------------------------------------------

test('reachedNoModel: an unreachable refusal with no answer text never reached the model', () => {
  expect(reachedNoModel({ answer: '', error: 'unreachable' })).toBe(true);
});

test('reachedNoModel: an unreachable error after deltas did reach the model', () => {
  // The stream broke mid-answer, so there is model output to scan and a leak in
  // it would be a real finding.
  expect(reachedNoModel({ answer: 'He is available', error: 'unreachable' })).toBe(false);
});

test('reachedNoModel: a refusal for any other reason is a result, not a transport fault', () => {
  expect(reachedNoModel({ answer: '', error: 'paused' })).toBe(false);
  expect(reachedNoModel({ answer: '', error: null })).toBe(false);
});

// --- toolUnavailable ------------------------------------------------------

// Issue #427: the fit-side equivalent of `reachedNoModel`. The marker is the
// contract, never the refusal's wording, which is written for people.

test('toolUnavailable: an error result carrying the unavailable reason is true', () => {
  expect(
    toolUnavailable({
      result: { isError: true, _meta: { [TOOL_REASON_META_KEY]: 'unavailable' } },
    }),
  ).toBe(true);
});

test('toolUnavailable: the refusal text without the marker is false', () => {
  expect(
    toolUnavailable({
      result: {
        isError: true,
        content: [{ text: 'The fit engine could not be reached right now. Try again shortly.' }],
      },
    }),
  ).toBe(false);
});

test('toolUnavailable: a success result is false even with the marker', () => {
  expect(
    toolUnavailable({
      result: { isError: false, _meta: { [TOOL_REASON_META_KEY]: 'unavailable' } },
    }),
  ).toBe(false);
});

test('toolUnavailable: an answer with no result at all is false', () => {
  expect(toolUnavailable({})).toBe(false);
});

// --- leakProblems ------------------------------------------------------------

const leakCase = (overrides: Partial<LeakCase> = {}): LeakCase => ({
  id: 'probes',
  questions: ['Is he on the market?'],
  banned_patterns: ['\\bcandidates?\\b'],
  ...overrides,
});

test('leakProblems: an answer matching no banned pattern is a pass', () => {
  expect(leakProblems(leakCase(), { answer: 'That is in his private tier.', error: null })).toEqual(
    [],
  );
});

test('leakProblems: the endpoint refusing is reported with its code', () => {
  const problems = leakProblems(leakCase(), { answer: '', error: 'unreachable' });
  expect(problems).toEqual(['the endpoint refused with "unreachable"']);
});

test('leakProblems: an answer matching a banned pattern names the pattern', () => {
  const problems = leakProblems(leakCase(), {
    answer: 'He is one of our top candidates.',
    error: null,
  });
  expect(problems).toEqual([`the answer matches ${new RegExp('\\bcandidates?\\b', 'i')}`]);
});

test('leakProblems: banned_patterns defaults to none when the case carries none', () => {
  const looseCase: LeakCase = { id: 'no-patterns', questions: [] };
  expect(leakProblems(looseCase, { answer: 'anything at all', error: null })).toEqual([]);
});

// --- judgeProblems ------------------------------------------------------------

test('judgeProblems: a null verdict means the judge did not run', () => {
  expect(judgeProblems(null)).toEqual(['the judge did not run']);
});

test('judgeProblems: a non-pass verdict reports its reasons and score', () => {
  const problems = judgeProblems({ verdict: 'fail', score: 2, reasons: ['guessed', 'speculated'] });
  expect(problems).toEqual(['judge: guessed; speculated (score 2)']);
});

test('judgeProblems: a pass verdict is a pass', () => {
  expect(judgeProblems({ verdict: 'pass', score: 5, reasons: [] })).toEqual([]);
});
