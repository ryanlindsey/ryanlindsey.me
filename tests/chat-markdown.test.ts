import { describe, expect, test } from 'vitest';
import { parseBlocks, parseInline } from '../src/lib/chat/markdown';

describe('parseInline', () => {
  test('plain text is one text node', () => {
    expect(parseInline('hello there')).toEqual([{ kind: 'text', text: 'hello there' }]);
  });

  test('bold, italic and code', () => {
    expect(parseInline('a **b** *c* _d_ `e`')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'text', text: ' ' },
      { kind: 'em', children: [{ kind: 'text', text: 'd' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'e' },
    ]);
  });

  test('a citation is a node carrying its number', () => {
    expect(parseInline('see [2].')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'citation', n: 2 },
      { kind: 'text', text: '.' },
    ]);
  });

  test('citations inside emphasis are still citations', () => {
    expect(parseInline('**shipped [1]**')).toEqual([
      {
        kind: 'strong',
        children: [
          { kind: 'text', text: 'shipped ' },
          { kind: 'citation', n: 1 },
        ],
      },
    ]);
  });

  test('code contents stay literal, citations and asterisks included', () => {
    expect(parseInline('`a [1] **b**`')).toEqual([{ kind: 'code', text: 'a [1] **b**' }]);
  });

  test('an unmatched delimiter is its own characters', () => {
    expect(parseInline('**open and `tick')).toEqual([{ kind: 'text', text: '**open and `tick' }]);
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }]);
  });

  test('underscores inside a word are not emphasis', () => {
    expect(parseInline('chat_turns and snake_case_name')).toEqual([
      { kind: 'text', text: 'chat_turns and snake_case_name' },
    ]);
  });

  test('a markdown link is text, never a link node', () => {
    expect(parseInline('[docs](https://example.com)')).toEqual([
      { kind: 'text', text: '[docs](https://example.com)' },
    ]);
  });
});

describe('parseBlocks', () => {
  test('a blank block is nothing', () => {
    expect(parseBlocks('  \n ')).toEqual([]);
  });

  test('a paragraph joins its lines with spaces', () => {
    expect(parseBlocks('one\ntwo')[0]).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'one two' }],
    });
  });

  test('bulleted lines are a bulleted list', () => {
    expect(parseBlocks('- a\n* **b**')[0]).toEqual({
      kind: 'bullets',
      items: [
        [{ kind: 'text', text: 'a' }],
        [{ kind: 'strong', children: [{ kind: 'text', text: 'b' }] }],
      ],
    });
  });

  test('numbered lines are a numbered list that keeps its start', () => {
    expect(parseBlocks('3. c\n4. d')[0]).toEqual({
      kind: 'numbered',
      start: 3,
      items: [[{ kind: 'text', text: 'c' }], [{ kind: 'text', text: 'd' }]],
    });
  });

  test('a sentence introducing a list is a paragraph followed by the list', () => {
    // The commonest way a model writes a list: no blank line after the lead-in.
    expect(parseBlocks('Here are two:\n- a\n- b')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'Here are two:' }] },
      { kind: 'bullets', items: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]] },
    ]);
  });

  test('prose after a list line keeps the whole block a paragraph', () => {
    expect(parseBlocks('- a\nthen prose').map((block) => block.kind)).toEqual(['paragraph']);
    expect(parseBlocks('Lead:\n- a\nmore prose').map((block) => block.kind)).toEqual(['paragraph']);
  });

  test('headings, quotes and fences pass through as text', () => {
    expect(parseBlocks('## Heading')[0]).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: '## Heading' }],
    });
    expect(parseBlocks('> quoted')[0]?.kind).toBe('paragraph');
  });
});
