import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { grantContext, startAnalyzeFit } from '../../lib/fit/client';
import type { FitErrorCode } from '../../lib/fit/errors';
import { verifyTurnstile } from '../../lib/turnstile';

/**
 * The `/fit` form's target (04 §2).
 *
 * A 303 back to `/fit` on every failure and to `/fit/r/<id>` on success --
 * plain form POST, no client JavaScript beyond the Turnstile widget itself,
 * and a result that survives a refresh because it lives at its own URL.
 *
 * ORDER: grant, then Turnstile, then the run. The grant check is first
 * because a caller without one should not be able to make this route spend a
 * siteverify round trip, and Turnstile is before the run because the run is
 * the expensive half.
 *
 * IT NO LONGER WAITS FOR THE REPORT (#269). This route used to call
 * `analyze_fit` and hold the browser open for the whole run, measured at
 * 78,222 ms on 2026-09-18, then write the row itself. It now asks the MCP
 * Worker to OPEN a run and redirects immediately; that Worker mints the id,
 * writes `fit_reports` and finishes the run after answering. So nothing below
 * touches D1, and the success redirect points at a row that is still pending.
 */
export const prerender = false;

/**
 * Back to the form, carrying the token and one REASON CODE.
 *
 * A code, not a sentence (final-review Important 7). What lands in the URL
 * lands in the page, and this URL is one an audience is handed and encouraged
 * to forward: with a sentence here, anyone holding a `/fit?t=...` link could
 * append `&error=Your+token+expired,+write+to+...` and have the real origin
 * render it above the form. The page maps the code to fixed copy it owns, so
 * the worst a forged value can do is show nothing.
 *
 * `reason` is logged by the callers that have a specific sentence to log --
 * the tool's own refusal text is the breaker's or the limiter's wording, and
 * losing it entirely would trade a phish for an unobservable failure.
 */
function back(token: string, code: FitErrorCode): Response {
  const query = new URLSearchParams({ t: token, error: code });
  return new Response(null, { status: 303, headers: { Location: `/fit?${query}` } });
}

/**
 * The same bare 404 the page answers with, and like that one it is replaced by
 * the site's own 404 page in src/worker.ts before it reaches the client. A
 * refusal that differs observably from what an unrouted path returns -- in
 * body, in `Content-Type`, or in a header nothing else on this site sets -- is
 * a route-existence oracle, which is the one thing an unlisted surface must not
 * be.
 *
 * A FUNCTION rather than a module-scope constant, and the difference is not
 * style: a `Response` carries a single-use body stream, so one shared instance
 * returned twice in the same isolate hands the second caller a body that has
 * already been read. Both of this route's 404s are on the un-granted path,
 * which is exactly the path a prober hits repeatedly.
 */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

export const POST: APIRoute = async ({ request }) => {
  /**
   * THE FIRST GATE, and it is one because of where it sits rather than what it
   * checks. `request.formData()` THROWS on a body it cannot parse -- a JSON
   * content type, a malformed `multipart/form-data`, no body at all with a
   * content type promising one -- and it runs before either grant check.
   * Uncaught, that throw is a 500 with an empty body, which MEASURED as the
   * third shape of the same route-existence oracle this page exists to close:
   * 500 and empty from `/fit/run`, 5,182 bytes of 404 page from every dead
   * path, reachable with no token at all.
   *
   * A caller whose body this route cannot read is not a caller who has proved
   * anything, so they get exactly what a stranger gets. src/worker.ts flattens
   * a 500 on this prefix as well -- two ends, because the property has two
   * owners and both have moved once already.
   */
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return notFound();
  }

  const token = String(form.get('t') ?? '');
  const description = String(form.get('target_description') ?? '');

  // Same check and same 404 as the page: an unlisted surface must not confirm
  // itself to a caller without a grant, and that has to hold for the POST as
  // well as the GET or the page's guarantee is one route wide.
  if (token === '') return notFound();
  const context = await grantContext(env, token);
  if (context === null || !context.tools.has('analyze_fit')) return notFound();

  const turnstile = await verifyTurnstile(
    env,
    String(form.get('turnstile_response') ?? '') || null,
    request.headers.get('cf-connecting-ip'),
  );
  if (!turnstile.ok) {
    console.warn(`fit: turnstile refused (${turnstile.codes.join(', ')})`);
    return back(token, 'bot-check');
  }

  const outcome = await startAnalyzeFit(env, token, description);
  if (!outcome.ok) {
    // One code, and the log is where the detail was always going to live. The
    // MCP Worker refuses a run the same way it refuses an unrouted path, so
    // there is no sentence to carry here even if it were safe to carry one.
    console.warn(`fit: the run could not be started (${outcome.code})`);
    return back(token, outcome.code);
  }

  /**
   * THE REPORT DOES NOT EXIST YET, and this redirect is correct anyway. The
   * row is open, `/fit/r/<id>` renders its pending state and refreshes itself
   * until the MCP Worker closes it.
   *
   * WHAT LEFT THIS FILE IN #269: the envelope's audience check and the INSERT.
   * Both were here because the site stored the report. It does not any more --
   * the Worker that resolves the grant is the one that writes the row, so the
   * audience never has to cross a boundary to be checked on the other side.
   * Nothing on the site WRITES `fit_reports` any more; `/fit/r/<id>`,
   * src/lib/ops/metrics.ts and src/lib/retention.ts still read it.
   *
   * THE ORDER NOTE ABOVE STILL HOLDS, with the last step renamed. Turnstile is
   * before the start call because the start call is still the metered half:
   * `/fit/start` goes through `limitAndAudit` and spends the caller's
   * allowance, whether or not this route waits for the engine.
   */
  return new Response(null, { status: 303, headers: { Location: `/fit/r/${outcome.id}` } });
};
