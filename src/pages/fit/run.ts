import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { callAnalyzeFit, grantedToolNames, newReportId } from '../../lib/fit/client';
import type { FitErrorCode } from '../../lib/fit/errors';
import { verifyTurnstile } from '../../lib/turnstile';

/**
 * The `/fit` form's target (04 §2).
 *
 * A 303 back to `/fit` on every failure and to `/fit/r/<id>` on success --
 * plain form POST, no client JavaScript beyond the Turnstile widget itself,
 * and a result that survives a refresh because it lives at its own URL.
 *
 * ORDER: grant, then Turnstile, then the tool. The grant check is first
 * because a caller without one should not be able to make this route spend a
 * siteverify round trip, and Turnstile is before the tool because the tool is
 * the expensive half.
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
  const tools = await grantedToolNames(env, token);
  if (!tools.has('analyze_fit')) return notFound();

  const turnstile = await verifyTurnstile(
    env,
    String(form.get('turnstile_response') ?? '') || null,
    request.headers.get('cf-connecting-ip'),
  );
  if (!turnstile.ok) {
    console.warn(`fit: turnstile refused (${turnstile.codes.join(', ')})`);
    return back(token, 'bot-check');
  }

  const outcome = await callAnalyzeFit(env, token, description);
  if (!outcome.ok) {
    // The tool's own sentence goes to the LOG, not to the URL. It is the
    // breaker's message, or the limiter's, or the engine's, and each was
    // written to be read -- but the reader it can safely reach is the
    // operator, because the redirect that would carry it to the page is
    // forgeable by anyone holding the link.
    console.warn(`fit: the tool refused the run (${outcome.code}): ${outcome.message}`);
    return back(token, outcome.code);
  }

  /**
   * The GRANT'S audience, out of the tool's own envelope.
   *
   * `fit_reports.audience` is defined by migrations/0002_private_tier.sql as
   * the audience of the grant that produced the report, with a comment saying
   * a NULL there would be evidence the tier check was bypassed. This route
   * cannot derive it: the token is opaque here by design and this file never
   * verifies it. So the MCP Worker says it (`fitEnvelope` in
   * workers/mcp/src/gated.ts, from `grant.audience`) and this reads it back.
   *
   * An envelope with no audience is a contract violation rather than a missing
   * nicety, and it is refused rather than papered over with a placeholder: a
   * row that names a channel, or an empty string, is a row that lies to
   * whoever reads the table next -- which is exactly what that column's
   * comment says must not happen.
   */
  const audience = typeof outcome.payload.audience === 'string' ? outcome.payload.audience : '';
  if (audience === '') {
    console.error('fit: the tool envelope carried no audience; refusing to store a report');
    return back(token, 'not-saved');
  }

  const id = newReportId();
  try {
    await env.DB.prepare(
      `INSERT INTO fit_reports
         (id, created_at, audience, model, target_description, report_json,
          citations_checked, citations_dropped)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        new Date().toISOString(),
        audience,
        String(outcome.payload.model ?? ''),
        description,
        JSON.stringify(outcome.payload.report ?? {}),
        Number(outcome.payload.citations_checked ?? 0),
        Number(outcome.payload.citations_dropped ?? 0),
      )
      .run();
  } catch (error) {
    // The report exists but could not be stored. Say so rather than losing it
    // silently behind a permalink that will 404.
    console.error('fit: could not store the report', error);
    return back(token, 'not-saved');
  }

  return new Response(null, { status: 303, headers: { Location: `/fit/r/${id}` } });
};
