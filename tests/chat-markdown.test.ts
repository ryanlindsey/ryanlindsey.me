import { describe, expect, test } from 'vitest';
import { parseBlock, parseInline } from '../src/lib/chat/markdown';

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

describe('parseBlock', () => {
  test('a blank block is nothing', () => {
    expect(parseBlock('  \n ')).toBeNull();
  });

  test('a paragraph joins its lines with spaces', () => {
    expect(parseBlock('one\ntwo')).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'one two' }],
    });
  });

  test('bulleted lines are a bulleted list', () => {
    expect(parseBlock('- a\n* **b**')).toEqual({
      kind: 'bullets',
      items: [
        [{ kind: 'text', text: 'a' }],
        [{ kind: 'strong', children: [{ kind: 'text', text: 'b' }] }],
      ],
    });
  });

  test('numbered lines are a numbered list that keeps its start', () => {
    expect(parseBlock('3. c\n4. d')).toEqual({
      kind: 'numbered',
      start: 3,
      items: [[{ kind: 'text', text: 'c' }], [{ kind: 'text', text: 'd' }]],
    });
  });

  test('a block mixing list and prose lines is a paragraph', () => {
    expect(parseBlock('Two things:\n- a')?.kind).toBe('paragraph');
  });

  test('headings, quotes and fences pass through as text', () => {
    expect(parseBlock('## Heading')).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: '## Heading' }],
    });
    expect(parseBlock('> quoted')?.kind).toBe('paragraph');
  });
});
