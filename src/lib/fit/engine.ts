// The fit engine (03 §4, 04 §2). ONE engine, two frontends: the `analyze_fit`
// MCP tool calls it, and `/fit` calls that tool over the service binding. This
// module is the only place in the repo that spends inference.
//
// GENERIC by construction (09 §2): `analyzeFit(env, targetDescription)`. It
// does not know, and must never learn, what a target description is for.

import { buildCorpusContext, type CorpusContext } from './corpus-context';
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
 * The spacing is not superstition: 10 §5 records the gateway capping at 50
 * requests/minute and answering an exceeded cap with `2018: Invalid User
 * Credentials`, which READS AS AN AUTH FAILURE AND IS NOT. Two passes of spike
 * conclusions were wrong before that was spotted. Anyone re-probing these
 * values should space the calls and disbelieve a 2018.
 */
export const FIT_MODEL = 'anthropic/claude-opus-5';
export const FIT_FALLBACK_MODEL = 'anthropic/claude-sonnet-5';

/**
 * Required by this binding, and the ONLY sampling-adjacent parameter it
 * accepts: 10 §5 measured `temperature`, `top_p` and `top_k` being rejected
 * with `7003: User Input Error`, deterministically. Do not add them.
 */
export const FIT_MAX_TOKENS = 4096;

/** The daily breaker flag (04 §5). Any value at all means tripped. */
export const BREAKER_KEY = 'breaker:inference';

/** The forced tool's name. The model returns the report as this tool's input. */
const EMIT_TOOL = 'emit_fit_report';

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
 * `'anthropic/claude-opus-5'` -- not a key of `AiModelList`, the generated map
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
 * `7003: User Input Error` -- and `tool_choice` is required rather than
 * optional, because a forced tool call is the whole mechanism by which this
 * call returns structured output. There is no `response_format`: that is an
 * OpenAI field, and Anthropic does not have it. A future edit that adds a
 * sampling knob now has to add it to a type whose comment says why it is not
 * there.
 */
type FitModelInput = {
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  tool_choice: { type: 'tool'; name: string };
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
}

/**
 * The forced tool call's input, or `null`.
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
export function extractToolInput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return null;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as { type?: unknown; name?: unknown; input?: unknown };
    if (entry.type !== 'tool_use' || entry.input === undefined) continue;
    if (entry.name !== undefined && entry.name !== EMIT_TOOL) continue;
    return entry.input;
  }
  return null;
}

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
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Compares the published corpus against one target description.
 *
 * ORDER MATTERS, and every refusal below is placed to cost nothing: the seam,
 * the breaker and the empty-input check come before the corpus is even
 * fetched, and the corpus fetch comes before the model call. A refused run
 * should spend no neurons and no subrequests it did not have to.
 */
export async function analyzeFit(env: FitEnv, targetDescription: string): Promise<FitResult> {
  if (env.FIT_ENGINE !== undefined && env.FIT_ENGINE !== 'off') {
    // A plain Error, deliberately NOT a FitUnavailable: this is a
    // misconfiguration rather than an outage, and a caller must never be given
    // a polite sentence about it. The other seams in this repo throw here too.
    throw new Error(`unrecognised FIT_ENGINE: ${env.FIT_ENGINE}`);
  }
  if (env.FIT_ENGINE === 'off') {
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
    throw new FitUnavailable('The corpus could not be read right now. Try again shortly.');
  }
  if (corpus.documents === 0) {
    throw new FitUnavailable('The corpus is empty right now, so there is nothing to compare.');
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
    tools: [
      {
        name: EMIT_TOOL,
        description: 'Return the completed fit report.',
        input_schema: FIT_REPORT_JSON_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: EMIT_TOOL },
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
  // see what is missing. `FIT_MAX_TOKENS` has NOT been validated against a real
  // five-to-twelve-requirement report (Task 10's probes capped at 16 tokens),
  // so this is the guard standing in for that measurement until 04 §4's eval
  // suite supplies it. The signal is already in the envelope; it only had to be
  // read.
  if (raw.stop_reason === 'max_tokens') {
    console.error(`fit: the model hit the ${FIT_MAX_TOKENS}-token cap and the report is truncated`);
    throw new FitUnavailable('The fit engine returned an incomplete answer. Try again shortly.');
  }

  const parsed = FitReport.safeParse(extractToolInput(raw));
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
  };
}
