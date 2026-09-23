import { expect, test } from 'vitest';
import { MarkerGate, PRIVATE_TIER_ANSWER, PRIVATE_TIER_MARKER } from '../src/lib/chat/private-tier';

// Issue #341: the leak suite's run of 2026-09-23 failed probes[0] and
// probes[1] because the model wrote its own private-tier sentence and echoed
// the question's premise in it, after prompts/chat.md had spelled out the
// sentence to use. The model now signals with a marker and the server writes
// the reply, so these tests pin the part that decides which one a reader sees.

/** Feeds deltas through a fresh gate and returns what a reader would receive. */
function run(deltas: string[]): { shown: string; private: boolean } {
  const gate = new MarkerGate();
  let shown = '';
  for (const delta of deltas) {
    const step = gate.push(delta);
    if (step.kind === 'private') return { shown, private: true };
    if (step.kind === 'pass') shown += step.text;
  }
  const rest = gate.finish();
  if (rest.kind === 'pass') shown += rest.text;
  return { shown, private: false };
}

test('the marker in one delta is a private-tier answer', () => {
  expect(run([PRIVATE_TIER_MARKER])).toEqual({ shown: '', private: true });
});

test('the marker split across deltas is recognized, and nothing leaks before it', () => {
  expect(run(['[[', 'priv', 'ate-', 'tier]]'])).toEqual({ shown: '', private: true });
});

test('leading whitespace before the marker is ignored', () => {
  expect(run(['\n', '  [[private-tier]]'])).toEqual({ shown: '', private: true });
});

test('text after the marker is dropped with the rest of the answer', () => {
  expect(run(['[[private-tier]]\n\nHe may be open to it.'])).toEqual({
    shown: '',
    private: true,
  });
});

test('an ordinary answer passes through unchanged', () => {
  expect(run(['He built ', 'the fit engine [1].'])).toEqual({
    shown: 'He built the fit engine [1].',
    private: false,
  });
});

test('a near miss is released in full once it diverges from the marker', () => {
  expect(run(['[[priv', 'acy] is covered in [2].'])).toEqual({
    shown: '[[privacy] is covered in [2].',
    private: false,
  });
});

test('a prefix of the marker at the end of the stream is released rather than swallowed', () => {
  expect(run(['[[priv'])).toEqual({ shown: '[[priv', private: false });
});

test('a marker after other text is not honored, since that text is already on screen', () => {
  expect(run(['Sure. ', '[[private-tier]]'])).toEqual({
    shown: 'Sure. [[private-tier]]',
    private: false,
  });
});

test('the fixed answer names the private tier and both routes', () => {
  expect(PRIVATE_TIER_ANSWER).toBe(
    'Questions about his working arrangements are held in his private tier. To ask him directly, email hello@ryanlindsey.me. To have your agent ask instead, request a scoped token at the same address and connect it to his MCP server at https://mcp.ryanlindsey.me/mcp.',
  );
});
