import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPacer, nextRevealAt, revealGap, splitBlocks } from '../src/lib/chat/reveal';

describe('splitBlocks', () => {
  test('text with no blank line is all tail', () => {
    expect(splitBlocks('one paragraph so far')).toEqual({
      blocks: [],
      rest: 'one paragraph so far',
    });
  });

  test('a blank line finishes a block', () => {
    expect(splitBlocks('first\n\nsecond')).toEqual({ blocks: ['first'], rest: 'second' });
  });

  test('a blank line split across two chunks still breaks the block', () => {
    const first = splitBlocks('first\n');
    expect(first.blocks).toEqual([]);
    expect(splitBlocks(`${first.rest}\nsecond`)).toEqual({ blocks: ['first'], rest: 'second' });
  });

  test('extra blank lines and whitespace-only lines make no empty blocks', () => {
    expect(splitBlocks('a\n\n\n  \n\nb\n\n')).toEqual({ blocks: ['a', 'b'], rest: '' });
  });

  test('CRLF is a line break, including a CR left at the end of a chunk', () => {
    expect(splitBlocks('a\r\n\r\nb')).toEqual({ blocks: ['a'], rest: 'b' });
    const first = splitBlocks('a\r\n\r');
    expect(first.blocks).toEqual([]);
    expect(splitBlocks(`${first.rest}\nb`)).toEqual({ blocks: ['a'], rest: 'b' });
  });
});

describe('revealGap', () => {
  test('is half a second plus a millisecond a character', () => {
    expect(revealGap('')).toBe(500);
    expect(revealGap('x'.repeat(300))).toBe(800);
  });

  test('is capped at a second and a half', () => {
    expect(revealGap('x'.repeat(5000))).toBe(1500);
  });
});

describe('nextRevealAt', () => {
  test('the first block is shown at once', () => {
    expect(nextRevealAt(Number.NEGATIVE_INFINITY, 1000, 'abc')).toBe(1000);
  });

  test('a block that arrives early waits out the gap', () => {
    expect(nextRevealAt(1000, 1100, 'x'.repeat(100))).toBe(1600);
  });

  test('a block that arrives late is shown at once', () => {
    expect(nextRevealAt(1000, 5000, 'abc')).toBe(5000);
  });
});

describe('createPacer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('reveals the first block at once and spaces the rest', () => {
    const shown: string[] = [];
    const pacer = createPacer(
      (block) => shown.push(block),
      () => Date.now(),
    );
    pacer.push('a');
    pacer.push('b');
    expect(shown).toEqual(['a']);
    // 'b' is one character, so its gap is 501ms.
    vi.advanceTimersByTime(501);
    expect(shown).toEqual(['a', 'b']);
  });

  test('idle resolves only once the queue has drained', async () => {
    const shown: string[] = [];
    const pacer = createPacer(
      (block) => shown.push(block),
      () => Date.now(),
    );
    pacer.push('a');
    pacer.push('b');
    let settled = false;
    const idle = pacer.idle().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(501);
    await idle;
    expect(settled).toBe(true);
  });

  test('a reveal that throws does not strand the queue or hang idle', async () => {
    // idle() is awaited before the page re-enables Send, so a stranded queue
    // would leave the composer disabled until a reload (final review, #403).
    const shown: string[] = [];
    const pacer = createPacer(
      (block) => {
        if (block === 'b') throw new Error('render failed');
        shown.push(block);
      },
      () => Date.now(),
    );
    pacer.push('a');
    pacer.push('b');
    pacer.push('c');
    const idle = pacer.idle();
    await vi.advanceTimersByTimeAsync(5000);
    await idle;
    expect(shown).toEqual(['a', 'c']);
  });

  test('a reveal that throws during flush still shows the rest', () => {
    const shown: string[] = [];
    const pacer = createPacer(
      (block) => {
        if (block === 'b') throw new Error('render failed');
        shown.push(block);
      },
      () => Date.now(),
    );
    pacer.push('a');
    pacer.push('b');
    pacer.push('c');
    pacer.flush();
    expect(shown).toEqual(['a', 'c']);
  });

  test('idle on an empty pacer resolves at once', async () => {
    await expect(
      createPacer(
        () => {},
        () => Date.now(),
      ).idle(),
    ).resolves.toBeUndefined();
  });

  test('flush reveals everything queued, in order, and cancels the timer', async () => {
    const shown: string[] = [];
    const pacer = createPacer(
      (block) => shown.push(block),
      () => Date.now(),
    );
    pacer.push('a');
    pacer.push('b');
    pacer.push('c');
    pacer.flush();
    expect(shown).toEqual(['a', 'b', 'c']);
    vi.advanceTimersByTime(5000);
    expect(shown).toEqual(['a', 'b', 'c']);
    await expect(pacer.idle()).resolves.toBeUndefined();
  });
});
