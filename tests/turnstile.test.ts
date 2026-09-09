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

test('a Secrets Store read failure is a refusal, not a throw and not a pass', async () => {
  // FAILS CLOSED on the secret read itself, not only on the network call that
  // follows it. `.get()` throws when the secret is absent -- rotated to
  // empty, deleted, or bound to a store a deploy has not written yet, the
  // same production cases src/lib/tier/grant.ts measured for
  // RLME_TOKEN_SIGNING_KEY, and this is the identical binding shape read a
  // second time here. A prior revision read the secret before the `try`, so
  // this failure propagated out of `verifyTurnstile` uncaught and the Worker
  // answered 500 instead of refusing -- fixed by moving the read inside the
  // `try`; this test is what pins that fix in place.
  let called = false;
  const verdict = await verifyTurnstile(
    env({
      RLME_TURNSTILE_SECRET_KEY: {
        get: async () => {
          throw new Error('secret unavailable');
        },
      } as unknown as SecretsStoreSecret,
    }),
    'x',
    null,
    (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch,
  );
  expect(verdict).toEqual({ ok: false, codes: ['verification-unavailable'] });
  // Not load-bearing either way (the read happens before the fetch in source
  // order), but worth recording: a failed secret read never reaches the wire.
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

test('a syntactically invalid JSON response is a refusal (the parse-error catch)', async () => {
  // Named for the path it exercises: `response.json()` throws on this body
  // (it isn't JSON at all), so this only reaches the generic `catch` --the
  // SAME path the network-failure test above already covers. It never
  // reaches the `typeof payload !== 'object'` guard below, which needs
  // syntactically VALID JSON that parses to a non-object to be exercised at
  // all -- see the two tests below for that.
  const verdict = await verifyTurnstile(
    env(),
    'x',
    null,
    (async () => new Response('<html>a proxy error page</html>')) as typeof fetch,
  );
  expect(verdict.ok).toBe(false);
});

test('a JSON `null` body is a refusal, not a thrown TypeError', async () => {
  // The object guard's actual target, and the reason it checks `payload ===
  // null` separately rather than trusting `typeof` alone: `typeof null ===
  // 'object'` in JS, so a `typeof payload !== 'object'` check by itself would
  // let a literal `null` body straight through to the property access on
  // `result.success` below it -- and property access on `null` THROWS a
  // TypeError, which would escape `verifyTurnstile` uncaught exactly like
  // finding 1's secret-read failure did. The explicit `payload === null`
  // clause is what turns that crash into an ordinary refusal.
  const verdict = await verifyTurnstile(
    env(),
    'x',
    null,
    (async () => new Response('null')) as typeof fetch,
  );
  expect(verdict).toEqual({ ok: false, codes: ['verification-unavailable'] });
});

test('a JSON `42` body is a refusal, not a thrown TypeError', async () => {
  // The guard's other shape: valid JSON, not null, still not an object.
  // Property access on a number does not throw in JS (`(42).success` is
  // `undefined`), so this does not pin a crash -- it pins that a body this
  // malformed is refused outright rather than silently read as "no success
  // field, so not a pass."
  const verdict = await verifyTurnstile(
    env(),
    'x',
    null,
    (async () => new Response('42')) as typeof fetch,
  );
  expect(verdict).toEqual({ ok: false, codes: ['verification-unavailable'] });
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

test('the stub mode still refuses a missing token', async () => {
  // The stub skips the Secrets Store read and the network call, and NOTHING
  // else -- the local missing-token refusal is checked before it, because the
  // real service refuses a missing token before any network call too.
  //
  // This is not a nicety. `/fit/run` answers this verdict with a sentence
  // about the bot check instead of spending a tool call, and a stub that
  // passed an absent token unconditionally made that branch unreachable by any
  // test in this repo. The test above ('the stub mode passes without a secret
  // and without a network call') passes a NON-EMPTY token and stays green: the
  // two together say the stub short-circuits the expensive half only.
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
    null,
    null,
    (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch,
  );
  expect(verdict).toEqual({ ok: false, codes: ['missing-input-response'] });
  expect(called).toBe(false);
});

test('an unrecognised mode throws rather than guessing', async () => {
  await expect(
    verifyTurnstile({ ...env(), RLME_TURNSTILE_MODE: 'maybe' }, 'x', null),
  ).rejects.toThrow(/RLME_TURNSTILE_MODE/);
});
