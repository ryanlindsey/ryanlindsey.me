/**
 * The Now strip's one piece of inline markup: a markdown link inside an item.
 *
 * Items are plain strings in src/content/now/now.yaml, and the home page
 * renders them as text. A link is written the way the markdown export at
 * /index.md already prints the item, so the YAML, the page and that document
 * read the same clause.
 */
import { expect, test } from 'vitest';
import { splitNowItem } from '../src/lib/now-links';

test('an item with no link is one text segment', () => {
  expect(splitNowItem('Tuning the evals that grade this site’s agents')).toEqual([
    { text: 'Tuning the evals that grade this site’s agents' },
  ]);
});

test('a markdown link becomes a link segment between its text segments', () => {
  expect(
    splitNowItem('Showing how to connect an MCP client at [/connect](/connect) today'),
  ).toEqual([
    { text: 'Showing how to connect an MCP client at ' },
    { text: '/connect', href: '/connect' },
    { text: ' today' },
  ]);
});

test('a link at the end leaves no empty trailing segment', () => {
  expect(splitNowItem('See [the page](/connect)')).toEqual([
    { text: 'See ' },
    { text: 'the page', href: '/connect' },
  ]);
});

test('brackets that are not a complete link stay as text', () => {
  expect(splitNowItem('A [bracketed] aside (with parens)')).toEqual([
    { text: 'A [bracketed] aside (with parens)' },
  ]);
});
