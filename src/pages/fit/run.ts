import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { callAnalyzeFit, grantedToolNames, newReportId } from '../../lib/fit/client';
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

/** Back to the form, carrying the token and one sentence. */
function back(token: string, message: string): Response {
  const query = new URLSearchParams({ t: token, error: message });
  return new Response(null, { status: 303, headers: { Location: `/fit?${query}` } });
}

/**
 * The same 404 the page answers with.
 *
 * A FUNCTION rather than a module-scope constant, and the difference is not
 * style: a `Response` carries a single-use body stream, so one shared instance
 * returned twice in the same isolate hands the second caller a body that has
 * already been read. Both of this route's 404s are on the un-granted path,
 * which is exactly the path a prober hits repeatedly.
 */
function notFound(): Response {
  return new Response('Not found', { status: 404 });
}

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
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
    return back(token, 'That bot check did not pass. Reload the page and try again.');
  }

  const outcome = await callAnalyzeFit(env, token, description);
  // The tool's own sentence, verbatim -- it is the breaker's message, or the
  // limiter's, or the engine's, and each was written to be read.
  if (!outcome.ok) return back(token, outcome.message);

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
        // The audience is not the site's to know: the token is opaque here by
        // design. The MCP Worker's audit row carries it (`mcp_tool_calls`),
        // and this column records how the report was produced rather than who
        // asked. Day 6's /ops joins the two on time and tool if it ever needs
        // to.
        'web',
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
    return back(token, 'The report was generated but could not be saved. Try again shortly.');
  }

  return new Response(null, { status: 303, headers: { Location: `/fit/r/${id}` } });
};
