// The fit engine (03 §4, 04 §2). ONE engine, two frontends: the `analyze_fit`
// MCP tool calls it, and `/fit` calls that tool over the service binding. This
// module is the only place in the repo that spends inference.
//
// GENERIC by construction (09 §2): `analyzeFit(env, targetDescription)`. It
// does not know, and must never learn, what a target description is for.

import { buildCorpusContext } from './corpus-context';
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
 * How this module calls the binding, written out rather than borrowed.
 *
 * The generated `Ai.run` is `run<Name extends keyof AiModels>(model: Name,
 * inputs: AiModels[Name]['inputs'], ...)`, and `AiModels` lists only Cloudflare's
 * own catalogue -- `worker-configuration.d.ts` contains no `anthropic/` entry at
 * all, and neither does `wrangler ai models`. A partner model therefore has no
 * generated overload to satisfy, so the choice is between casting the arguments
 * away (`as never`, which typechecks anything) and naming the shape here.
 *
 * Naming it is worth the twelve lines, because the shape IS the measurement.
 * `temperature`, `top_p` and `top_k` are ABSENT rather than optional -- 10 §5
 * measured all three being rejected with `7003: User Input Error` -- and
 * `tool_choice` is required rather than optional, because a forced tool call is
 * the whole mechanism by which this call returns structured output. There is no
 * `response_format`: that is an OpenAI field, and Anthropic does not have it.
 * A future edit that adds a sampling knob now has to add it to a type whose
 * comment says why it is not there.
 */
interface AnthropicMessagesBinding {
  run(
    model: string,
    inputs: {
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string }[];
      tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
      tool_choice: { type: 'tool'; name: string };
    },
    options: AiOptions,
  ): Promise<unknown>;
}

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
 * Every path out of this module that is not a report is one of these, and the
 * message is written here rather than derived from whatever threw -- an
 * `AiError: 2018 …` reaching a caller would publish the gateway's internals
 * and, worse, tell them a rate limit was hit rather than that the engine is
 * unavailable.
 */
export class FitUnavailable extends Error {}

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
 */
export function extractToolInput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return null;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as { type?: unknown; input?: unknown };
    if (entry.type === 'tool_use' && entry.input !== undefined) return entry.input;
  }
  return null;
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
  if ((await env.KV_CONFIG.get(BREAKER_KEY)) !== null) {
    throw new FitUnavailable(
      'Fit analysis is paused: the daily inference budget breaker is tripped. It resets automatically.',
    );
  }

  const corpus = await buildCorpusContext(env);
  if (corpus.documents === 0) {
    throw new FitUnavailable('The corpus is empty right now, so there is nothing to compare.');
  }

  // The description is FENCED, like every corpus document, and the prompt
  // tells the model to treat fenced content as data. It is text a stranger
  // pasted, and this is the boundary.
  const user = [
    '# Corpus',
    '',
    corpus.text,
    '',
    '# Target description',
    '',
    '```text',
    description,
    '```',
  ].join('\n');

  let raw: unknown;
  try {
    raw = await (env.AI as unknown as AnthropicMessagesBinding).run(
      FIT_MODEL,
      {
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
      },
      {
        gateway: {
          id: env.RLME_AI_GATEWAY_ID,
          // Attribution in the gateway's own logs, which 10 §5 established
          // are the only reliable signal that routing worked --
          // `aiGatewayLogId` was null on every probe regardless of whether
          // the call went through the gateway.
          metadata: { surface: 'fit' },
        },
      },
    );
  } catch (error) {
    console.error('fit: model call failed', error);
    throw new FitUnavailable('The fit engine could not be reached right now. Try again shortly.');
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
