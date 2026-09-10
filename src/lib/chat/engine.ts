import CHAT_PROMPT from '../../../prompts/chat.md?raw';
import { BREAKER_KEY } from '../fit/engine';
import { CORPUS_TIER, documentKey, readCorpusManifest } from '../corpus';
import { fetchDocument, fetchDocumentIndex, pageUrlFor, type DocumentsEnv } from '../mcp/documents';
import { citationFor, embedQuery, parseChunkId, UNKNOWN_CHUNK_COUNT } from '../mcp/search';
import type { ChatErrorCode } from './errors';
import { CHAT_TOP_K, numberSources, renderChatContext, type ChatSource } from './context';

// The grounded chat engine (04 §1). Retrieval, the guards, and the model call.
// It returns a STREAM and the sources that stream was grounded on, and nothing
// else -- the transcript, the audit row and the downstream framing belong to the
// caller (workers/mcp/src/chat.ts), because this module has no opinion about who
// is listening.
//
// ONE PLACE INFERENCE IS SPENT PER FEATURE. `src/lib/fit/engine.ts` says it is
// "the only place in the repo that spends inference"; that sentence was true
// when written and is now half of the truth. Fit spends Opus over the whole
// corpus once per report; this spends Sonnet over eight retrieved passages per
// message. Both go through the same gateway id with a `surface` tag so the
// gateway's own logs can tell them apart -- which 10 §5 established is the only
// reliable signal that routing worked at all.

/** 04 §1 specifies Sonnet for chat; the fit engine's own comment records both models measured working through this route on 2026-09-09. */
export const CHAT_MODEL = 'anthropic/claude-sonnet-5';

/**
 * Enough for a grounded answer of a few paragraphs with citations, and not
 * enough to pay for an essay. A truncated chat answer is a visible, ordinary
 * failure -- the reader sees it stop -- which is why this needs no equivalent
 * of the fit engine's `stop_reason === 'max_tokens'` refusal: there, a short
 * report reads as a complete one and the reader cannot tell.
 *
 * MEASURED SUFFICIENT, 2026-09-10 (the same probe as the framing note below): a
 * realistic grounded question over one fenced source answered in 183 output
 * tokens and stopped at `end_turn`, with room to spare. See that note for why
 * the thinking budget does not eat into this the way the first probe suggested.
 */
export const CHAT_MAX_TOKENS = 1024;

// THE UPSTREAM STREAM, MEASURED 2026-09-10 rather than taken from the docs.
// `wrangler dev --config workers/mcp/wrangler.jsonc`, a temporary `/chat-probe`
// route calling this binding with `stream: true` and piping the raw bytes back,
// `curl -sN`. The probe route was deleted before committing. What came back:
//
//   - `event:` LINES ARE PRESENT alongside `data:` lines, one of each per frame,
//     separated by a blank line. Frames observed, in order: `message_start`,
//     `content_block_start`, `ping`, `content_block_delta` (xN),
//     `content_block_stop`, `message_delta`, `message_stop`.
//   - THE STREAM TERMINATES WITH `message_stop`, which is what `parseModelSse`
//     reports as `done`.
//   - THE MODEL MAY EMIT A THINKING BLOCK FIRST, and this is the finding worth
//     having gone and looked. The trivial probe produced content block index 0
//     of type `thinking` carrying `thinking_delta` and `signature_delta`, with
//     the answer's `text_delta` frames arriving later at index 1. So the text of
//     an answer is NOT reliably at index 0, and a parser keyed on the block
//     index would silently return a signature blob as the answer. Filtering on
//     `delta.type === 'text_delta'` -- which is what ./protocol.ts does -- is
//     correct and is correct for this reason rather than by luck.
//   - THINKING IS ADAPTIVE, not always on. The trivial prompt spent 23 thinking
//     tokens of 34; the realistic grounded prompt above spent ZERO, all 183
//     going to the answer. So `CHAT_MAX_TOKENS` is not quietly halved by a
//     reasoning budget on the shape of request this feature actually makes.
//   - `data:` PAYLOADS CARRY TRAILING WHITESPACE inside the JSON envelope
//     (`{"type":"message_stop"         }`). Harmless, and `parseModelSse`
//     trims before parsing anyway -- recorded because a stricter parser written
//     later would trip on it.

/** Long enough for a real question, short enough that nobody pastes a document into the grounding path. */
export const MAX_QUESTION_CHARS = 1000;

// 04 §1's daily global cap is NOT here. It is `GLOBAL_LIMITS.chat` in
// src/lib/mcp/limits.ts, enforced by the same Durable Object as the per-caller
// limit and checked at the endpoint (workers/mcp/src/chat.ts) before this
// module is reached. A KV counter here was the first design and was wrong for a
// reason worth carrying: it would have been a second, approximate accounting of
// a number the limiter already counts exactly.

export class ChatUnavailable extends Error {
  readonly code: ChatErrorCode;
  constructor(code: ChatErrorCode, message: string) {
    super(message);
    // Same reason as `FitUnavailable`: `Error` takes `name` from the prototype,
    // and a subclass that crosses a service binding is structured-cloned, so
    // the name is what the far side has left to recognise.
    this.name = 'ChatUnavailable';
    this.code = code;
  }
}

export interface ChatEnv extends DocumentsEnv {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  KV_CONFIG: KVNamespace;
  KV_CACHE: KVNamespace;
  RLME_AI_GATEWAY_ID: string;
  /**
   * Test-only seam, the same shape as `FIT_ENGINE`: no deployed config declares
   * it, `'off'` refuses before anything is read or spent, and an unrecognised
   * value throws. tests/workers.ts sets it on the MCP Worker because the
   * harness overrides `AI` to a service binding, so `env.AI.run` is a TypeError
   * there by design.
   */
  CHAT_ENGINE?: string;
}

/**
 * The fence long enough to enclose the question.
 *
 * The question is the ONLY untrusted input on this path, and this is its whole
 * boundary -- the same argument, word for word, as `fenceFor` in
 * src/lib/fit/engine.ts. What the fence bounds is what the model treats as
 * data; what it cannot bound is what a steered model then writes, which is why
 * citation numbers rather than URLs are the second half of the defence.
 */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The passages this question retrieves, numbered.
 *
 * Reuses day 4's `search_writing` machinery rather than growing a second
 * retrieval path: the same query-side embedding call, the same Vectorize
 * filter, the same `citationFor` excerpt reconstruction with the same manifest
 * check. A second implementation would be a second place for the `queries` /
 * `documents` distinction to be got wrong -- the one that degrades retrieval
 * silently and forever (workers/mcp/wrangler.jsonc records the measurement).
 */
export async function retrieve(env: ChatEnv, question: string): Promise<ChatSource[]> {
  const vector = await embedQuery(env.AI, question);
  const found = await env.VECTORIZE.query(vector, {
    topK: CHAT_TOP_K,
    returnMetadata: 'indexed',
    // The same structural-intent line `search_writing` carries, and the same
    // transferred obligation: the day something embeds a non-public document,
    // this filter stops being sufficient and a separate index has to be built
    // in the same change.
    filter: { tier: CORPUS_TIER },
  });
  if (found.matches.length === 0) return [];

  const [manifest, index] = await Promise.all([readCorpusManifest(env), fetchDocumentIndex(env)]);

  const citations = [];
  for (const match of found.matches) {
    const parsed = parseChunkId(match.id);
    if (parsed === null) continue;
    const source = index.find((entry) => entry.type === parsed.type && entry.slug === parsed.slug);
    if (source === undefined) continue;
    const markdown = await fetchDocument(env, source);
    if (markdown === null) continue;
    citations.push(
      citationFor({
        type: parsed.type,
        slug: parsed.slug,
        chunk: parsed.chunk,
        score: match.score,
        url: pageUrlFor(source, env.SITE_ORIGIN),
        markdown,
        expectedChunks: manifest[documentKey(source)]?.chunks ?? UNKNOWN_CHUNK_COUNT,
      }),
    );
  }
  return numberSources(citations);
}

/**
 * Every guard, then the model call, then the stream.
 *
 * ORDER IS COST ORDER, the same rule `analyzeFit` follows: nothing is read
 * before the checks that need no reads; the breaker comes before the model; the
 * model comes last. A refused message should spend nothing it did not have to.
 *
 * THE SHAPE CHECKS COME BEFORE THE SEAM, and the two orderings are not
 * interchangeable. `CHAT_ENGINE: 'off'` is an ENVIRONMENT condition and the
 * question's shape is a CALLER condition, and when both hold the caller's is
 * the more useful thing to report: an empty box should say "ask something
 * first" whether or not the environment behind it happens to have an engine.
 * The concrete forcing case is tests/chat-endpoint.test.ts, which runs the
 * whole endpoint with the seam off -- so if the seam were checked first, every
 * `empty` and `too-long` assertion in that suite would receive `unreachable`
 * and the two codes would be untestable anywhere. Neither check costs a read,
 * so nothing is traded for the swap.
 */
export async function startAnswer(
  env: ChatEnv,
  question: string,
  sources: readonly ChatSource[],
): Promise<{ stream: ReadableStream<Uint8Array>; included: ChatSource[] }> {
  const asked = question.trim();
  if (asked.length === 0) throw new ChatUnavailable('empty', 'Ask something first.');
  if (asked.length > MAX_QUESTION_CHARS) {
    throw new ChatUnavailable('too-long', 'That question is longer than this box takes.');
  }

  if (env.CHAT_ENGINE !== undefined && env.CHAT_ENGINE !== 'off') {
    // A plain Error, deliberately not a ChatUnavailable: a mis-set var is an
    // operator's mistake and must never be dressed up as an outage.
    throw new Error(`unrecognised CHAT_ENGINE: ${env.CHAT_ENGINE}`);
  }
  if (env.CHAT_ENGINE === 'off') {
    throw new ChatUnavailable('unreachable', 'Chat is not available in this environment.');
  }

  // The breaker, read before anything is spent and FAILING CLOSED on a KV error
  // -- the same reasoning as the fit engine's: the safe answer to "I cannot
  // tell whether the budget is exhausted" is to refuse.
  let tripped: string | null;
  try {
    tripped = await env.KV_CONFIG.get(BREAKER_KEY);
  } catch (error) {
    console.error('chat: the breaker flag could not be read', error);
    throw new ChatUnavailable('paused', 'Chat is unavailable right now. Try again shortly.');
  }
  if (tripped !== null) {
    throw new ChatUnavailable('paused', 'Chat is paused: the daily budget breaker is tripped.');
  }

  if (sources.length === 0) {
    throw new ChatUnavailable('no-answer', 'Nothing in the corpus matched that.');
  }

  const { text: context, included } = renderChatContext(sources);
  const fence = fenceFor(asked);
  const user = ['# Sources', '', context, '', '# Question', '', `${fence}text`, asked, fence].join(
    '\n',
  );

  let raw: unknown;
  try {
    raw = await env.AI.run(
      CHAT_MODEL,
      {
        max_tokens: CHAT_MAX_TOKENS,
        system: CHAT_PROMPT,
        messages: [{ role: 'user', content: user }],
        // 10 §5, measured: `temperature`, `top_p` and `top_k` are rejected with
        // `7003: User Input Error` through this binding. Absent, not optional.
        stream: true,
      },
      {
        gateway: { id: env.RLME_AI_GATEWAY_ID, metadata: { surface: 'chat' } },
      },
    );
  } catch (error) {
    // The message is written HERE rather than derived from whatever threw. An
    // `AiError: 2018 …` reaching a reader would publish the gateway's internals
    // and tell them a rate limit was hit when what happened is that chat is
    // unavailable.
    console.error('chat: the model call failed', error);
    throw new ChatUnavailable('unreachable', 'The chat service could not be reached.');
  }

  if (!(raw instanceof ReadableStream)) {
    // `stream: true` returning a plain object means the route silently fell
    // back to a non-streaming completion -- possible if a model or a gateway
    // stops honouring the flag. Refusing is right: the caller's whole contract
    // is a stream, and quietly answering with one frame containing everything
    // would hide a routing change nobody chose.
    console.error('chat: the binding returned a non-stream response for a streaming call');
    throw new ChatUnavailable('no-answer', 'The chat service returned nothing usable.');
  }

  // `included` IS RETURNED, NOT DISCARDED, and this is the half of the citation
  // guarantee that lives outside ./context.ts. That module's contract is that a
  // source dropped for budget "loses its number entirely, so the model cannot
  // cite it" -- but that is only true if the CALLER also forgets it. If the
  // endpoint emitted the full `sources` list, a reader would be shown a
  // numbered source the model was never given, and `citationsIn(answer,
  // sources.length)` would score a citation to it as valid rather than
  // fabricated. Returning the two together makes the pair impossible to get
  // wrong: there is no `sources` in scope at the call site to reach for.
  //
  // Nothing is dropped at today's sizes -- CHAT_TOP_K is 8 excerpts against a
  // 24,000-character budget -- which is exactly why this has to be structural.
  // A guarantee that holds only because the numbers are small is one that
  // breaks silently the first time the corpus grows.
  return { stream: raw, included };
}
