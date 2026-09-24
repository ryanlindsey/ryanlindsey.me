// How a streamed answer reaches the page: one finished block at a time, paced
// (#403).
//
// WHY BLOCKS AND NOT TOKENS. A token trickle reads as a machine printing; a
// paragraph arriving whole, with the typing dots under it while the next is
// written, reads as somebody answering. It also means the markdown parser only
// ever sees finished text.
//
// WHY A MINIMUM GAP. The model usually takes seconds per paragraph, so most
// blocks arrive late enough to show at once and this adds nothing. When it is
// fast, two paragraphs landing together would read as one dump, so the second
// waits `revealGap` after the first. The cap bounds what that can ever cost a
// reader.

/**
 * The finished blocks in `buffer`, and the unfinished tail to carry into the
 * next call.
 *
 * STREAM PARSING IS BUFFER PARSING, as src/lib/chat/protocol.ts says of the
 * frames: a blank line can straddle two deltas, so the caller concatenates
 * each delta onto `rest` rather than splitting deltas on their own.
 *
 * A CR at the very end is left alone for the same reason: it may be the first
 * half of a CRLF whose LF is in the next delta, and turning it into a newline
 * now would make that pair a blank line.
 */
export function splitBlocks(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n|\r(?!$)/g, '\n');
  const parts = normalized.split(/\n[ \t]*\n/);
  const rest = parts.pop() ?? '';
  return { blocks: parts.map((part) => part.trim()).filter((part) => part !== ''), rest };
}

export function revealGap(block: string): number {
  return Math.min(500 + block.length, 1500);
}

/** When `block` may be shown, given when the one before it was. */
export function nextRevealAt(previous: number, now: number, block: string): number {
  return Math.max(now, previous + revealGap(block));
}

export interface Pacer {
  /** Queue a finished block. The first one after a quiet spell shows at once. */
  push(block: string): void;
  /** Show everything queued, now, in order. For an error or a failed fetch. */
  flush(): void;
  /** Resolves when nothing is queued and nothing is waiting to show. */
  idle(): Promise<void>;
}

export function createPacer(
  reveal: (block: string) => void,
  now: () => number = () => performance.now(),
): Pacer {
  const queue: string[] = [];
  const waiters: (() => void)[] = [];
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = () => {
    if (queue.length > 0 || timer !== undefined) return;
    for (const resolve of waiters.splice(0)) resolve();
  };

  const show = () => {
    const block = queue.shift();
    if (block === undefined) return;
    last = now();
    // A block that fails to render is dropped rather than allowed to throw
    // out of a timer callback: that would strand the rest of the queue and
    // never settle idle(), which the page awaits before it re-enables Send.
    try {
      reveal(block);
    } catch (error) {
      console.error(`chat: a block failed to render: ${String(error)}`);
    }
  };

  const pump = () => {
    if (timer !== undefined) return;
    const next = queue[0];
    if (next === undefined) return settle();
    const delay = nextRevealAt(last, now(), next) - now();
    if (delay <= 0) {
      show();
      pump();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      show();
      pump();
    }, delay);
  };

  return {
    push(block) {
      queue.push(block);
      pump();
    },
    flush() {
      clearTimeout(timer);
      timer = undefined;
      while (queue.length > 0) show();
      settle();
    },
    idle() {
      if (queue.length === 0 && timer === undefined) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
