import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { MAX_QUESTION_CHARS } from '../../lib/chat/engine';
import type { ChatErrorCode } from '../../lib/chat/errors';
import { sseFrame } from '../../lib/chat/protocol';

/**
 * The chat form's target (04 §1).
 *
 * THIS ROUTE SPENDS NOTHING, KNOWS NOTHING, AND -- READ THIS BEFORE "FIXING" IT
 * -- DELIBERATELY DOES NOT VERIFY THE BOT CHECK. It forwards the Turnstile
 * response token to the MCP Worker, which verifies it there (see
 * workers/mcp/src/chat.ts). A Turnstile response is SINGLE-USE: verifying here
 * as well would consume it, and the far side's check would then fail as
 * `timeout-or-duplicate` on every legitimate message. The two halves are one
 * decision, and adding a `verifyTurnstile` call to this file breaks chat
 * completely while looking like defence in depth.
 *
 * Why the far side owns it: that Worker is reachable directly, so the check has
 * to live where the spend is or it is not a control at all. `/fit` is the other
 * way round and stays that way -- it serves its own form and verifies it.
 *
 * The engine, the limiter, the cap, the breaker, the transcript and the
 * citation arithmetic are all on the other side of the `MCP` service binding,
 * exactly as `/fit` does with `analyze_fit`. One implementation, two frontends.
 *
 * The two local checks that remain are shape checks, kept because they cost
 * nothing and stop an obviously malformed request from consuming a service
 * binding dispatch.
 */
export const prerender = false;

const CHAT_URL = 'https://mcp.ryanlindsey.me/chat';

function errorStream(code: ChatErrorCode): Response {
  return new Response(sseFrame('error', { code }), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export const GET: APIRoute = () => new Response(null, { status: 405 });

export const POST: APIRoute = async ({ request }) => {
  let body: { question?: unknown; sessionId?: unknown; turnstileResponse?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (question === '') return errorStream('empty');
  if (question.length > MAX_QUESTION_CHARS) return errorStream('too-long');

  const clientIp = request.headers.get('cf-connecting-ip');
  const upstream = await env.MCP.fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // So the transcript and /ops can tell a browser turn from an agent's,
      // the same way src/lib/fit/client.ts labels its own calls.
      'user-agent': 'ryanlindsey-me-chat/1',
      // Forwarded explicitly because a service-binding dispatch does not go
      // through the edge, so the far side's limiter would otherwise key every
      // browser visitor into one `chat:unknown` bucket.
      ...(clientIp ? { 'cf-connecting-ip': clientIp } : {}),
    },
    // The bot-check token travels with the question, unverified and unread.
    body: JSON.stringify({
      question,
      sessionId: body.sessionId,
      turnstileResponse: body.turnstileResponse,
    }),
  });

  // The body is passed through UNREAD. Buffering it here to inspect it would
  // undo the streaming this whole feature exists to have, and there is nothing
  // to inspect: every frame the far side emits is already from a closed set
  // this repo owns on both ends.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
};
