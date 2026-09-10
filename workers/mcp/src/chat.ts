import { citationsIn, type ChatSource } from '../../../src/lib/chat/context';
import {
  CHAT_MODEL,
  ChatUnavailable,
  retrieve,
  startAnswer,
  type ChatEnv,
} from '../../../src/lib/chat/engine';
import type { ChatErrorCode } from '../../../src/lib/chat/errors';
import { parseModelSse, sseFrame } from '../../../src/lib/chat/protocol';
import { checkGlobalLimit, checkLimit } from '../../../src/lib/mcp/limits';
import { resolveGrant } from '../../../src/lib/tier/grant';
import { verifyTurnstile } from '../../../src/lib/turnstile';
import type { McpEnv } from './env';

// `POST /chat` (04 §1). NOT AN MCP TOOL, and the asymmetry is worth naming
// because every other inference path in this Worker goes through `defineTool`:
// 04 §1 requires a streamed answer, and a `tools/call` result is one payload.
// So this route re-implements, explicitly, the three things `defineTool` would
// have given it for free -- the limiter, the audit row and the error shape --
// and a reviewer should check those three rather than assume them.
//
// PUBLICLY REACHABLE AT mcp.ryanlindsey.me/chat, AND NOT ANONYMOUSLY USABLE.
// Admission takes one of two credentials and refuses without either:
//
//   1. A Turnstile response token, VERIFIED HERE rather than at the site. The
//      site cannot prove to this Worker that a request came through it -- a
//      service-binding hop carries no forgery-proof marker -- but it does not
//      need to: it can hand over something this Worker can check itself, and a
//      Turnstile token is single-use and short-lived, with siteverify rejecting
//      a replay as `timeout-or-duplicate`. EXACTLY ONE WORKER MAY VERIFY A
//      GIVEN TOKEN. If src/pages/chat/send.ts also verified, it would consume
//      the token and this check would fail as a duplicate -- so that route
//      forwards and does not verify, and reversing either half breaks the
//      other. (/fit is unchanged and still verifies at the site: it serves that
//      form. One verification per form, not one per repo.)
//   2. A grant carrying the `evals` scope, for evals/run.mjs, which cannot
//      solve a challenge. A grant is already a credential, already limited and
//      already revocable, and `resolveGrant` is already the single place a
//      token is verified in this system.
//
// The version this replaces left the endpoint open and leaned on the per-IP
// limiter. That is written down rather than forgotten because the reasoning
// failed in an instructive way: a per-IP bucket does not bind a distributed
// caller, so the only real ceiling was a global daily count -- and exhausting
// it does not merely cost money, it takes chat away from every real visitor
// until the bucket refills.
//
// NO CORS HEADERS, unlike /mcp. That opening was argued for on the grounds that
// there is no ambient credential to borrow; it is still true here, but the
// argument buys nothing, because no third-party page has a reason to read this
// stream. Omitting them is free and narrows the surface.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  // Cloudflare and intermediary proxies buffer by default; without this a
  // "streaming" answer arrives in one lump and the whole feature looks broken
  // in a way no test in this repo would catch.
  'x-accel-buffering': 'no',
};

function errorResponse(code: ChatErrorCode): Response {
  // 200 WITH AN ERROR FRAME, not an HTTP error status. The client is an
  // EventSource-shaped reader over `fetch`, and a non-200 gives it a body it
  // has no path to parse -- so every refusal a caller can provoke is delivered
  // in the protocol rather than around it. The two exceptions above (405, 400)
  // are requests that never became a chat turn at all.
  return new Response(sseFrame('error', { code }), { headers: STREAM_HEADERS });
}

interface TranscriptRow {
  sessionId: string;
  question: string;
  answer: string;
  sources: readonly ChatSource[];
  cited: number;
  invalid: number;
  outcome: 'ok' | 'refused' | 'error';
  durationMs: number;
  surface: 'site' | 'direct';
}

async function writeTranscript(env: McpEnv, row: TranscriptRow): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO chat_turns
         (id, session_id, created_at, question, answer, model, sources_json,
          cited, invalid_citations, outcome, duration_ms, surface)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        row.sessionId,
        new Date().toISOString(),
        row.question,
        row.answer,
        CHAT_MODEL,
        JSON.stringify(row.sources.map(({ n, title, url, exact }) => ({ n, title, url, exact }))),
        row.cited,
        row.invalid,
        row.outcome,
        row.durationMs,
        row.surface,
      )
      .run();
  } catch (error) {
    // Swallowed after logging, the same trade `recordToolCall` makes: a
    // transcript write that fails must not turn a working answer into an error.
    console.error('chat: the transcript row could not be written', error);
  }
}

export async function handleChat(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  const started = Date.now();
  let body: { question?: unknown; sessionId?: unknown; turnstileResponse?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }

  const question = typeof body.question === 'string' ? body.question : '';
  const sessionId =
    typeof body.sessionId === 'string' && SESSION_ID.test(body.sessionId)
      ? body.sessionId
      : crypto.randomUUID();
  // The site's own caller identifies itself the way src/lib/fit/client.ts does.
  // Told apart because they are different audiences with different costs, not
  // because one is trusted more -- nothing here branches on it except the
  // transcript column.
  const surface = request.headers.get('user-agent')?.startsWith('ryanlindsey-me-chat')
    ? ('site' as const)
    : ('direct' as const);

  const refuse = (code: ChatErrorCode, outcome: 'refused' | 'error' = 'refused') => {
    ctx.waitUntil(
      writeTranscript(env, {
        sessionId,
        question,
        answer: '',
        sources: [],
        cited: 0,
        invalid: 0,
        outcome,
        durationMs: Date.now() - started,
        surface,
      }),
    );
    return errorResponse(code);
  };

  // ADMISSION, FIRST AND CHEAPEST. Ordered so the free check runs before the
  // paid one: a presented grant is a D1 read this Worker would do anyway, and
  // Turnstile is a network round trip to challenges.cloudflare.com.
  const { grant } = await resolveGrant(env, request, Math.floor(Date.now() / 1000));
  const admitted = grant?.scopes.includes('evals') === true;
  if (!admitted) {
    const turnstile = await verifyTurnstile(
      env,
      typeof body.turnstileResponse === 'string' && body.turnstileResponse !== ''
        ? body.turnstileResponse
        : null,
      request.headers.get('cf-connecting-ip'),
    );
    if (!turnstile.ok) {
      console.warn(`chat: refused admission (${turnstile.codes.join(', ')})`);
      return refuse('bot-check');
    }
  }

  // The per-caller limiter, then the feature-wide cap. Both before retrieval and
  // before the model -- a refused caller should cost an embedding call and a
  // Vectorize query no more than it costs a Sonnet call.
  //
  // `null` grant is passed even when one exists, deliberately: an `evals` token
  // is the eval harness, and keying its bucket by `jti` would give the harness
  // an allowance separate from everyone else's on the one endpoint where the
  // point of the limit is the total. The address is the right key here for both
  // kinds of caller.
  if (!(await checkLimit(env, 'conversation', request, 'chat', null))) {
    return refuse('rate-limited');
  }
  // The daily global cap (04 §1), exact rather than approximate -- see
  // `GLOBAL_LIMITS` in src/lib/mcp/limits.ts for why this is a Durable Object
  // and not a KV counter. Charged BEFORE the model call, so a stream that fails
  // still costs its slot: overcounting a failure is the direction to err in.
  if (!(await checkGlobalLimit(env, 'chat'))) {
    console.warn('chat: the daily global cap is exhausted');
    return refuse('paused');
  }

  let sources: ChatSource[] = [];
  try {
    sources = await retrieve(env as unknown as ChatEnv, question.trim());
  } catch (error) {
    // Retrieval failing is not the same as the model failing, and the reader
    // gets the same sentence either way -- but the operator gets the
    // distinction in the log, which is where it is actionable.
    console.error('chat: retrieval failed', error);
  }

  // `shown` is the subset the model was actually given -- see `startAnswer`'s
  // return comment. Everything downstream of here (the `sources` frame, the
  // citation arithmetic, the transcript's `sources_json`) uses IT and never
  // `sources`, so a source dropped for budget is invisible to the reader, to
  // the scorer and to the audit alike.
  let upstream: ReadableStream<Uint8Array>;
  let shown: ChatSource[];
  try {
    ({ stream: upstream, included: shown } = await startAnswer(
      env as unknown as ChatEnv,
      question,
      sources,
    ));
  } catch (error) {
    if (error instanceof ChatUnavailable) return refuse(error.code);
    // A plain Error here is a mis-set seam var (the engine's own contract), and
    // it is an operator's mistake rather than a caller's: the stack goes to
    // observability, the caller gets the generic code.
    console.error('chat: the engine threw before producing a stream', error);
    return refuse('unreachable', 'error');
  }

  // PR 2, TASK 3 ADDS THE HIGH-INTENT SEND HERE: the first turn of a session is
  // high intent (06 §3), and this is the only place it is observable, since the
  // site holds no state across messages. Nothing stands in for it on this
  // branch -- `env.EVENTS` is not bound on this Worker yet and
  // src/lib/agent-intel/intent.ts does not exist.

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffered = '';
  let answer = '';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // SOURCES FIRST, before a single token. The page renders the evidence
      // list while the answer is still being written, which is the whole
      // difference between citations that are checkable and citations that
      // arrive as an afterthought -- and it is only possible because the
      // numbering is decided server-side before the model is called.
      controller.enqueue(
        encoder.encode(
          sseFrame('sources', {
            sources: shown.map(({ n, title, url, exact }) => ({ n, title, url, exact })),
          }),
        ),
      );

      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const parsed = parseModelSse(buffered);
          buffered = parsed.rest;
          if (parsed.text !== '') {
            answer += parsed.text;
            controller.enqueue(encoder.encode(sseFrame('delta', { text: parsed.text })));
          }
          if (parsed.done) break;
        }
      } catch (error) {
        // MID-ANSWER FAILURE. The reader already has text on screen, so the
        // honest ending is an error frame appended to what arrived rather than
        // a replacement -- silently stopping would read as a complete answer
        // that happens to trail off.
        console.error('chat: the upstream stream broke mid-answer', error);
        controller.enqueue(encoder.encode(sseFrame('error', { code: 'unreachable' })));
      } finally {
        reader.releaseLock();
      }

      const { cited, invalid } = citationsIn(answer, shown.length);
      controller.enqueue(encoder.encode(sseFrame('done', { cited, model: CHAT_MODEL })));
      controller.close();

      if (invalid.length > 0) {
        // The earliest fabrication signal this feature has. A log line of its
        // own for the same reason the fit engine logs a dropped citation: it is
        // a prompt-quality regression, and the eval suite asserts zero on the
        // golden set precisely so this line stays rare.
        console.warn(`chat: the answer cited ${invalid.length} source(s) that do not exist`);
      }
      ctx.waitUntil(
        writeTranscript(env, {
          sessionId,
          question,
          answer,
          sources: shown,
          cited: cited.length,
          invalid: invalid.length,
          outcome: answer === '' ? 'error' : 'ok',
          durationMs: Date.now() - started,
          surface,
        }),
      );
      // PR 2, TASK 2 ADDS THE ANALYTICS DATAPOINT HERE (and in `refuse` above),
      // once src/lib/agent-intel/record.ts exists.
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}
