import { describe, expect, test } from 'vitest';
import { mintToken, verifyToken, newJti, SCOPES, type TokenClaims } from '../src/lib/tier/token';

const KEY = 'a-fixture-signing-key-not-used-anywhere-real';
const NOW = 1_800_000_000; // epoch seconds, fixed so expiry is arithmetic rather than timing

const claims = (over: Partial<TokenClaims> = {}): TokenClaims => ({
  v: 1,
  jti: 'fixture-jti',
  aud: 'fixture-audience',
  scopes: ['fit', 'profile'],
  iat: NOW,
  exp: NOW + 3600,
  ...over,
});

test('a freshly minted token verifies and round-trips its claims exactly', async () => {
  const token = await mintToken(KEY, claims());
  const verdict = await verifyToken(KEY, token, NOW);
  expect(verdict.ok).toBe(true);
  if (verdict.ok) expect(verdict.claims).toEqual(claims());
});

test('the token is three dot-separated segments beginning with the scheme', async () => {
  const token = await mintToken(KEY, claims());
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  expect(parts[0]).toBe('rlme1');
  // base64url only: no +, / or = anywhere, so a token survives a query string
  // and a shell argument without escaping.
  expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
});

test('base64url round-trips across payload lengths, not just the fixture length', async () => {
  // Every other test in this file mints through `claims()`'s fixed `aud`, so
  // its payload segment lands in the same mod-4 padding class every time.
  // Padding bugs live at the class boundaries -- `toBase64Url` strips `=`
  // padding, and `fromBase64Url` has to reconstruct exactly the right amount
  // of it back -- so this varies `aud`'s length one character at a time,
  // which walks the encoded payload's byte length through all four mod-4
  // remainders rather than exercising only one of them four times.
  const auds = ['a', 'ab', 'abc', 'abcd', 'abcdefghijklmnopqrstuvwxyz'];
  for (const aud of auds) {
    const token = await mintToken(KEY, claims({ aud }));
    const verdict = await verifyToken(KEY, token, NOW);
    expect(verdict, `aud of length ${aud.length} should round-trip`).toEqual({
      ok: true,
      claims: claims({ aud }),
    });
  }
});

describe('refusals', () => {
  test('a different key does not verify', async () => {
    const token = await mintToken(KEY, claims());
    const verdict = await verifyToken('a-different-key-entirely', token, NOW);
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('a tampered claims segment does not verify', async () => {
    const token = await mintToken(KEY, claims());
    const [scheme, payload, signature] = token.split('.');
    // Flip one character of the payload; base64url alphabets differ at 'A'/'B'
    // so this is a real edit rather than an alias of the same bytes.
    const edited = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    const verdict = await verifyToken(KEY, `${scheme}.${edited}.${signature}`, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(['bad_signature', 'malformed']).toContain(verdict.reason);
  });

  test('a well-formed scope escalation under the original signature is refused', async () => {
    // This is the actual attack the signature exists to stop, and it is a
    // different test from the one above on purpose: flipping one base64
    // character (above) corrupts the JSON, so `decodeClaims` alone would
    // already refuse it -- that test would still pass with the signature
    // check deleted entirely. This payload is well-formed end to end (valid
    // base64url, valid JSON, valid scope names, the works), built by minting
    // a real token for the WIDER claims and keeping only its payload
    // segment. Only `crypto.subtle.verify`, matching that payload against a
    // signature computed over the narrower claims, stands between it and
    // acceptance.
    const narrow = await mintToken(KEY, claims({ scopes: ['fit'] }));
    const wide = await mintToken(KEY, claims({ scopes: [...SCOPES] }));
    const [scheme, , narrowSignature] = narrow.split('.');
    const [, widePayload] = wide.split('.');
    const forged = `${scheme}.${widePayload}.${narrowSignature}`;
    expect(await verifyToken(KEY, forged, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('re-labelling the scheme segment cannot survive verification', async () => {
    // The scheme is inside the signed bytes -- `mintToken` signs
    // `${scheme}.${payload}`, not just `payload` -- so relabelling it breaks
    // the signature on its own and this test would still pass with the
    // scheme-equality check deleted. It is worth keeping anyway: the
    // property being pinned is "relabelling the scheme cannot survive", and
    // the equality check below is only the FIRST of the two reasons that
    // holds. It is also the cheaper one -- `verifyToken` rejects on a string
    // compare here, before any crypto runs -- so this test also documents
    // that a relabelled token fails fast rather than paying for a signature
    // check it cannot pass anyway.
    const token = await mintToken(KEY, claims());
    const [, payload, signature] = token.split('.');
    const relabelled = `rlme2.${payload}.${signature}`;
    expect(await verifyToken(KEY, relabelled, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  test('an expired token is refused, and one second before expiry is not', async () => {
    const token = await mintToken(KEY, claims({ exp: NOW + 10 }));
    expect(await verifyToken(KEY, token, NOW + 9)).toMatchObject({ ok: true });
    expect(await verifyToken(KEY, token, NOW + 11)).toEqual({ ok: false, reason: 'expired' });
  });

  test('expiry is inclusive of the instant itself', async () => {
    // Stated as its own test because "expired at exactly exp" is the boundary
    // a revocation drill will land on, and a >= / > slip here is invisible.
    const token = await mintToken(KEY, claims({ exp: NOW + 10 }));
    expect(await verifyToken(KEY, token, NOW + 10)).toEqual({ ok: false, reason: 'expired' });
  });

  test('an unknown version is refused rather than parsed', async () => {
    const token = await mintToken(KEY, claims({ v: 2 as 1 }));
    expect(await verifyToken(KEY, token, NOW)).toEqual({
      ok: false,
      reason: 'unsupported_version',
    });
  });

  test('garbage of every shape is malformed, never a throw', async () => {
    for (const bad of ['', 'rlme1', 'rlme1.a', 'a.b.c', 'rlme1..', 'rlme1.!!!.???', 'Bearer x']) {
      const verdict = await verifyToken(KEY, bad, NOW);
      expect(verdict, `${JSON.stringify(bad)} should be refused, not thrown on`).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  test('an unrecognised scope name is refused rather than carried', async () => {
    // A scope the code does not know is not a scope the code can enforce, so
    // it fails closed at the format layer instead of arriving as a string
    // some later `includes()` silently never matches.
    const token = await mintToken(KEY, claims({ scopes: ['fit', 'everything'] as never }));
    expect(await verifyToken(KEY, token, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});

test('newJti is 128 bits of base64url and does not repeat', () => {
  const ids = new Set(Array.from({ length: 256 }, () => newJti()));
  expect(ids.size).toBe(256);
  for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
});

test('SCOPES is the closed set the rest of the tier keys on', () => {
  expect([...SCOPES]).toEqual(['fit', 'profile', 'documents', 'narrative']);
});
