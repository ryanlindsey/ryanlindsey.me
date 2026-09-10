// The capability token (03 §3): HMAC-signed, self-describing, scoped,
// expiring. Pure -- no bindings, no D1, no clock of its own -- so the whole
// format is testable with `vitest run` and nothing else.
//
// The revocation half lives in ./registry.ts and the request half in
// ./grant.ts, deliberately: a token that verifies is not a token that is
// still allowed, and keeping "is this signature real" apart from "is this
// credential still live" means neither question can be answered by accident
// while checking the other.
//
// Vocabulary discipline (09 §2): this file talks about grants, audiences and
// scopes. It does not know what an audience means, and that is the design --
// audience-specific meaning arrives as runtime data, never as code.

/** What a grant may reach. A closed set: an unknown scope is a malformed token. */
export type Scope = 'fit' | 'profile' | 'documents' | 'narrative';

/**
 * Every scope, in the order `scripts/token.mjs` prints them.
 *
 * They are per-capability rather than one blanket `private` scope because
 * least privilege is cheap here and the audit trail is more legible for it:
 * a token minted for a fit demonstration should not also be able to read
 * reference contacts, and the registry row shows which was which.
 */
export const SCOPES = [
  'fit',
  'profile',
  'documents',
  'narrative',
] as const satisfies readonly Scope[];

/**
 * Type guard for `Scope`, so a caller holding an `unknown`/`string` value can
 * narrow it against `SCOPES` without repeating the `SCOPES as readonly
 * unknown[]` cast that `Array.prototype.includes` otherwise forces (`SCOPES`
 * is typed as `readonly Scope[]`, and `includes` requires its argument to
 * already be a `Scope`).
 */
export function isScope(value: unknown): value is Scope {
  return (SCOPES as readonly unknown[]).includes(value);
}

/** The claims a token carries, and the whole of what it asserts. */
export interface TokenClaims {
  v: 1;
  /** The token's own id -- the registry's primary key and the audit trail's. */
  jti: string;
  /** The audience label (00 §5's `token_audience`). An opaque string here. */
  aud: string;
  scopes: Scope[];
  /** Epoch SECONDS, not milliseconds. Both ends of every comparison agree. */
  iat: number;
  exp: number;
}

export type TokenFailure = 'malformed' | 'unsupported_version' | 'bad_signature' | 'expired';

export type TokenVerdict = { ok: true; claims: TokenClaims } | { ok: false; reason: TokenFailure };

/**
 * The scheme segment, and a version marker that is deliberately IN THE TOKEN
 * rather than only in the claims: a future format change gets a new scheme
 * string, so an old verifier rejects a new token at the first `split` instead
 * of parsing an unfamiliar payload and guessing.
 */
export const TOKEN_SCHEME = 'rlme1';

const encoder = new TextEncoder();

/**
 * base64url WITHOUT padding, per RFC 4648 §5.
 *
 * Unpadded on purpose: a token is carried in an `Authorization` header, a
 * query string and a shell argument, and `=` is the one base64 character that
 * needs escaping in the second of those. The decoder re-pads, so nothing is
 * lost.
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * `null` rather than a throw for anything that is not well-formed base64url.
 *
 * Return type is `Uint8Array<ArrayBuffer>`, not bare `Uint8Array`: TypeScript
 * 6's typed arrays default their buffer parameter to `ArrayBufferLike`
 * (`ArrayBuffer | SharedArrayBuffer`), which `crypto.subtle.verify`'s
 * `BufferSource` param does not accept -- MEASURED via `npm run check` failing
 * on the `signatureBytes` call below with exactly that mismatch. `Uint8Array.
 * from` already allocates a plain `ArrayBuffer`; this only makes the type say
 * what the value already is.
 */
function fromBase64Url(segment: string): Uint8Array<ArrayBuffer> | null {
  if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const padded = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=');
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * 128 bits from the platform CSPRNG, base64url -- 22 characters, no padding.
 *
 * Not a UUID: a v4 UUID spends 6 of its 128 bits on version and variant
 * markers and costs 36 characters to say 122 bits. Nothing here needs a UUID's
 * interoperability, and the id ends up in a URL and a shell argument.
 */
export function newJti(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

async function hmacKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * The claims, canonically. Key order is fixed by this function rather than by
 * `JSON.stringify`'s insertion order, because the signed bytes ARE the payload
 * segment: two encodings of the same claims that differ by key order would be
 * two different tokens, and only one of them would be the one in the registry.
 */
function encodeClaims(claims: TokenClaims): string {
  const canonical = {
    v: claims.v,
    jti: claims.jti,
    aud: claims.aud,
    scopes: claims.scopes,
    iat: claims.iat,
    exp: claims.exp,
  };
  return toBase64Url(encoder.encode(JSON.stringify(canonical)));
}

/**
 * Reads a payload segment back into claims, or `null`.
 *
 * Every field is checked, including the ones a caller "obviously" set, because
 * this function's input is a string a stranger supplied. `scopes` is checked
 * against `SCOPES` specifically: an unknown scope name is refused at the
 * format layer rather than carried into a `Grant`, where it would sit
 * harmlessly in an array that no `hasScope` call ever matches -- harmless
 * until someone adds a scope with that name and a years-old token silently
 * acquires it.
 *
 * The object returned carries exactly these six known fields: any other field
 * present in the SIGNED payload is silently dropped. Deliberate for a strict
 * format reader, but it costs a lossless round-trip -- `verdict.claims` is not
 * a faithful image of the signed bytes, so a future path that re-signs or
 * persists `verdict.claims` cannot assume it gets back what was signed.
 */
function decodeClaims(segment: string): TokenClaims | null {
  const bytes = fromBase64Url(segment);
  if (bytes === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const value = parsed as Record<string, unknown>;
  if (typeof value.jti !== 'string' || value.jti.length === 0) return null;
  if (typeof value.aud !== 'string' || value.aud.length === 0) return null;
  if (!Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp)) return null;
  if (!Array.isArray(value.scopes)) return null;
  if (!value.scopes.every(isScope)) return null;
  // The version is READ but not judged here: an unrecognised version is a
  // different refusal reason from a malformed one, and `verifyToken` is where
  // the two are told apart. Consequence, MEASURED (see `verifyToken`'s
  // `claims.v !== 1` check): every other v1 field is validated above, so
  // `'unsupported_version'` is reachable only by a payload that is v1-shaped
  // in every respect AND carries a `v` that is a number other than 1 -- the
  // same payload with any other field invalid, or with a non-number `v`, is
  // refused as `'malformed'` here instead.
  if (typeof value.v !== 'number') return null;

  return {
    v: value.v as 1,
    jti: value.jti,
    aud: value.aud,
    scopes: value.scopes,
    iat: value.iat as number,
    exp: value.exp as number,
  };
}

/** Signs claims into a token. The only place a token is created. */
export async function mintToken(key: string, claims: TokenClaims): Promise<string> {
  const payload = encodeClaims(claims);
  const signed = `${TOKEN_SCHEME}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(key), encoder.encode(signed));
  return `${signed}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verifies a token's signature, version and expiry. Says nothing about
 * revocation -- that is ./registry.ts, and ./grant.ts asks both.
 *
 * ORDER MATTERS and is deliberate: signature first, then decoding the claims
 * (malformed), then version, then expiry. Checking expiry before the
 * signature would let an unsigned string with a past `exp` come back
 * `'expired'`, which reads as "this used to be valid" about a token that
 * never was.
 *
 * `crypto.subtle.verify` rather than comparing digests by hand: it is the
 * platform's constant-time comparison, and a hand-rolled `===` on two hex
 * strings is the classic timing side channel in exactly this function.
 */
export async function verifyToken(
  key: string,
  token: string,
  nowSeconds: number,
): Promise<TokenVerdict> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [scheme, payload, signature] = parts;
  if (scheme !== TOKEN_SCHEME) return { ok: false, reason: 'malformed' };

  const signatureBytes = fromBase64Url(signature);
  if (signatureBytes === null) return { ok: false, reason: 'malformed' };

  const verified = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(key),
    signatureBytes,
    encoder.encode(`${scheme}.${payload}`),
  );
  if (!verified) return { ok: false, reason: 'bad_signature' };

  const claims = decodeClaims(payload);
  if (claims === null) return { ok: false, reason: 'malformed' };
  if (claims.v !== 1) return { ok: false, reason: 'unsupported_version' };
  // `>=`, not `>`: a token is dead AT its expiry instant, not one second after.
  if (nowSeconds >= claims.exp) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}
