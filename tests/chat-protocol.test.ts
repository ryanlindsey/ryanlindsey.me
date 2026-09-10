import { describe, expect, test } from 'vitest';
import { parseModelSse, sseFrame } from '../src/lib/chat/protocol';
import { CHAT_ERROR_COPY, chatErrorCopy } from '../src/lib/chat/errors';

describe('sseFrame', () => {
  test('is a named event with one JSON data line and a blank line', () => {
    expect(sseFrame('delta', { text: 'hi' })).toBe('event: delta\ndata: {"text":"hi"}\n\n');
  });

  test('a payload containing a newline cannot break the framing', () => {
    const frame = sseFrame('delta', { text: 'a\nb' });
    expect(frame.split('\n').filter((line) => line.startsWith('data:'))).toHaveLength(1);
  });
});

describe('parseModelSse', () => {
  test('extracts text deltas and keeps the incomplete tail', () => {
    const buffer =
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_del';
    const parsed = parseModelSse(buffer);
    expect(parsed.text).toBe('Hel');
    expect(parsed.rest).toContain('content_block_del');
    expect(parsed.done).toBe(false);
  });

  test('ignores every event that is not a text delta', () => {
    const buffer =
      'event: message_start\ndata: {"type":"message_start"}\n\nevent: ping\ndata: {"type":"ping"}\n\n';
    expect(parseModelSse(buffer).text).toBe('');
  });

  test('reports the end of the message', () => {
    expect(parseModelSse('event: message_stop\ndata: {"type":"message_stop"}\n\n').done).toBe(true);
  });

  test('a data line that is not JSON is skipped rather than thrown on', () => {
    expect(() => parseModelSse('event: x\ndata: not json\n\n')).not.toThrow();
  });

  test('a frame split across two chunks loses nothing when the tail is carried', () => {
    // The bug this pins is the one the module's own comment names: splitting on
    // '\n\n' and dropping the remainder produces a chat that loses a word every
    // few hundred characters and passes every single-chunk test.
    const whole =
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello there"}}\n\n';
    const first = parseModelSse(whole.slice(0, 60));
    const second = parseModelSse(first.rest + whole.slice(60));
    expect(first.text + second.text).toBe('Hello there');
  });
});

describe('chatErrorCopy', () => {
  test('every code has copy and an unknown code renders nothing', () => {
    for (const code of Object.keys(CHAT_ERROR_COPY)) expect(chatErrorCopy(code)).toBeTruthy();
    expect(chatErrorCopy('made-up')).toBeNull();
    expect(chatErrorCopy(null)).toBeNull();
  });

  test('no copy leaks an upstream error code or a provider name at the reader', () => {
    // `AiError: 2018 …` reaching a reader would publish the gateway's internals
    // and misreport a rate limit as an auth failure (10 §5).
    for (const copy of Object.values(CHAT_ERROR_COPY)) {
      expect(copy).not.toMatch(/\b\d{4}\b/);
      expect(copy).not.toMatch(/anthropic|AiError|gateway/i);
    }
  });
});
