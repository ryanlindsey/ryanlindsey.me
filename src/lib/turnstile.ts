// Turnstile's server half (04 §1, §2). The widget is
// src/components/Turnstile.astro; this is the siteverify call that decides
// whether the token it produced is real.
//
// WHAT THIS IS AND IS NOT, stated because the boundary matters: Turnstile is a
// COST CONTROL on the `/fit` form, not the access boundary. The access
// boundary is the scoped token, checked in the MCP Worker
// (src/lib/tier/grant.ts) -- a token holder can call `analyze_fit` directly at
// mcp.ryanlindsey.me and never see this widget, and that is correct, because
// the token is the credential. What Turnstile buys is that a LEAKED link
// cannot be hammered through the browser form.

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileEnv {
  RLME_TURNSTILE_SECRET_KEY: SecretsStoreSecret;
  /**
   * Test-only seam, the same shape as every other one in this repo
   * (RESUME_PDF_RENDERER, MCP_SEARCH_EMBEDDER, RLME_TOKEN_KEY_SOURCE,
   * FIT_ENGINE): no deployed config declares it, an unrecognised value
   * throws, and `'stub'` skips both the Secrets Store read and the network
   * call. It exists because the harness has neither a populated local
   * secrets store nor outbound network access to challenges.cloudflare.com.
   */
  RLME_TURNSTILE_MODE?: string;
}

export type TurnstileVerdict = { ok: true } | { ok: false; codes: string[] };

/**
 * Verifies one Turnstile response token.
 *
 * FAILS CLOSED on every uncertainty -- a missing token, a Secrets Store read
 * failure, a network failure, a body that is not JSON, a `success` that is
 * not `true`. The alternative (treating an outage as a pass) would turn a
 * Cloudflare incident into an open door on the one form in this site that
 * spends Opus tokens.
 *
 * `fetchImpl` is injected so the tests exercise the real request-shaping code
 * rather than a mock of it: the assertion that `secret`, `response` and
 * `remoteip` all reach the wire is the assertion worth having, and it is only
 * available from inside.
 */
export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string | null,
  remoteIp: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileVerdict> {
  const mode = env.RLME_TURNSTILE_MODE;
  if (mode !== undefined && mode !== 'stub') {
    throw new Error(`unrecognised RLME_TURNSTILE_MODE: ${mode}`);
  }
  if (mode === 'stub') return { ok: true };

  if (token === null || token.length === 0) return { ok: false, codes: ['missing-input-response'] };

  const body = new URLSearchParams({ response: token });
  // Optional per Cloudflare's API, and omitted rather than sent empty when the
  // header is absent -- an empty `remoteip` is a different input from no
  // `remoteip`.
  if (remoteIp !== null) body.set('remoteip', remoteIp);

  let payload: unknown;
  try {
    // The secret read is INSIDE this try, not before it. `.get()` throws when
    // the secret is absent -- rotated to empty, deleted, or bound to a store a
    // deploy has not written yet, the same production cases src/lib/tier/grant.ts
    // measured for RLME_TOKEN_SIGNING_KEY -- and this is the identical binding
    // shape read a second time. Left outside the try, that throw would escape
    // `verifyTurnstile` uncaught and the Worker would answer 500 instead of
    // refusing, which is a fail-OPEN dressed as an error page.
    body.set('secret', await env.RLME_TURNSTILE_SECRET_KEY.get());
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    payload = await response.json();
  } catch (error) {
    console.error('turnstile: siteverify failed', error);
    return { ok: false, codes: ['verification-unavailable'] };
  }

  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, codes: ['verification-unavailable'] };
  }
  const result = payload as { success?: unknown; 'error-codes'?: unknown };
  if (result.success === true) return { ok: true };

  const codes = Array.isArray(result['error-codes'])
    ? result['error-codes'].filter((code): code is string => typeof code === 'string')
    : [];
  return { ok: false, codes: codes.length > 0 ? codes : ['verification-failed'] };
}
