/**
 * The closed set of reasons a chat turn did not produce an answer, and the copy
 * the page renders for each.
 *
 * THE SAME SHAPE AS src/lib/fit/errors.ts, AND FOR THE SAME REASON, restated
 * because the threat is different here and lands in the same place. `/fit`'s
 * codes exist because its URL is forwarded and `?error=` was attacker-supplied.
 * Chat's `error` frame arrives over a stream the site opened, so nothing
 * external can inject one -- but the page still renders only copy it owns,
 * because the frame's payload originates in the MCP Worker and crosses a
 * service binding, and a page that renders whatever sentence arrives on a
 * socket is one refactor away from rendering someone else's.
 */
export type ChatErrorCode =
  'bot-check' | 'too-long' | 'empty' | 'rate-limited' | 'paused' | 'unreachable' | 'no-answer';

export const CHAT_ERROR_COPY: Record<ChatErrorCode, string> = {
  'bot-check': 'That bot check did not pass. Reload the page and try again.',
  'too-long': 'That question is longer than this box takes. Try the shorter version.',
  empty: 'Ask something first.',
  'rate-limited': 'That is a lot of questions at once. Give it a minute.',
  // The candid banner 04 §5 asks for, and it says what actually happened
  // rather than "something went wrong": the budget is a published number on
  // /ops and the breaker resetting is a fact the reader can check.
  paused:
    'The daily inference budget breaker is tripped, so chat is paused until it resets. The corpus is still readable at /llms.txt, and the MCP endpoint still answers.',
  unreachable: 'The chat service could not be reached. Try again shortly.',
  'no-answer':
    'That produced nothing usable. The corpus is at /llms.txt if you would rather read it directly.',
};

export function chatErrorCopy(raw: string | null): string | null {
  if (raw === null) return null;
  return Object.hasOwn(CHAT_ERROR_COPY, raw) ? CHAT_ERROR_COPY[raw as ChatErrorCode] : null;
}
