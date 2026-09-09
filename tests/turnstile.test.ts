import { expect, test } from 'vitest';
import { SITEVERIFY_URL, verifyTurnstile, type TurnstileEnv } from '../src/lib/turnstile';

const env = (over: Partial<TurnstileEnv> = {}): TurnstileEnv => ({
  RLME_TURNSTILE_SECRET_KEY: { get: async () => 'a-fixture-secret' } as SecretsStoreSecret,
  ...over,
});

test('a success response verifies, and the secret is sent as form data', async () => {
  let seen: { url: string; body: URLSearchParams } | null = null;
  const verdict = await verifyTurnstile(env(), 'a-response-token', '203.0.113.1', (async (
    url,
    init,
  ) => {
    seen = { url: String(url), body: new URLSearchParams(String((init as RequestInit).body)) };
    return new Response(JSON.stringify({ success: true }));
  }) as typeof fetch);

  expect(verdict).toEqual({ ok: true });
  expect(seen!.url).toBe(SITEVERIFY_URL);
  expect(seen!.body.get('response')).toBe('a-response-token');
  expect(seen!.body.get('remoteip')).toBe('203.0.113.1');
  // Present, and asserted by KEY only. Asserting the value would put a
  // fixture secret's contents in a failure message; asserting the key is what
  // actually catches the bug (a request that forgot to send it).
  expect(seen!.body.has('secret')).toBe(true);
});

test('a null remote IP is omitted from the body entirely, not sent empty', async () => {
  // Pins the module's own comment (src/lib/turnstile.ts): remoteip is
  // "omitted rather than sent empty when the header is absent -- an empty
  // remoteip is a different input from no remoteip." The test above covers
  // the present-and-populated case; this is the omission itself, asserted by
  // key rather than by value -- `body.get('remoteip')` would return `null`
  // for BOTH "absent" and "present but empty", so only `.has()` distinguishes
  // the case this module claims to handle.
  let seen: URLSearchParams | null = null;
  const verdict = await verifyTurnstile(env(), 'a-response-token', null, (async (_url, init) => {
    seen = new URLSearchParams(String((init as RequestInit).body));
    return new Response(JSON.stringify({ success: true }));
  }) as typeof fetch);

  expect(verdict).toEqual({ ok: true });
  expect(seen!.has('remoteip')).toBe(false);
});

test('a failure response carries the error codes through', async () => {
  const verdict = await verifyTurnstile(
    env(),
    'x',
    null,
    (async () =>
      new Response(
        JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
      )) as typeof fetch,
  );
  expect(verdict).toEqual({ ok: false, codes: ['invalid-input-response'] });
});

test('a missing token is refused without a network call', async () => {
  let called = false;
  const verdict = await verifyTurnstile(env(), null, null, (async () => {
    called = true;
    return new Response('{}');
  }) as typeof fetch);
  expect(verdict).toEqual({ ok: false, codes: ['missing-input-response'] });
  expect(called).toBe(false);
});

test('a network failure is a refusal, not a throw and not a pass', async () => {
  // FAILS CLOSED. A siteverify outage must not become an open door -- the
  // form it guards spends Opus tokens.
  const verdict = await verifyTurnstile(env(), 'x', null, (async () => {
    throw new Error('network down');
  }) as typeof fetch);
  expect(verdict).toEqual({ ok: false, codes: ['verification-unavailable'] });
});

test('a non-JSON response is a refusal', async () => {
  const verdict = await verifyTurnstile(
    env(),
    'x',
    null,
    (async () => new Response('<html>a proxy error page</html>')) as typeof fetch,
  );
  expect(verdict.ok).toBe(false);
});

test('the stub mode passes without a secret and without a network call', async () => {
  let called = false;
  const verdict = await verifyTurnstile(
    {
      RLME_TURNSTILE_SECRET_KEY: {
        get: async () => {
          throw new Error('no local secret');
        },
      } as unknown as SecretsStoreSecret,
      RLME_TURNSTILE_MODE: 'stub',
    },
    'anything',
    null,
    (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch,
  );
  expect(verdict).toEqual({ ok: true });
  expect(called).toBe(false);
});

test('an unrecognised mode throws rather than guessing', async () => {
  await expect(
    verifyTurnstile({ ...env(), RLME_TURNSTILE_MODE: 'maybe' }, 'x', null),
  ).rejects.toThrow(/RLME_TURNSTILE_MODE/);
});
