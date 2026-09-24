// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { parseBlock } from '../src/lib/chat/markdown';
import { appendBlock, type ChatSource } from '../src/lib/chat/render';

const SOURCES: ChatSource[] = [
  { n: 1, title: 'A post', url: 'https://ryanlindsey.me/writing/a', exact: true },
];

/** Renders each block in order into a fresh container, as the page does. */
function render(...blocks: string[]): HTMLElement {
  const container = document.createElement('div');
  for (const source of blocks) {
    const block = parseBlock(source);
    if (block) appendBlock(container, block, SOURCES);
  }
  return container;
}

/** The structural rules the spec calls valid HTML, checked on any output. */
function expectValid(container: HTMLElement): void {
  for (const li of container.querySelectorAll('li')) {
    expect(['UL', 'OL']).toContain(li.parentElement?.tagName);
  }
  for (const p of container.querySelectorAll('p')) {
    expect(p.querySelector('p, ul, ol, li, div')).toBeNull();
  }
  for (const el of container.querySelectorAll('*')) {
    expect(el.textContent, `empty <${el.tagName.toLowerCase()}>`).not.toBe('');
  }
}

describe('appendBlock', () => {
  test('a paragraph with emphasis and code is semantic', () => {
    const container = render('Plain **bold** *soft* `code`');
    expect(container.innerHTML).toBe(
      '<p>Plain <strong>bold</strong> <em>soft</em> <code class="font-mono text-small">code</code></p>',
    );
    expectValid(container);
  });

  test('a known citation is a link to its source and nothing else', () => {
    const link = render('As shown [1].').querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://ryanlindsey.me/writing/a');
    expect(link?.textContent).toBe('[1]');
  });

  test('an unknown citation stays text', () => {
    const container = render('As shown [9].');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('As shown [9].');
  });

  test('model-written HTML and links are text, never elements', () => {
    const container = render('<script>alert(1)</script> [docs](https://evil.example)');
    expect(container.querySelector('script, a')).toBeNull();
    expect(container.textContent).toBe('<script>alert(1)</script> [docs](https://evil.example)');
  });

  test('lists render as lists, and a numbered list keeps a start other than 1', () => {
    const container = render('- a\n- b', '4. d');
    expect(container.querySelector('ul')?.children).toHaveLength(2);
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('4');
    expectValid(container);
  });

  test('a numbered list starting at 1 carries no start attribute', () => {
    expect(render('1. a').querySelector('ol')?.hasAttribute('start')).toBe(false);
  });

  test('list items separated by blank lines are one list', () => {
    const container = render('1. a', '2. b');
    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expectValid(container);
  });

  test('a paragraph between two lists keeps them apart', () => {
    const container = render('- a', 'Then:', '- b');
    expect(container.querySelectorAll('ul')).toHaveLength(2);
  });

  test('returns what it added, so the caller can fade it in', () => {
    const container = document.createElement('div');
    const first = appendBlock(container, parseBlock('- a')!, SOURCES);
    expect(first.map((el) => el.tagName)).toEqual(['UL']);
    const merged = appendBlock(container, parseBlock('- b')!, SOURCES);
    expect(merged.map((el) => el.tagName)).toEqual(['LI']);
  });
});
