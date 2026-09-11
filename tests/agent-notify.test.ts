import { describe, expect, test, vi } from 'vitest';
import {
  buildMimeMessage,
  buildNotification,
  sendNotification,
} from '../src/lib/agent-intel/notify';
import { handleEventBatch } from '../src/lib/agent-intel/consume';
import type { IntentEvent } from '../src/lib/agent-intel/intent';

// ANNOTATED, not inferred. Left to itself TypeScript reads this as a union of
// two object literals and widens each `detail` with the other's keys as
// `?: undefined` -- which is not assignable to `Record<string, string>`, so
// every call below fails to typecheck while passing at runtime. `npm test`
// would not have caught it; `npm run check` does, and so would CI.
const events: IntentEvent[] = [
  {
    kind: 'fit-run',
    at: '2026-09-09T12:00:00.000Z',
    detail: { audience: 'label-a', report: 'abc' },
  },
  {
    kind: 'gated-read',
    at: '2026-09-09T12:01:00.000Z',
    detail: { tool: 'get_references', audience: 'label-a' },
  },
];

describe('buildNotification', () => {
  test('the subject names the count and the highest-signal kind', () => {
    expect(buildNotification(events).subject).toBe('ryanlindsey.me: 2 events (fit-run)');
  });

  test('the body lists every event with its time and detail', () => {
    const { body } = buildNotification(events);
    expect(body).toContain('2026-09-09T12:00:00.000Z  fit-run  audience=label-a report=abc');
    expect(body).toContain('gated-read  tool=get_references');
  });

  test('a single event reads as one rather than as a batch', () => {
    expect(buildNotification([events[0]!]).subject).toBe('ryanlindsey.me: 1 event (fit-run)');
  });
});

describe('buildMimeMessage', () => {
  const parts = {
    from: 'notifications@ryanlindsey.me',
    to: 'somebody@example.com',
    subject: 'ryanlindsey.me: 1 event (fit-run)',
    body: 'line one\nline two',
    messageId: '<abc@ryanlindsey.me>',
    date: new Date('2026-09-09T12:00:00.000Z'),
  };

  test('every line ends CRLF and the header block is closed by a blank line', () => {
    const message = buildMimeMessage(parts);
    expect(message.split('\r\n')[0]).toBe('From: notifications@ryanlindsey.me');
    expect(message).toContain('\r\n\r\nline one\r\nline two');
    expect(message.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
  });

  test('the required headers are all present', () => {
    const message = buildMimeMessage(parts);
    for (const header of [
      'From:',
      'To:',
      'Subject:',
      'Message-ID:',
      'Date:',
      'MIME-Version:',
      'Content-Type:',
    ]) {
      expect(message).toContain(header);
    }
  });

  test('a header value carrying CR or LF is refused, not sanitised', () => {
    expect(() => buildMimeMessage({ ...parts, subject: 'ok\r\nBcc: someone@example.com' })).toThrow(
      /header value contains a line break/i,
    );
    expect(() => buildMimeMessage({ ...parts, to: 'a@b.com\nX-Injected: 1' })).toThrow();
  });
});

describe('sendNotification', () => {
  const stubEnv = () => ({
    EMAIL: { send: vi.fn() },
    RLME_NOTIFY_ADDRESS: { get: vi.fn(async () => 'somebody@example.com') },
    RLME_NOTIFY_FROM: 'notifications@ryanlindsey.me',
    RLME_NOTIFY_MODE: undefined as string | undefined,
  });

  test('an unrecognised mode throws rather than guessing', async () => {
    const env = { ...stubEnv(), RLME_NOTIFY_MODE: 'maybe' };
    await expect(sendNotification(env as never, events)).rejects.toThrow(/RLME_NOTIFY_MODE/);
  });

  test('the stub skips the secret read and the send', async () => {
    const env = { ...stubEnv(), RLME_NOTIFY_MODE: 'stub' };
    await expect(sendNotification(env as never, events)).resolves.toBe('skipped');
    expect(env.EMAIL.send).not.toHaveBeenCalled();
    expect(env.RLME_NOTIFY_ADDRESS.get).not.toHaveBeenCalled();
  });

  test('an absent destination secret skips the send and does not throw', async () => {
    const env = stubEnv();
    env.RLME_NOTIFY_ADDRESS.get = vi.fn(async () => {
      throw new Error('Secret "RLME_NOTIFY_ADDRESS" not found');
    });
    await expect(sendNotification(env as never, events)).resolves.toBe('skipped');
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  test('an empty event list sends nothing', async () => {
    const env = stubEnv();
    await expect(sendNotification(env as never, [])).resolves.toBe('skipped');
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });
});

describe('handleEventBatch', () => {
  test('messages that are not ours are dropped rather than mailed', async () => {
    const env = { EMAIL: { send: vi.fn() }, RLME_NOTIFY_MODE: 'stub' };
    await expect(
      handleEventBatch([{ body: { kind: 'nonsense' } }, { body: null }], env as never),
    ).resolves.toBe('skipped');
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });
});
