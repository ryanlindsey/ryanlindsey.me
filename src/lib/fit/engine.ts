// The fit engine (03 §4, 04 §2). ONE engine, two frontends: the `analyze_fit`
// MCP tool calls it, and `/fit` calls that tool over the service binding. This
// module is the only place in the repo that spends inference.
//
// GENERIC by construction (09 §2): `analyzeFit(env, targetDescription)`. It
// does not know, and must never learn, what a target description is for.

import { buildCorpusContext, type CorpusContext } from './corpus-context';
import { fenceFor } from '../fence';
// Re-exported: this was `fenceFor`'s home until it was needed in five places.
export { fenceFor };
import type { DocumentsEnv } from '../mcp/documents';
import { enforceCitations, FitReport, FIT_REPORT_JSON_SCHEMA, type CitationAudit } from './schema';
import FIT_PROMPT from '../../../prompts/fit.md?raw';

/**
 * The model, MEASURED before it was trusted (Task 10 Step 1).
 *
 * 03 §4 specifies Opus. The day-1 capability spike (10 §5) proved the binding's
 * gateway route with `anthropic/claude-sonnet-5` and did not test Opus, and
 * `wrangler ai models` lists no partner model at all, so whether this account's
 * gateway would serve Opus was a runtime question rather than a documented one.
 *
 * Probed 2026-09-09 through `wrangler dev --config workers/mcp/wrangler.jsonc`
 * (the `ai` binding is always-remote, so a dev session is a real call against
 * the real account), one model per call and 40 seconds apart:
 *   anthropic/claude-opus-5   -> content[0].text === 'ok', stop_reason 'end_turn'
 *   anthropic/claude-sonnet-5 -> content[0].text === 'ok', stop_reason 'end_turn'
 * Both work, so 03 §4's choice stands and the fallback below is a real
 * alternative rather than a hypothetical one.
 *
 * MOVED TO OPUS 5.5 by #379, re-probed the same way from a scratch Worker
 * against the `ryanlindsey-me` gateway, 2026-09-23 and 2026-09-24:
 *   anthropic/claude-opus-5-5 -> `7003: User Input Error`, with and without
 *                                `output_config`
 *   anthropic/claude-opus-5   -> the same body answered `200`, `end_turn`
 *   anthropic/claude-opus-5.5 -> content[0] thinking, then text 'ok', `end_turn`
 * THE CATALOGUE ID HAS A DOT. `claude-opus-5-5` is Anthropic's own spelling,
 * and the gateway rejects it with the same `7003` it gives a malformed body,
 * so a day of "the gateway does not serve it yet" was a spelling mistake. The
 * id to copy is the one on developers.cloudflare.com/ai/models, not the one
 * in Anthropic's docs. Opus 5.5 is also cheaper per token than Opus 5 ($4 /
 * $20 per MTok against $5 / $25).
 *
 * The spacing is not superstition: 10 §5 records the gateway capping at 50
 * requests/minute and answering an exceeded cap with `2018: Invalid User
 * Credentials`, which READS AS AN AUTH FAILURE AND IS NOT. Two passes of spike
 * conclusions were wrong before that was spotted. Anyone re-probing these
 * values should space the calls and disbelieve a 2018.
 */
export const FIT_MODEL = 'anthropic/claude-opus-5.5';
/**
 * Kept on Sonnet 5 by #379, and still with no call site. Whether Sonnet 5
 * honours `output_config.format` through this gateway is UNPROBED, so this is
 * no longer the drop-in alternative the paragraph above describes: probe that
 * before wiring it anywhere.
 */
export const FIT_FALLBACK_MODEL = 'anthropic/claude-sonnet-5';

/**
 * Set explicitly although it is Opus 5.5's default, so the cost of a report
 * cannot move because a default did.
 */
export const FIT_EFFORT = 'medium';

/**
 * Required by this binding, and the ONLY sampling-adjacent parameter it
 * accepts: 10 §5 measured `temperature`, `top_p` and `top_k` being rejected
 * with `7003: User Input Error`, deterministically. Do not add them.
 *
 * 32000 SINCE #379, because thinking now spends from the same budget. Opus
 * 5.5's adaptive thinking cannot be switched off and counts toward
 * `max_tokens`, so the 8192 below the truncation guard was sized for a report
 * alone and would be spent partly on reasoning the reader never sees. 32000 is
 * the top of the range the issue named rather than a measured ceiling: the
 * cap bounds the worst request, not the typical one, and the `fit` eval suite
 * is what says whether a long report still fits.
 */
export const FIT_MAX_TOKENS = 32000;

/** The daily breaker flag (04 §5). Any value at all means tripped. */
export const BREAKER_KEY = 'breaker:inference';

/**
 * The request body this module sends, named so that the shape is checked.
 *
 * `env.AI.run` IS CALLED UNCAST, and this type is why. The binding has a
 * documented unknown-model fallback overload
 * (worker-configuration.d.ts:10560-10568):
 *
 *   run<Model extends string>(
 *     model: Model extends keyof AiModelList ? never : Model,
 *     inputs: Record<string, unknown>,
 *     options?: AiOptions,
 *   ): Promise<Record<string, unknown>>
 *
 * and its own comment names third-party gateway models as its purpose. So
 * `'anthropic/claude-opus-5.5'` -- not a key of `AiModelList`, the generated map
 * of Cloudflare's own catalogue -- routes here rather than having no overload
 * at all. Fix round 1, finding 3: this file previously claimed there was no
 * overload and cast `env.AI` through `as unknown as`, which threw away the
 * check that `env.AI` is an `Ai` in the first place, to buy nothing.
 *
 * The fallback's `inputs` is `Record<string, unknown>`, which accepts anything,
 * so the named shape below is where the checking actually happens -- it is
 * declared as a `type` rather than an `interface` deliberately, because an
 * interface has no implicit index signature and would not be assignable to
 * `Record<string, unknown>`.
 *
 * The shape IS the measurement. `temperature`, `top_p` and `top_k` are ABSENT
 * rather than optional -- 10 §5 measured all three being rejected with
 * `7003: User Input Error` -- and `output_config.format` is required rather
 * than optional, because it is the whole mechanism by which this call returns
 * structured output. There is no `response_format`: that is an OpenAI field,
 * and Anthropic does not have it. A future edit that adds a sampling knob now
 * has to add it to a type whose comment says why it is not there.
 *
 * `tools` and `tool_choice` are absent too, since #379. Until then the report
 * came back as the input of a forced `emit_fit_report` call, and Opus 5.5
 * rejects forced tool use: MEASURED 2026-09-24, that body answered `7003`
 * through the gateway, and the same prompt under `output_config.format` with
 * the real `FIT_REPORT_JSON_SCHEMA` answered `200` and a JSON `text` block
 * that parsed. So `minLength` and `format: uri` pass through as well.
 */
type FitModelInput = {
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  output_config: {
    effort: typeof FIT_EFFORT;
    format: { type: 'json_schema'; schema: Record<string, unknown> };
  };
};

export interface FitEnv extends DocumentsEnv {
  AI: Ai;
  KV_CONFIG: KVNamespace;
  RLME_AI_GATEWAY_ID: string;
  /**
   * Test-only seam, same shape as `CORPUS_REFRESH` and `MCP_SEARCH_EMBEDDER`:
   * no deployed config declares it, and an unrecognised value throws. `'off'`
   * makes `analyzeFit` refuse before the model call, which is what lets a
   * harness suite exercise the TOOL (its scope check, its limiter, its audit
   * row) without an `Ai` it does not have.
   *
   * `FIT_ENGINE_MODES` below is the whole accepted set, and `'off-after-delay'`
   * is the second member. It exists for #274 and is argued for there.
   */
  FIT_ENGINE?: string;
}

/**
 * A failure whose message is safe to show a caller.
 *
 * Every path out of this module that is not a report is one of these, with ONE
 * deliberate exception: the `FIT_ENGINE` seam's unrecognised-value throw in
 * `analyzeFit` below stays a plain `Error`, because a mis-set var is an
 * operator's mistake rather than an outage and must not be dressed up as one.
 *
 * The message is written HERE rather than derived from whatever threw -- an
 * `AiError: 2018 …` reaching a caller would publish the gateway's internals
 * and, worse, tell them a rate limit was hit rather than that the engine is
 * unavailable.
 *
 * FIX ROUND 1, FINDING 1: the sentence above used to be an unqualified "every
 * path", and it was false in two places -- `env.KV_CONFIG.get` and
 * `buildCorpusContext` were both unwrapped, and the latter throws BY DESIGN:
 * `fetchDocumentIndex` raises ``/llms.txt returned ${status} from
 * ${env.SITE_ORIGIN}``, which names an internal origin and a status code, on
 * exactly the failure class issue #28 already bit this repo with (a 522 on
 * `/llms.txt`). Both are wrapped now. A comment asserting a safety property is
 * worth nothing unless the property is enforced, so if a future edit adds an
 * `await` to this function, it belongs inside a `try` or this comment becomes
 * a lie again.
 */
export class FitUnavailable extends Error {
  constructor(message: string) {
    super(message);
    // `Error` sets `name` from the prototype, so a subclass serialises as
    // plain "Error" without this. Task 11 hands these across a service
    // binding, where the instance is structured-cloned and `instanceof` does
    // not survive -- the name is what the far side has left to recognise.
    this.name = 'FitUnavailable';
  }
}

export interface FitResult {
  report: FitReport;
  citations: CitationAudit;
  model: string;
  /** ISO 8601. The envelope's, not the model's -- a model does not know the time. */
  generatedAt: string;
  corpusDocuments: number;
  /**
   * Whether the corpus did not fit `CONTEXT_CHAR_BUDGET` and whole documents
   * were dropped before the model saw them.
   *
   * Surfaced rather than left internal (final-review Important 6): the flag
   * was computed by `renderContext`, returned by `buildCorpusContext` and
   * asserted by tests, and then read by nothing -- so a corpus crossing the
   * budget would have quietly thinned every report, dropping documents from
   * `allowedUrls` as well as from the prompt, with no signal to the operator
   * or the reader. It rides in the envelope as `corpus_truncated`.
   */
  corpusTruncated: boolean;
}

/**
 * The forced tool call's input, or `null`.
 *
 * THE JUDGE IS ITS ONLY CALLER since #379 moved this engine to Opus 5.5, which
 * rejects forced tool use; the fit report now arrives through
 * `extractStructuredOutput` below. It stays here rather than moving because
 * the judge imports it from here, and it breaks the same way the day the
 * judge moves off Sonnet 5.
 *
 * Structured output through this binding is a forced `tool_choice` emitting a
 * schema, NOT `response_format` -- 10 §5 measured that, and `response_format`
 * is an OpenAI field Anthropic does not have. So the answer arrives as a
 * `tool_use` content block, and it may sit beside a `text` block the model
 * produced anyway; this searches rather than indexing `content[0]`.
 *
 * `name` IS CHECKED, BUT ONLY WHEN PRESENT, and the asymmetry is deliberate
 * (fix round 1, finding 9). Checking it when present means a `tools` array
 * that ever grows a second entry cannot silently feed the wrong tool's input
 * to `FitReport.safeParse` -- a plausible future edit, since a "cannot comply"
 * tool is the obvious next one. Not REQUIRING it is the measured half: Task
 * 10's probe measured a `text` response through this gateway route and never a
 * `tool_use` one, so whether the block carries `name` here is unverified, and
 * demanding an unmeasured field would fail closed on answers that are fine.
 * When a real tool_use envelope has been captured, this can tighten to an
 * equality check.
 */
export function extractToolInput(raw: unknown, toolName: string): unknown {
  if (typeof raw !== 'object' || raw === null) return null;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as { type?: unknown; name?: unknown; input?: unknown };
    if (entry.type !== 'tool_use' || entry.input === undefined) continue;
    if (entry.name !== undefined && entry.name !== toolName) continue;
    return entry.input;
  }
  return null;
}

/**
 * The structured answer, parsed from its JSON `text` block, or `null`.
 *
 * Under `output_config.format` the report arrives as a string in a `text`
 * block, and on Opus 5.5 that block is not `content[0]`: adaptive thinking is
 * always on, and a `thinking` block (whose text arrives empty) comes first. So
 * this searches rather than indexing. The first `text` block is the answer,
 * because a constrained response has exactly one.
 *
 * Text that is not JSON is `null` rather than a throw, so it reaches the same
 * fail-closed branch as JSON that does not match the schema.
 */
export function extractStructuredOutput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return null;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== 'text' || typeof entry.text !== 'string') continue;
    try {
      return JSON.parse(entry.text) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Every value the `FIT_ENGINE` seam accepts, and the reason there are two.
 *
 * `'off'` refuses IMMEDIATELY, before the breaker, the corpus or the model,
 * which is what lets a harness exercise everything around a call it cannot
 * afford to make.
 *
 * `'off-after-delay'` refuses the same way and with the same sentence, a few
 * hundred milliseconds later. It exists because #274 moved the fit run off the
 * request path: `POST /fit/start` opens a `fit_reports` row as `pending`,
 * answers with its id, and closes the row from a Workflow instance -- from
 * `ctx.waitUntil` until #349 found that budget cancelling every real run.
 * Which of the two is doing the waiting does not change this seam. Under `'off'`
 * that whole sequence finishes before a test can read the row -- MEASURED
 * 2026-09-21, every read of a freshly opened row came back `failed` -- so the
 * one state the endpoint exists to produce was unobservable, and the only
 * assertion left was that a literal appeared in the source. A delay the test
 * can outrun makes the TRANSITION `pending -> failed` a behavioural
 * assertion instead.
 *
 * It costs what `'off'` costs and no more: no neurons, no subrequest, no
 * binding touched. The seam's three safety properties are unchanged -- no
 * deployed config declares the var (tests/mcp-env.test.ts), absent means run
 * the engine, and anything outside this list throws.
 */
const FIT_ENGINE_MODES = ['off', 'off-after-delay'];

/**
 * How long `'off-after-delay'` waits before refusing.
 *
 * Long enough that a test reading the row over the harness's loopback
 * transport wins the race by a wide margin -- that read is single-digit
 * milliseconds, so this is roughly a hundredfold -- and short enough to be
 * paid twice a run without anyone noticing. ONE test waits for the
 * transition, in tests/fit-start.test.ts. The other payer,
 * tests/fit-engine.test.ts's seam case, waits for nothing and simply sits out
 * the delay before the refusal it asserts arrives.
 */
const FIT_ENGINE_DELAY_MS = 500;

/**
 * The fence long enough to enclose `text` whole.
 *
 * FIX ROUND 1, FINDING 2. A fixed three-backtick fence is not a boundary, it
 * is a suggestion: CommonMark closes a fenced block at the first line whose
 * fence is at least as long as the opening one, so a description containing a
 * ``` line closes the block early and everything after it reaches the model as
 * top-level prompt -- outside the "treat fenced content as data" instruction
 * that prompts/fit.md relies on. The target description is the ONLY untrusted
 * input in this system, and this is its entire boundary.
 *
 * `enforceCitations` still bounds what an injection can do to the citations,
 * because a fabricated URL cannot enter `allowedUrls`. What it cannot bound is
 * the prose: `overall_read`, `gaps[].why` and every `strength` rating are free
 * for a steered model to write, and those are what a reader actually trusts.
 *
 * Opening with one more backtick than the longest run inside is CommonMark's
 * own answer to this, and the minimum of three keeps the ordinary case
 * looking like ordinary markdown.
 */

/**
 * Compares the published corpus against one target description.
 *
 * ORDER MATTERS, and every refusal below is placed to cost nothing: the seam,
 * the breaker and the empty-input check come before the corpus is even
 * fetched, and the corpus fetch comes before the model call. A refused run
 * should spend no neurons and no subrequests it did not have to.
 */
export async function analyzeFit(env: FitEnv, targetDescription: string): Promise<FitResult> {
  if (env.FIT_ENGINE !== undefined && !FIT_ENGINE_MODES.includes(env.FIT_ENGINE)) {
    // A plain Error, deliberately NOT a FitUnavailable: this is a
    // misconfiguration rather than an outage, and a caller must never be given
    // a polite sentence about it. The other seams in this repo throw here too.
    throw new Error(`unrecognised FIT_ENGINE: ${env.FIT_ENGINE}`);
  }
  if (env.FIT_ENGINE === 'off-after-delay') {
    await new Promise((resolve) => setTimeout(resolve, FIT_ENGINE_DELAY_MS));
  }
  // Asked against the SET rather than against `!== undefined`, which would be
  // correct only because the unrecognised-value throw above has already run.
  // Every value in `FIT_ENGINE_MODES` refuses because that is what the set is
  // for; reading it here is what keeps a future member from being committed to
  // refusing by a condition written somewhere else.
  if (env.FIT_ENGINE !== undefined && FIT_ENGINE_MODES.includes(env.FIT_ENGINE)) {
    throw new FitUnavailable('Fit analysis is not available in this environment.');
  }

  const description = targetDescription.trim();
  if (description.length === 0) {
    throw new FitUnavailable('Provide the description to compare against.');
  }

  // The breaker (04 §5). A KV read, checked before anything is spent -- which
  // is the whole point of a breaker: tripping it must stop the spend, not
  // report on it afterwards.
  //
  // WRAPPED, and it fails CLOSED (fix round 1, finding 1). A KV read that
  // throws leaves this function unable to say whether the budget is exhausted,
  // and the safe answer to "I cannot tell" is to refuse -- spending on a
  // possibly-tripped breaker is the exact outcome the breaker exists to
  // prevent.
  let tripped: string | null;
  try {
    tripped = await env.KV_CONFIG.get(BREAKER_KEY);
  } catch (error) {
    console.error('fit: the breaker flag could not be read', error);
    throw new FitUnavailable('Fit analysis is unavailable right now. Try again shortly.');
  }
  if (tripped !== null) {
    throw new FitUnavailable(
      'Fit analysis is paused: the daily inference budget breaker is tripped. It resets automatically.',
    );
  }

  // WRAPPED for a stronger reason than the breaker read: this one throws by
  // DESIGN. `fetchDocumentIndex` (src/lib/mcp/documents.ts) raises
  // ``/llms.txt returned ${status} from ${env.SITE_ORIGIN}`` on a non-ok
  // index, which names an internal origin and a status code to whoever asked.
  // That is not hypothetical -- issue #28 was precisely this fetch returning
  // 522 in production.
  let corpus: CorpusContext;
  try {
    corpus = await buildCorpusContext(env);
  } catch (error) {
    console.error('fit: the corpus could not be read', error);
    throw new FitUnavailable('The published work could not be read right now. Try again shortly.');
  }
  if (corpus.documents === 0) {
    throw new FitUnavailable('There is no published work to compare against right now.');
  }
  if (corpus.truncated) {
    // WARN, not throw: a truncated corpus still produces an honest report of
    // what the model was shown, and refusing would take the feature down for
    // a condition that degrades rather than breaks. But it must not be
    // silent -- the dropped documents leave `allowedUrls` too, so their
    // absence reads to a citation-checked report as "no evidence exists"
    // rather than "the evidence was not in the room".
    console.warn(
      `fit: the corpus exceeded the context budget and was truncated to ${corpus.documents} documents`,
    );
  }

  // The description is FENCED, like every corpus document, and the prompt
  // tells the model to treat fenced content as data. It is text a stranger
  // pasted, and this is the boundary -- which is why the fence is computed
  // from the text rather than fixed at three backticks. See `fenceFor`.
  const fence = fenceFor(description);
  const user = [
    '# Corpus',
    '',
    corpus.text,
    '',
    '# Target description',
    '',
    `${fence}text`,
    description,
    fence,
  ].join('\n');

  const input: FitModelInput = {
    max_tokens: FIT_MAX_TOKENS,
    system: FIT_PROMPT,
    messages: [{ role: 'user', content: user }],
    output_config: {
      effort: FIT_EFFORT,
      format: { type: 'json_schema', schema: FIT_REPORT_JSON_SCHEMA },
    },
  };

  let raw: Record<string, unknown>;
  try {
    raw = await env.AI.run(FIT_MODEL, input, {
      gateway: {
        id: env.RLME_AI_GATEWAY_ID,
        // Attribution in the gateway's own logs, which 10 §5 established
        // are the only reliable signal that routing worked --
        // `aiGatewayLogId` was null on every probe regardless of whether
        // the call went through the gateway.
        metadata: { surface: 'fit' },
      },
    });
  } catch (error) {
    console.error('fit: model call failed', error);
    throw new FitUnavailable('The fit engine could not be reached right now. Try again shortly.');
  }

  // TRUNCATION IS NOT A SCHEMA ERROR, so zod must not be the only judge of
  // completeness (fix round 1, finding 5). `FitReport` requires
  // `requirement_map.min(1)`; prompts/fit.md asks for five to twelve. A report
  // cut off at four -- or at one -- still parses, and the whole design rests on
  // never rendering a partial report as a whole one, because the reader cannot
  // see what is missing. The signal is already in the envelope; it only had to
  // be read.
  //
  // THE EVAL SUITE SUPPLIED THE MEASUREMENT, 2026-09-10, which is exactly what
  // the note here used to say it was waiting for: `FIT_MAX_TOKENS` had never
  // been validated against a real five-to-twelve-requirement report because
  // Task 10's probes capped at 16 tokens. The first full `npm run evals` run in
  // this repo's history answered it -- `fit/mismatch` passed at 4096 and both
  // `fit/strong` and `fit/partial` hit the cap and were refused by this guard.
  // The two that failed are the two that produce LONG reports: `strong` expects
  // at least five requirements with two rated strong, and `partial` is built to
  // surface gaps on top of matches. So 4096 was sized for the smallest case.
  //
  // 8192 then, doubled rather than tuned to a measured ceiling, because the
  // number that matters is "comfortably more than the longest report" and the
  // suite is what tells us if it is not. #379 raised it again for Opus 5.5,
  // whose thinking spends from the same cap; see `FIT_MAX_TOKENS`. If a twelve-requirement report ever
  // trips this again, raise it again -- the guard failing loudly is the system
  // working, and a truncated report rendered as a whole one is the outcome it
  // exists to prevent.
  if (raw.stop_reason === 'max_tokens') {
    console.error(`fit: the model hit the ${FIT_MAX_TOKENS}-token cap and the report is truncated`);
    throw new FitUnavailable('The fit engine returned an incomplete answer. Try again shortly.');
  }

  const parsed = FitReport.safeParse(extractStructuredOutput(raw));
  if (!parsed.success) {
    // FAILS CLOSED. A partial report rendered as a whole one is the one
    // failure this feature cannot afford: the reader cannot see what is
    // missing, so a truncated requirement map reads as a short description
    // rather than as a broken report.
    console.error('fit: the model did not return a valid report', parsed.error?.message);
    throw new FitUnavailable('The fit engine returned an unusable answer. Try again shortly.');
  }

  const { report, audit } = enforceCitations(parsed.data, corpus.allowedUrls);
  if (audit.dropped > 0) {
    // Worth a log line of its own: a non-zero drop count is the earliest
    // signal that the prompt has started fabricating, and 04 §4's eval suite
    // asserts zero on the golden cases for exactly that reason.
    console.warn(`fit: dropped ${audit.dropped} of ${audit.checked} citations as unresolvable`);
  }

  return {
    report,
    citations: audit,
    model: FIT_MODEL,
    generatedAt: new Date().toISOString(),
    corpusDocuments: corpus.documents,
    corpusTruncated: corpus.truncated,
  };
}
