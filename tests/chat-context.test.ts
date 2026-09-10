import { describe, expect, test } from 'vitest';
import {
  CHAT_CONTEXT_CHAR_BUDGET,
  citationsIn,
  numberSources,
  renderChatContext,
} from '../src/lib/chat/context';

const citation = (slug: string, excerpt: string) => ({
  type: 'post' as const,
  slug,
  chunk: 0,
  url: `https://ryanlindsey.me/writing/${slug}`,
  score: 0.7,
  excerpt,
  exact: true,
});

describe('numberSources', () => {
  test('numbers from one, in the order retrieval returned them', () => {
    const sources = numberSources([citation('a', 'alpha'), citation('b', 'beta')]);
    expect(sources.map((source) => source.n)).toEqual([1, 2]);
    expect(sources[0]?.title).toBe('a');
  });
});

describe('renderChatContext', () => {
  test('every source is fenced and labelled with its own number and URL', () => {
    const { text } = renderChatContext(numberSources([citation('a', 'alpha')]));
    expect(text).toContain('## [1] a');
    expect(text).toContain('https://ryanlindsey.me/writing/a');
    expect(text).toContain('```markdown\nalpha\n```');
  });

  test('the fence is longer than any backtick run inside the excerpt', () => {
    const { text } = renderChatContext(numberSources([citation('a', 'x\n```\nfake\n```')]));
    expect(text).toContain('````markdown');
  });

  // 200, and the number is arithmetic rather than taste: a source with a
  // one-character slug and a 60-character excerpt renders to 128 characters
  // once its `## [n] title` heading, its `Source:` line and its fence are
  // counted. So 200 admits exactly one and refuses the second (128 + 1
  // separator + 128 = 257), which is the condition both tests below are about.
  // A budget under 128 would drop BOTH and quietly test nothing.
  const TWO_SOURCES = () =>
    numberSources([citation('a', 'x'.repeat(60)), citation('b', 'y'.repeat(60))]);

  test('a source that does not fit is dropped whole and reported', () => {
    const rendered = renderChatContext(TWO_SOURCES(), 200);
    expect(rendered.truncated).toBe(true);
    expect(rendered.included).toHaveLength(1);
    expect(rendered.text).not.toContain('yyy');
  });

  test('a dropped source loses its number entirely, so the model cannot cite it', () => {
    const rendered = renderChatContext(TWO_SOURCES(), 200);
    expect(rendered.included.map((source) => source.n)).toEqual([1]);
  });

  test('an inexact excerpt is labelled as the document rather than the passage', () => {
    const source = { ...citation('a', 'alpha'), exact: false };
    const { text } = renderChatContext(numberSources([source]));
    expect(text).toContain('opening of the document');
  });

  test('the budget is a ceiling that today’s corpus is nowhere near', () => {
    expect(CHAT_CONTEXT_CHAR_BUDGET).toBe(24_000);
  });
});

describe('citationsIn', () => {
  test('collects each cited number once, in order', () => {
    expect(citationsIn('a [2] b [1] c [2]', 3)).toEqual({ cited: [2, 1], invalid: [] });
  });

  test('a number outside the source list is invalid, not cited', () => {
    expect(citationsIn('a [4] b [1]', 3)).toEqual({ cited: [1], invalid: [4] });
  });

  test('zero is invalid, because sources are numbered from one', () => {
    expect(citationsIn('[0]', 3)).toEqual({ cited: [], invalid: [0] });
  });

  test('bracketed text that is not a number is ignored entirely', () => {
    expect(citationsIn('[see the résumé] and [1]', 2)).toEqual({ cited: [1], invalid: [] });
  });
});
