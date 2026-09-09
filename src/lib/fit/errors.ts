import type { AnalyzeFailure } from './client';

/**
 * The reason codes `/fit/run` may put in its redirect, and the copy `/fit`
 * renders for each.
 *
 * ONE MODULE, TWO READERS, and that is the whole point (final-review
 * Important 7). `/fit/run` may only emit a member of `FitErrorCode`, and
 * `/fit` may only render a value it finds in `FIT_ERROR_COPY` -- so the set of
 * sentences the page can ever display is fixed at build time and is written
 * here, rather than arriving in a query parameter.
 *
 * WHY THAT MATTERS: `/fit?t=<token>` is a link the audience is given and
 * expected to forward. When the redirect carried the sentence itself, anyone
 * holding that link could craft `&error=<anything>` and have ryanlindsey.me
 * render arbitrary copy above the form -- a phish on the one page the reader
 * was told to trust, delivered from the real origin over HTTPS. Astro escapes
 * the value, so this was never script injection; it was something narrower and
 * more persuasive, which is text injection on a trusted surface.
 *
 * The cost, stated plainly: the tool's own refusal wording -- the breaker's
 * sentence, the limiter's -- no longer reaches the page. `/fit/run` logs it
 * instead (`console.warn`), and an MCP caller still receives it verbatim in
 * the tool result, which is the surface it was written for. A browser visitor
 * gets the `refused` copy below and is told to retry, which is the action
 * available to them either way.
 */
export type FitErrorCode = AnalyzeFailure | 'bot-check' | 'not-saved';

export const FIT_ERROR_COPY: Record<FitErrorCode, string> = {
  'bot-check': 'That bot check did not pass. Reload the page and try again.',
  unreachable: 'The fit engine could not be reached. Try again shortly.',
  // Deliberately vaguer than the sentence the tool returned. The specific
  // one -- rate limited, breaker tripped, description too short -- is in the
  // Worker log; see the `console.warn` in src/pages/fit/run.ts.
  refused: 'The fit engine could not complete that run. Try again shortly.',
  // The engine answered and the answer did not parse. The visitor's options
  // are the same as for `refused`, so the copy is too; the codes stay
  // distinct because the operator's are not.
  unusable: 'The fit engine could not complete that run. Try again shortly.',
  'not-saved': 'The report was generated but could not be saved. Try again shortly.',
};

/**
 * The copy for a code, or `null` for anything else.
 *
 * `null` rather than a fallback sentence, and this is the security-relevant
 * half: a forged or stale `?error=` value renders NOTHING. A generic fallback
 * would hand a forger a way to make the page display an error banner of their
 * choosing in shape if not in wording, and an empty form is a truthful answer
 * to a request that carried no reason this build recognises.
 */
export function fitErrorCopy(raw: string | null): string | null {
  if (raw === null) return null;
  return Object.hasOwn(FIT_ERROR_COPY, raw) ? FIT_ERROR_COPY[raw as FitErrorCode] : null;
}
