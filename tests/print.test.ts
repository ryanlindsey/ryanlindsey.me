import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

/**
 * Extract the full `@media print { ... }` block from the CSS source, brace
 * counting rather than stopping at the first `}` -- the block itself
 * contains several nested rule blocks, so a naive `indexOf('}', open)` (as
 * tests/tokens.test.ts's single-level `block()` helper does) would only
 * capture the first nested rule and silently drop the rest.
 */
function extractMediaPrintBlock(source: string): string {
  const start = source.indexOf('@media print');
  expect(start, '@media print block not found').toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced @media print block');
}

/**
 * Pull the selector list of the rule that carries `display: none !important`
 * inside the given block -- i.e. the chrome-hiding rule -- as an array of
 * trimmed, comma-split selector tokens. Selector-level, not substring: this
 * is what lets the guard test tell `[data-site-header]` apart from a bare
 * `header` even though the former contains the latter as a substring.
 */
function chromeHidingSelectors(block: string): string[] {
  const ruleStart = block.indexOf('display: none !important');
  expect(ruleStart, 'no "display: none !important" rule found in the print block').toBeGreaterThan(
    -1,
  );
  const openBrace = block.lastIndexOf('{', ruleStart);
  const selectorStart = block.lastIndexOf('}', openBrace) + 1;
  return block
    .slice(selectorStart, openBrace)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const printBlock = extractMediaPrintBlock(css);
const chromeSelectors = chromeHidingSelectors(printBlock);

describe('print rules', () => {
  test('hides site chrome via data attributes', () => {
    // A page-level header (e.g. ArticleLayout's own title block) must not be
    // caught by this list -- only the components carrying these attributes
    // (SiteHeader, SiteFooter) are shared chrome.
    expect(chromeSelectors).toContain('[data-site-header]');
    expect(chromeSelectors).toContain('[data-site-footer]');
  });

  test('never hides header or footer by bare element selector', () => {
    // Regression guard: an earlier version of this rule read `header, footer,
    // nav, ...` and, because global.css is the shared Shell stylesheet rather
    // than one scoped to /resume, silently hid an article's own <header>
    // (its title, description and reading time) along with the site chrome.
    // Checked as exact selector tokens, not a substring test -- `header` is a
    // substring of `[data-site-header]`, so a naive `.not.toContain('header')`
    // would report success while still failing to catch a reverted selector.
    expect(chromeSelectors).not.toContain('header');
    expect(chromeSelectors).not.toContain('footer');
  });
});
