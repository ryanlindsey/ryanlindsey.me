import { classifyRequest, signalsFrom } from '../../../src/lib/agent-intel/classify';
import { highIntentFor, type IntentEvent } from '../../../src/lib/agent-intel/intent';
import { recordAgentEvent, type AgentEvent } from '../../../src/lib/agent-intel/record';
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

// THE ONE PLACE THIS WORKER WOULD READ CAMPAIGN DOMAINS, and does not, for the
// identical reason src/worker.ts's own `CAMPAIGN_DOMAINS_OFF` does not: they
// live in KV, and this route has no more cause to pay a KV read per turn than
// the site has to pay one per request. `classifyRequest`'s campaign label is
// therefore unavailable here; the referrer still classifies as `social` or
// `search` where it applies.
const CAMPAIGN_DOMAINS_OFF: readonly string[] = [];

/**
 * The AE event both `recordAgentEvent` call sites in this file share.
 * EXTRACTED, rather than an object literal at each site, specifically so
 * Ruling 1 (task-13a-brief.md) has something to fail against: this route's
 * `surface` is ALWAYS the literal `'chat'`, and this function's signature
 * does not accept a caller-supplied one -- so it cannot be confused with the
 * `surface` local in `handleChat` below (`'site' | 'direct'`, the transcript
 * column's own, unrelated vocabulary, which happens to share the string
 * `'site'` with this one) the way an inline `{ ..., surface, ... }` could be
 * confused by a future edit. Tested directly in
 * tests/chat-endpoint.test.ts, and (fix round 1, task-13a-findings-r1.md) so
 * is `refuse`'s call site's actual effect, end to end -- see that file's
 * comment for why the end-of-stream call site is the one still asserted only
 * at this remove.
 */
export function chatAgentEvent(request: Request, status: number, durationMs: number): AgentEvent {
  return {
    classification: classifyRequest(signalsFrom(request), CAMPAIGN_DOMAINS_OFF),
    surface: 'chat',
    status,
    durationMs,
  };
}

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

/**
 * Whether `sessionId` has no COMPLETED (`outcome = 'ok'`) `chat_turns` row
 * yet -- i.e. whether the turn about to be answered is the first of its
 * session to actually produce an answer, which 06 §3 treats as high intent.
 *
 * NOT "no row at all", and that correction has a name:
 * task-13a-findings-final.md's Important 1, a defect in the controller's own
 * Ruling 4 rather than in how it was implemented. `refuse` (below) writes a
 * `chat_turns` row for EVERY refusal too -- `bot-check`, `rate-limited`,
 * `paused`, `empty`, `too-long`, `unreachable` -- so an unfiltered "any row"
 * read meant a visitor whose first interaction was refused (a fat-fingered
 * empty submit, a Turnstile hiccup, a limiter trip on a shared IP) never
 * generated the session's one notification AT ALL: their session had a row,
 * so it was never "first" again even once they went on to ask a real
 * question. The `outcome = 'ok'` filter answers the question the operator is
 * actually being told the answer to -- "has this session produced an answer
 * before" -- rather than "does this session id appear in the table".
 *
 * THE ACCEPTED TRADE, in the opposite direction from the failed-read
 * fallback below on purpose: a session whose first answer breaks mid-stream
 * (`outcome: 'error'`, set when the model stream dies before producing any
 * text) does not count as a completed first turn either, so that session can
 * notify a SECOND time on its next turn. Over-notifying on a rare broken
 * stream costs one duplicate email; under-notifying loses the signal for
 * every session that happened to start that way, which is the exact failure
 * this correction exists to close. A D1 read failing is the reverse
 * situation -- no positive signal that a real answer landed, only silence --
 * so it fails closed instead; see that comment below.
 *
 * EXPORTED so this D1 read is directly testable: the obvious way to exercise
 * it -- send two real turns and see the second one not counted -- needs a
 * working model call, and this endpoint's test harness cannot make one
 * (`env.CHAT_ENGINE` is `'off'` in tests/workers.ts, which makes
 * `startAnswer` throw before the call site below is ever reached). Seeding
 * `chat_turns` through `env.DB` and calling this function directly is the
 * real observation point instead.
 *
 * Reads rather than trusting a client-supplied flag, and the reason is
 * concrete rather than defensive: `src/pages/chat.astro` mints its session id
 * with `crypto.randomUUID()` once per page load and sends it from the first
 * message onward, so there is no "the server minted this id" moment for a
 * real client to signal -- a flag would report every turn as first. (A
 * DIFFERENT client -- one that sends no session id at all -- is handled by
 * `chatHighIntentEvent` below, as a negative filter rather than here.)
 *
 * `writeTranscript` for the CURRENT turn has not run yet at the call site
 * below -- it happens later, inside `waitUntil` -- so this can never see its
 * own row and double-count nothing.
 *
 * A failed read reports NOT first rather than throwing or guessing true. This
 * decision's only output is an email (the high-intent fan-out), and a D1 blip
 * that silently sends a notification is a worse failure than one that
 * silently skips it.
 */
export async function firstOfSession(env: McpEnv, sessionId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 FROM chat_turns WHERE session_id = ? AND outcome = 'ok' LIMIT 1`,
    )
      .bind(sessionId)
      .first();
    // Loose equality, deliberately: D1's documented contract for `.first()`
    // with no matching row is `null`, so `=== null` is correct today, but
    // this comparison sits on a fail-closed path whose failure mode is "no
    // email ever sent, silently" -- an `undefined` this comparison missed
    // would be exactly as invisible as the gap this task exists to close.
    // `== null` catches both without caring which one shows up.
    return row == null;
  } catch (error) {
    console.error('chat: the first-of-session read failed; treating this turn as not first', error);
    return false;
  }
}

/**
 * Whether THIS turn should queue a `chat-session` high-intent event, and the
 * event to send if so.
 *
 * GATED ON `callerSuppliedSession`, not only on `firstOfSession` above --
 * task-13a-findings-final.md's Important 2, a live consequence rather than a
 * hypothetical one. `evals/run.mjs`'s `askOnce` sends `{ question }` with NO
 * `sessionId` at all, so the server mints a fresh one every turn, and a
 * freshly minted UUID is ALWAYS first-of-session by `firstOfSession`'s own
 * (correct) logic. That suite's 4 chat cases plus 8 leak probes is 12 chat
 * turns per eval run, each queuing an indistinguishable `chat-session`
 * event with an empty `detail` (`notify.ts` renders it as `<at>  chat-session`
 * and nothing else, because there is no caller identity to render) -- 2-3
 * operator emails, every time the eval suite runs. WITHOUT THIS GATE,
 * RUNNING THE EVALS PAGES THE OPERATOR.
 *
 * THIS DOES NOT CONTRADICT RULING 4 (above), which rejects "the server
 * minted the id ⇒ this is the first turn" as a POSITIVE test for
 * `firstOfSession` to use -- it still does not use it, and D1 is still the
 * only thing that decides "first". Using server-minted-ness as a NEGATIVE
 * filter here is a different proposition and is sound on its own terms: a
 * caller that sent no session id at all has no session, so it has no first
 * turn of one to report.
 *
 * NOR DOES IT CONTRADICT RULING 1 (task-13a-brief.md), which is about the AE
 * row staying unconditional so evals and every direct caller stay visible in
 * `/ops` -- `chatAgentEvent`/`recordAgentEvent` are untouched by this gate
 * and record exactly as before. Only the QUEUE send is skipped here, on what
 * the plan calls the narrowest surface in the system, because it fans out to
 * an operator's inbox rather than to a dashboard.
 *
 * A DIRECT CALLER THAT DOES SEND A SESSION ID STILL FIRES THIS SEAM, and that
 * is correct and must stay: `src/pages/chat.astro` (a real visitor, through
 * the site) is exactly that caller, and losing its signal would recreate the
 * exact gap Important 1 above just closed.
 */
export async function chatHighIntentEvent(
  env: McpEnv,
  sessionId: string,
  callerSuppliedSession: boolean,
): Promise<IntentEvent | null> {
  if (!callerSuppliedSession) return null;
  const first = await firstOfSession(env, sessionId);
  return highIntentFor({ kind: 'chat', at: new Date().toISOString(), firstOfSession: first });
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
  // Split from `sessionId` below rather than folded into one ternary: this
  // Worker still needs a session id EITHER WAY (a transcript row always gets
  // one), but `chatHighIntentEvent`'s negative filter (task-13a-findings-
  // final.md, Important 2) needs to tell "the caller sent one" apart from
  // "we minted one because they did not or sent something malformed" --
  // information the merged value alone no longer carries.
  const bodySessionId =
    typeof body.sessionId === 'string' && SESSION_ID.test(body.sessionId) ? body.sessionId : null;
  const sessionId = bodySessionId ?? crypto.randomUUID();
  // The site's own caller identifies itself the way src/lib/fit/client.ts does.
  // Told apart because they are different audiences with different costs, not
  // because one is trusted more -- nothing here branches on it except the
  // transcript column.
  const surface = request.headers.get('user-agent')?.startsWith('ryanlindsey-me-chat')
    ? ('site' as const)
    : ('direct' as const);

  const refuse = (code: ChatErrorCode, outcome: 'refused' | 'error' = 'refused') => {
    // Hoisted (task-13a-findings-final.md item 9): computed once so the
    // transcript row and the AE row below report the SAME number for the
    // same refusal, rather than two calls a tick apart that could disagree
    // with each other despite both claiming to describe this request.
    const durationMs = Date.now() - started;
    ctx.waitUntil(
      writeTranscript(env, {
        sessionId,
        question,
        answer: '',
        sources: [],
        cited: 0,
        invalid: 0,
        outcome,
        durationMs,
        surface,
      }),
    );
    // NOT hoisted above the `waitUntil` (item 15): nothing in that block
    // reads `response`, so building it here, right before the one call that
    // needs it, is the same behaviour with no "why is this up here" for a
    // reader to puzzle over.
    const response = errorResponse(code);
    // TASK 13a (2026-09-10) CLOSES THIS HALF OF THE ANALYTICS-DATAPOINT SEAM
    // (its other half is at the end of the stream below): a refusal is still
    // a request this route answered, and 06 §3 wants it counted the same as
    // a served one, UNCONDITIONALLY -- see `chatAgentEvent`'s own comment for
    // why that call, not an object literal here, is what keeps this from
    // silently becoming the `surface` local two lines up. ASSERTED END TO END
    // (fix round 1, task-13a-findings-r1.md, tests/chat-endpoint.test.ts's
    // `describe('the refuse AE datapoint', ...)`) rather than only through
    // the shape `chatAgentEvent` builds -- every test in this file that
    // becomes a chat turn reaches this line (task-13a-findings-final.md,
    // Important 3 -- `GET`, a non-JSON body, and a test that makes no HTTP
    // request at all do not, and are not meant to: Ruling 3 leaves them
    // unrecorded on purpose), which is what made an observable `AE` worth
    // building. `response.status` is always 200 here BY PROTOCOL --
    // `errorResponse`'s own comment above says why -- so `status_class`
    // (`blobs[5]`) is `2xx` for every row this route ever writes; chat health
    // comes from `chat_turns.outcome`, never from this column.
    recordAgentEvent(env, chatAgentEvent(request, response.status, durationMs));
    return response;
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

  // TASK 13a (2026-09-10) CLOSES THE HIGH-INTENT SEAM HERE: the first turn of
  // a session is high intent (06 §3), and this is the only place it is
  // observable, since the site holds no state across messages. `startAnswer`
  // above having just succeeded is what makes this reachable at all -- only a
  // turn that is actually going to be answered reaches this line.
  // `chatHighIntentEvent` (above `handleChat`) is the decision -- Ruling 4's
  // D1 read (corrected by task-13a-findings-final.md's Important 1) plus
  // Important 2's server-minted-session gate -- kept out of line because both
  // needed room to say why; the send itself mirrors `queueFitRunIntent` in
  // src/worker.ts.
  //
  // AWAITED HERE, SERIALLY, RATHER THAN WRAPPED IN `ctx.waitUntil()`
  // (task-13a-findings-final.md item 14, the controller's own call, KEPT on
  // review): `firstOfSession`'s read must happen-before the CURRENT turn's
  // own `writeTranscript` write, or it could race it -- and a `waitUntil` is
  // exactly a promise the platform is free to run concurrently with whatever
  // else is scheduled, which would turn "this session's first row is not
  // written yet" from a guarantee back into a probability. Serial placement,
  // before the stream (and therefore before the eventual `writeTranscript`
  // call at its end) even exists, is what keeps it a guarantee.
  //
  // NOT REACHABLE FROM tests/chat-endpoint.test.ts: `env.CHAT_ENGINE` is
  // `'off'` there (tests/workers.ts), so `startAnswer` always throws before
  // this line runs and the suite always refuses upstream of here. That is
  // exactly why `chatHighIntentEvent` and `firstOfSession` are exported and
  // asserted directly instead of through this call site -- see their own
  // comments.
  const highIntent = await chatHighIntentEvent(env, sessionId, bodySessionId !== null);
  if (highIntent !== null) ctx.waitUntil(env.EVENTS.send(highIntent));

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
      // TASK 13a (2026-09-10) CLOSES THIS SEAM (its other half is in `refuse`
      // above): one AE row per turn that reaches here, UNCONDITIONALLY --
      // `chatAgentEvent`'s own comment (above `handleChat`) says why its
      // `surface` is always `'chat'` and can never be this scope's `surface`.
      //
      // `durationMs` IS THE FULL STREAM DURATION (`Date.now() - started`),
      // the same number the transcript row just above got, and that is a
      // known cost rather than an oversight: it becomes `double2`, which Task
      // 10's `quantileWeighted(0.5)(double2, _sample_interval)` uses for the
      // sitewide p50 -- so a slow chat answer drags that number up. Truthful
      // and consistent with the transcript beside it beats a
      // time-to-first-byte number that would disagree with it.
      //
      // `status` is the literal 200 rather than something read off a
      // `Response`: by the time this runs, the stream's `Response` (returned
      // from `handleChat` before this callback ever ran) was already sent
      // with the implicit 200 `STREAM_HEADERS` always carries -- see
      // `errorResponse` above, whose "200 WITH AN ERROR FRAME" note is the
      // same protocol decision seen from the other side.
      //
      // THIS CALL SITE ITSELF IS NOT ASSERTED BY A TEST, and for a different
      // reason than the AE no-op that used to be the whole story: fix round 1
      // (task-13a-findings-r1.md) gave `refuse`'s twin above an observable
      // `AE` (a service-binding override to workers/mock-ae, the same
      // mechanism `bindingOverrides: { AI: 'mock-ai' }` already uses for a
      // binding Miniflare's local Analytics Engine simulator cannot emulate
      // usefully -- it is a `writeDataPoint` that does nothing at all, not
      // even log). What still makes THIS call site untestable is not that
      // gap; it is that this whole callback is downstream of `startAnswer`
      // succeeding, which no test here can make happen (see the Seam A
      // comment earlier in `handleChat`, above where `chatHighIntentEvent`
      // is called). What IS covered: the event
      // `chatAgentEvent` builds (tests/chat-endpoint.test.ts),
      // `recordAgentEvent`'s own contract (tests/agent-record.test.ts), and
      // that this route still answers correctly with the call in place
      // (tests/chat-endpoint.test.ts).
      recordAgentEvent(env, chatAgentEvent(request, 200, Date.now() - started));
    },
  });

  return new Response(stream, { headers: STREAM_HEADERS });
}
