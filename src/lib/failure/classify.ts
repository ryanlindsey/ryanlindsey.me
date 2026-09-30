/**
 * The only place an error becomes a reason. Every audit row, chat transcript
 * and fit report that records why a call failed gets its reason from here, so
 * the closed set below and the order of the rules are decided once.
 *
 * THE ORDER IS TAG, THEN UPSTREAM, THEN CODE, and each step exists because the
 * one after it is coarser.
 *
 *   1. An own `failureReason` is the thrower saying what happened. Nothing
 *      outranks the code that knew.
 *   2. Upstream patterns read the gateway's or provider's own words, found on
 *      the error or anywhere down its `cause` chain. They come before the chat
 *      code because `ChatUnavailable` wraps every provider failure into
 *      `unreachable`: read alone, a `7003` the provider rejected as malformed
 *      and a `3040` that was simply out of capacity would both say "could not
 *      be reached", and the record would lose the only distinction worth having.
 *   3. `ChatUnavailable`'s `code` is what is left when nothing upstream was
 *      said, for example when the engine is off.
 *
 * Inside step 2 the rules run `gateway_limit`, `gateway_billing`,
 * `provider_rejected`, `provider_unavailable`, and the first match wins. A 429
 * body that also mentions `7003` is a limit, because the gateway's limit
 * answer is the one that reads as something else: `2018: Invalid User
 * Credentials` is an auth error's wording on a rate-limit fault (see
 * src/lib/fit/engine.ts:45, which recorded it from the gateway capping at 50
 * requests a minute), so it is classified here as the limit it is rather than
 * as a credential problem.
 *
 * `detail` is bounded and is never rendered on a page or in a tool result. It
 * exists so an operator reading the row can tell one `internal` from another.
 *
 * `classifyFailure` runs inside the last catch of `limitAndAudit`, where a
 * throw would escape the only handler left, so it never throws: the whole body
 * is guarded and any failure, such as a `message` getter that throws, degrades
 * to `internal` with the detail `unclassifiable`.
 */
import type { ChatErrorCode } from '../chat/errors';

export const FAILURE_REASONS = [
  'local_limit',
  'gateway_limit',
  'gateway_billing',
  'provider_rejected',
  'provider_unavailable',
  'bad_output',
  'no_sources',
  'caller_input',
  'not_permitted',
  'not_found',
  'internal',
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface Failure {
  reason: FailureReason;
  detail: string;
}

export const FAILURE_DETAIL_MAX = 200;

/** How many links of a `cause` chain are read, the error itself included. */
const MAX_LINKS = 5;

const CHAT_CODE_REASONS: Record<ChatErrorCode, FailureReason> = {
  'rate-limited': 'local_limit',
  paused: 'local_limit',
  'bot-check': 'caller_input',
  empty: 'caller_input',
  'too-long': 'caller_input',
  unreachable: 'provider_unavailable',
  'no-answer': 'bad_output',
};

export function classifyChatCode(code: ChatErrorCode): FailureReason {
  return CHAT_CODE_REASONS[code];
}

/**
 * A refusal is the service declining, not failing: the visitor hit a limit,
 * sent something unusable, or asked about something with no sources. Everything
 * else is an error.
 */
export function isRefusal(reason: FailureReason): boolean {
  return reason === 'local_limit' || reason === 'caller_input' || reason === 'no_sources';
}

function isFailureReason(value: unknown): value is FailureReason {
  return typeof value === 'string' && (FAILURE_REASONS as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * The error, then its causes. An object is followed inward; a primitive is a
 * last link, because a thrown string and a string `cause` both carry the
 * gateway's wording and are tested like any message, but has nothing to follow.
 * Bounded by length and by repeats, so a cycle or a very deep chain ends.
 */
function walk(error: unknown): unknown[] {
  const links: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (links.length < MAX_LINKS && current !== undefined && current !== null) {
    if (seen.has(current)) break;
    seen.add(current);
    links.push(current);
    if (!isObject(current)) break;
    current = current.cause;
  }
  return links;
}

function upstreamReason(text: string, status: number | null): FailureReason | null {
  if (/\b2018\b/.test(text) || /wholesale rate limit/i.test(text) || status === 429) {
    return 'gateway_limit';
  }
  if (/insufficient balance/i.test(text) || /\b2021\b/.test(text)) return 'gateway_billing';
  if (/\b7003\b/.test(text) || (status !== null && status >= 400 && status <= 499)) {
    return 'provider_rejected';
  }
  if (
    /\b3040\b/.test(text) ||
    (status !== null && status >= 500) ||
    /fetch failed|network|timed? ?out/i.test(text)
  ) {
    return 'provider_unavailable';
  }
  return null;
}

function bound(text: string): string {
  return text.length > FAILURE_DETAIL_MAX ? text.slice(0, FAILURE_DETAIL_MAX) : text;
}

function messageOf(link: unknown): string {
  return String(isObject(link) ? (link.message ?? link) : link);
}

function describe(link: unknown): string {
  if (!isObject(link)) return String(link);
  return `${String(link.name)}: ${String(link.message)}`;
}

export function classifyFailure(error: unknown): Failure {
  try {
    const links = walk(error);

    for (const link of links) {
      if (
        isObject(link) &&
        Object.hasOwn(link, 'failureReason') &&
        isFailureReason(link.failureReason)
      ) {
        return { reason: link.failureReason, detail: bound(describe(link)) };
      }
    }

    for (const link of links) {
      const text = messageOf(link);
      const status = isObject(link) && typeof link.status === 'number' ? link.status : null;
      const reason = upstreamReason(text, status);
      if (reason !== null) {
        const hasMessage = !isObject(link) || typeof link.message === 'string';
        return { reason, detail: bound(hasMessage ? text : `status ${status}`) };
      }
    }

    for (const link of links) {
      if (
        isObject(link) &&
        link.name === 'ChatUnavailable' &&
        typeof link.code === 'string' &&
        Object.hasOwn(CHAT_CODE_REASONS, link.code)
      ) {
        return {
          reason: classifyChatCode(link.code as ChatErrorCode),
          detail: bound(describe(link)),
        };
      }
    }

    return {
      reason: 'internal',
      detail: bound(links.length > 0 ? describe(links[0]) : String(error)),
    };
  } catch {
    return { reason: 'internal', detail: 'unclassifiable' };
  }
}
