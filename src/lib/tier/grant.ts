// Request -> Grant. The ONE place a token is verified in this system.
//
// The site Worker does not have a copy of this: `/fit` treats the token as an
// opaque string and asks the MCP Worker, over the service binding, whether
// the granted surface contains `analyze_fit`. That is a deliberate design
// choice recorded in the day-5 plan -- one implementation of a security
// boundary, and `/fit`'s gate exercises the real one rather than agreeing
// with it.

import { findToken } from './registry';
import { verifyToken, type Scope, type TokenFailure, type TokenVerdict } from './token';

/** What a resolved request may do. Built from the registry, never from the claim alone. */
export interface Grant {
  jti: string;
  audience: string;
  scopes: Scope[];
  /** Epoch seconds, from the signed claim. */
  expiresAt: number;
}

/**
 * Why a presented token was not honoured.
 *
 * `'unknown'` and `'revoked'` are this module's own, added to the format
 * failures: a token can be perfectly well-formed, correctly signed and
 * unexpired and still be refused, and those two cases are the ones an
 * operator running a revocation drill is looking for.
 *
 * `'unavailable'` is this module's own too, and it is the odd one out: every
 * other member says something about the TOKEN, and this one says the server
 * could not form an opinion at all because the signing key was unreadable or
 * empty (see `resolveGrant`, which is the only place it is produced). It is a
 * refusal rather than a silent public downgrade because a token WAS presented
 * -- see `GrantResolution` below -- and it is a distinct name rather than a
 * reuse of `'bad_signature'` because the audit trail and the operator log are
 * read as evidence: recording "this holder's signature was forged" about an
 * outage of our own would be a lie in exactly the place someone goes looking
 * for the truth.
 */
export type GrantRefusal = TokenFailure | 'unknown' | 'revoked' | 'unavailable';

/**
 * Both fields null means "no token was presented" -- an ordinary public
 * caller, not a failure. A refusal means one WAS presented and was not
 * honoured, which is worth saying out loud to the caller (see
 * `buildInstructions` in workers/mcp/src/server.ts) rather than silently
 * serving them the public tier and letting them wonder.
 */
export interface GrantResolution {
  grant: Grant | null;
  refusal: GrantRefusal | null;
}

export interface GrantEnv {
  DB: D1Database;
  RLME_TOKEN_SIGNING_KEY: SecretsStoreSecret;
  /** Test-only seam; see `signingKey` below. */
  RLME_TOKEN_KEY_SOURCE?: string;
}

/**
 * The key the harness signs with. NOT A SECRET, and deliberately shaped so it
 * cannot be mistaken for one: it is a committed constant in a public repo, and
 * a token signed with it is worthless against production, whose key lives in
 * Secrets Store and has never been in a file.
 */
export const TEST_SIGNING_KEY = 'rlme-harness-signing-key-not-a-secret';

/**
 * The seam's own misconfiguration, and NOTHING else.
 *
 * A class rather than a bare `Error` so `resolveGrant` can tell it apart from
 * every other way reading a key can fail. Those others are contained there and
 * become a refusal; this one is deliberately allowed to escape as a 500, which
 * is `signingKey`'s second safety property below and would be quietly undone
 * by a `catch` that could not distinguish the two.
 */
export class KeySourceError extends Error {}

/**
 * The signing key, and the one seam in this file.
 *
 * Same shape as `CORPUS_REFRESH` (src/lib/corpus.ts), `MCP_SEARCH_EMBEDDER`
 * (workers/mcp/src/env.ts) and `RESUME_PDF_RENDERER` before them, for the same
 * reason and with the same three safety properties:
 *
 *   1. The DEPLOYED behaviour comes from the var being ABSENT, not from a
 *      default branch -- neither wrangler.jsonc declares it, and
 *      tests/mcp-env.test.ts fails if one starts to.
 *   2. An unrecognised value THROWS rather than guessing. A typo is a 500,
 *      not a silently weakened signature.
 *   3. The only accepted value is `'test'`, and what it selects is a constant
 *      that says in its own name that it is not a secret.
 *
 * It exists because miniflare simulates `secrets_store_secrets` against a
 * LOCAL store (measured: `RLME_TOKEN_SIGNING_KEY.get()` under the harness),
 * and credential-free CI has never populated one. Without the seam, every
 * gated test would need account access, which 10 §2.4 forbids.
 */
export async function signingKey(env: GrantEnv): Promise<string> {
  const source = env.RLME_TOKEN_KEY_SOURCE;
  if (source === undefined) return env.RLME_TOKEN_SIGNING_KEY.get();
  if (source === 'test') return TEST_SIGNING_KEY;
  throw new KeySourceError(`unrecognised RLME_TOKEN_KEY_SOURCE: ${source}`);
}

/**
 * The bearer token on a request, or `null`.
 *
 * `Headers.get` is case-insensitive per the Fetch standard, and the scheme
 * comparison is lower-cased here because RFC 9110 §11.1 makes the auth scheme
 * itself case-insensitive -- `bearer` from a hand-rolled client is valid and
 * a case-sensitive check would refuse a legitimate caller.
 *
 * ONLY a header. Never a cookie, never a query parameter: `HANDLER_OPTIONS`
 * in workers/mcp/src/index.ts opens `Origin` to every host, and the property
 * that keeps that safe is that a token is presented EXPLICITLY on every call
 * by a client that already had it -- there is no ambient credential for a
 * hostile page to borrow. Accepting a cookie here would silently convert that
 * opening into a real cross-origin read of gated data.
 */
export function bearerFrom(request: Request | undefined): string | null {
  const header = request?.headers.get('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

/**
 * Verifies the presented token and resolves it against the registry.
 *
 * ORDER: signature and expiry BEFORE the registry read. A forged or stale
 * token therefore costs no D1 query, which is what keeps an unauthenticated
 * flood from turning into database load. Not "no I/O" -- on the deployed path
 * the same expression awaits `signingKey`, which is a Secrets Store binding
 * read; what the order buys is that the DATABASE is never touched for a token
 * that was never going to verify.
 *
 * The grant's scopes come from the REGISTRY ROW, not from the signed claim.
 * The claim cannot be edited by the holder, but it can be stale: narrowing a
 * live token's scopes is a registry update, and the narrower, current record
 * is the one that should govern. The claim's `aud` and `exp` still come from
 * the token, because those are what was signed and what the holder was told.
 *
 * Resolved PER REQUEST, with no cache keyed on the token string. Two reasons,
 * and both are load-bearing. Revocation is instant only because there is no
 * entry to wait out (tests/tier-grant.test.ts asserts exactly that). And
 * base64url is not canonical: four distinct token STRINGS carry the same
 * signed claims and verify identically, which is harmless while every key in
 * this system is the `jti` INSIDE those claims -- the registry's key, the
 * audit row's `grant_jti`, and the limiter's bucket (src/lib/mcp/limits.ts's
 * `limitKeyFor`) all are -- and stops being harmless the moment anything
 * caches or dedupes by the string.
 */
export async function resolveGrant(
  env: GrantEnv,
  request: Request | undefined,
  nowSeconds: number,
): Promise<GrantResolution> {
  const presented = bearerFrom(request);
  if (presented === null) return { grant: null, refusal: null };

  let verdict: TokenVerdict;
  try {
    verdict = await verifyToken(await signingKey(env), presented, nowSeconds);
  } catch (error) {
    // NOT in the plan, and here because of two MEASUREMENTS rather than two
    // worries. Task 2's probe: `env.RLME_TOKEN_SIGNING_KEY.get()` THROWS
    // `Secret "RLME_TOKEN_SIGNING_KEY" not found` when the store has no such
    // secret. Task 2's review: `verifyToken` REJECTS on a zero-length key with
    // `DOMException: Zero-length key is not supported`, raised inside
    // `hmacKey` before any verdict exists -- so an empty secret does not
    // verify to `false`, it explodes.
    //
    // Both are reachable in production, where this key is a Secrets Store
    // secret that can be deleted, rotated to empty, or bound to a store a
    // deploy has not written yet. Unwrapped, either escapes this function and
    // the Worker answers 500 -- which is not fail-closed in the sense that
    // matters, because it reads as "the server is broken" rather than "the
    // private tier is shut", and 500s are what an operator learns to ignore.
    // Contained, it is a refusal: no grant, one log line, and the caller told
    // the same thing every other refused token is told.
    //
    // `KeySourceError` is rethrown deliberately. `signingKey`'s second safety
    // property is that an unrecognised RLME_TOKEN_KEY_SOURCE is a 500 rather
    // than a guess, and a catch that swallowed it would turn a typo in a
    // config into a private tier that is silently and permanently shut -- the
    // failure the property exists to make loud.
    if (error instanceof KeySourceError) throw error;
    console.error('mcp/grant: the signing key could not be used', error);
    return { grant: null, refusal: 'unavailable' };
  }
  if (!verdict.ok) return { grant: null, refusal: verdict.reason };

  const record = await findToken(env.DB, verdict.claims.jti);
  if (record === null) return { grant: null, refusal: 'unknown' };
  if (record.revokedAt !== null) return { grant: null, refusal: 'revoked' };

  return {
    grant: {
      jti: verdict.claims.jti,
      audience: verdict.claims.aud,
      scopes: record.scopes,
      expiresAt: verdict.claims.exp,
    },
    refusal: null,
  };
}

/**
 * Whether a grant carries a scope. A type guard, so a caller that checks
 * cannot then use `grant` as though it might be null.
 */
export function hasScope(grant: Grant | null, scope: Scope): grant is Grant {
  return grant !== null && grant.scopes.includes(scope);
}
