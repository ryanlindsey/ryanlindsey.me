import { describe, expect, it } from 'vitest';
import type { ChatErrorCode } from '../src/lib/chat/errors';
import {
  FAILURE_DETAIL_MAX,
  FAILURE_REASONS,
  classifyChatCode,
  classifyFailure,
  isRefusal,
  type FailureReason,
} from '../src/lib/failure/classify';

function tagged(reason: string, message = 'tagged', cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  Object.defineProperty(error, 'failureReason', { value: reason, enumerable: true });
  return error;
}

describe('classifyFailure upstream patterns', () => {
  const cases: [string, unknown, FailureReason][] = [
    ['2018 string', '2018: Invalid User Credentials', 'gateway_limit'],
    ['2018 error', new Error('2018: Invalid User Credentials'), 'gateway_limit'],
    [
      'wholesale string',
      'Wholesale rate limit exceeded for this gateway. Please reduce request rate or use BYOK.',
      'gateway_limit',
    ],
    [
      'wholesale error',
      new Error(
        'Wholesale rate limit exceeded for this gateway. Please reduce request rate or use BYOK.',
      ),
      'gateway_limit',
    ],
    ['status 429', { status: 429, message: 'x' }, 'gateway_limit'],
    [
      'insufficient balance string',
      'Insufficient balance; add money to your gateway or use BYOK',
      'gateway_billing',
    ],
    [
      'insufficient balance error',
      new Error('Insufficient balance; add money to your gateway or use BYOK'),
      'gateway_billing',
    ],
    ['2021', new Error('2021: no funds'), 'gateway_billing'],
    ['7003 string', '7003: User Input Error', 'provider_rejected'],
    ['7003 error', new Error('7003: User Input Error'), 'provider_rejected'],
    ['status 400', { status: 400 }, 'provider_rejected'],
    ['status 503', { status: 503 }, 'provider_unavailable'],
    ['3040 string', '3040: Out of capacity', 'provider_unavailable'],
    ['3040 error', new Error('3040: Out of capacity'), 'provider_unavailable'],
    ['fetch failed', new TypeError('fetch failed'), 'provider_unavailable'],
    ['timeout', new Error('request timed out'), 'provider_unavailable'],
  ];
  for (const [name, input, reason] of cases) {
    it(`${name} -> ${reason}`, () => {
      expect(classifyFailure(input).reason).toBe(reason);
    });
  }

  it('keeps the matched message as the detail', () => {
    expect(classifyFailure('7003: User Input Error')).toEqual({
      reason: 'provider_rejected',
      detail: '7003: User Input Error',
    });
  });

  it('falls back to the status when the matched link has no message', () => {
    expect(classifyFailure({ status: 503 }).detail).toBe('status 503');
  });

  it('finds an upstream code in a cause', () => {
    expect(classifyFailure(new Error('wrapper', { cause: '7003: bad' })).reason).toBe(
      'provider_rejected',
    );
  });

  it('first matching rule wins when text carries two patterns', () => {
    expect(classifyFailure('429 Wholesale rate limit exceeded ... 7003').reason).toBe(
      'gateway_limit',
    );
  });
});

describe('classifyFailure precedence', () => {
  it('honors an own failureReason', () => {
    expect(classifyFailure(tagged('not_found')).reason).toBe('not_found');
  });

  it('ignores a failureReason outside the closed set', () => {
    expect(classifyFailure(tagged('made_up', 'boom')).reason).toBe('internal');
  });

  it('ignores an inherited failureReason', () => {
    const error = Object.create({ failureReason: 'not_found' }) as Error;
    Object.assign(error, { message: 'boom', name: 'Error' });
    expect(classifyFailure(error).reason).toBe('internal');
  });

  it('tag beats upstream', () => {
    expect(classifyFailure(tagged('bad_output', 'x', '7003: nope')).reason).toBe('bad_output');
  });

  function chatUnavailable(code: string, cause?: unknown): Error {
    const error = new Error('chat unavailable', cause === undefined ? undefined : { cause });
    error.name = 'ChatUnavailable';
    Object.assign(error, { code });
    return error;
  }

  it('upstream beats chat code', () => {
    const result = classifyFailure(
      chatUnavailable('unreachable', new Error('7003: User Input Error')),
    );
    expect(result).toEqual({ reason: 'provider_rejected', detail: '7003: User Input Error' });
  });

  it('chat code applies without an upstream cause', () => {
    expect(classifyFailure(chatUnavailable('unreachable')).reason).toBe('provider_unavailable');
  });
});

describe('classifyChatCode', () => {
  const expected: Record<ChatErrorCode, FailureReason> = {
    'rate-limited': 'local_limit',
    paused: 'local_limit',
    'bot-check': 'caller_input',
    empty: 'caller_input',
    'too-long': 'caller_input',
    unreachable: 'provider_unavailable',
    'no-answer': 'bad_output',
  };
  for (const [code, reason] of Object.entries(expected)) {
    it(`${code} -> ${reason}`, () => {
      expect(classifyChatCode(code as ChatErrorCode)).toBe(reason);
    });
  }
});

describe('classifyFailure fallbacks and bounds', () => {
  it('classifies an ordinary error as internal', () => {
    expect(classifyFailure(new Error('boom'))).toEqual({
      reason: 'internal',
      detail: 'Error: boom',
    });
  });

  it('does not throw on hostile input', () => {
    const cyclic = new Error('loop');
    Object.assign(cyclic, { cause: cyclic });
    const getter = {
      get message(): string {
        throw new Error('getter');
      },
    };
    let deep: unknown = new Error('bottom');
    for (let i = 0; i < 20; i += 1) deep = new Error(`link ${i}`, { cause: deep });
    for (const input of [undefined, null, 'a string', 42, cyclic, getter, deep]) {
      expect(() => classifyFailure(input)).not.toThrow();
      expect(classifyFailure(input).reason).toBe('internal');
    }
  });

  it('bounds the detail', () => {
    expect(classifyFailure(new Error('x'.repeat(1000))).detail.length).toBeLessThanOrEqual(
      FAILURE_DETAIL_MAX,
    );
    expect(classifyFailure(`7003 ${'y'.repeat(1000)}`).detail.length).toBeLessThanOrEqual(
      FAILURE_DETAIL_MAX,
    );
  });
});

describe('isRefusal', () => {
  it('is true for exactly local_limit, caller_input and no_sources', () => {
    const refusals = FAILURE_REASONS.filter((reason) => isRefusal(reason));
    expect(refusals).toEqual(['local_limit', 'no_sources', 'caller_input']);
  });
});
