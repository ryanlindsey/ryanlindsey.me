import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
// The --rl-* palette override lives in tokens.css (tokens.css is the only
// file in the repo that declares a colour) -- global.css's own `@media
// print` block now only hides site chrome and adjusts layout.
const tokensCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

/**
 * Extract the full `@media print { ... }` block from the CSS source, brace
 * counting rather than stopping at the first `}` -- the block itself
 * contains several nested rule blocks, so a naive `indexOf('}', open)` (as
 * tests/tokens.test.ts's single-level `block()` helper does) would only
 * capture the first nested rule and silently drop the rest.
 *
 * ANCHORED ON THE AT-RULE, NOT ON THE STRING (fix round 2). This used to be
 * `source.indexOf('@media print')` followed by the next `{`, and in tokens.css
 * the first `@media print` in the file is inside the DOC COMMENT above the
 * block ("...lives in global.css's own `@media print` block"), not the at-rule
 * itself. It landed on the right block only because no `{` appears between
 * that sentence and the real rule -- one more character of prose away from
 * extracting the wrong thing, in a helper three assertions depend on. Comments
 * are stripped first and the match now has to be a real at-rule (`@media
 * print` followed by `{`), so neither accident is load-bearing any more.
 */
function extractMediaPrintBlock(source: string): string {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = /@media\s+print\s*\{/.exec(css);
  expect(match, '@media print block not found').not.toBeNull();
  const open = match!.index + match![0].length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
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

/**
 * Pull the selector list of the rule that overrides the --rl-* palette --
 * identified by `--rl-bg: #ffffff`, the print-only forced-light value -- as
 * an array of trimmed, comma-split selector tokens. Same technique as
 * chromeHidingSelectors above, anchored on a different declaration.
 */
function paletteOverrideSelectors(block: string): string[] {
  const ruleStart = block.indexOf('--rl-bg: #ffffff');
  expect(
    ruleStart,
    'no "--rl-bg: #ffffff" palette override found in the print block',
  ).toBeGreaterThan(-1);
  const openBrace = block.lastIndexOf('{', ruleStart);
  const selectorStart = block.lastIndexOf('}', openBrace) + 1;
  return block
    .slice(selectorStart, openBrace)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const printBlock = extractMediaPrintBlock(css);
const tokensPrintBlock = extractMediaPrintBlock(tokensCss);
const chromeSelectors = chromeHidingSelectors(printBlock);
const paletteSelectors = paletteOverrideSelectors(tokensPrintBlock);

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

  test('out-specifies the no-JS dark block so the light palette always wins', () => {
    // tokens.css declares the no-JS dark palette under
    // `:root:not([data-theme='light'])`, which is (0,2,0) because :not()
    // takes its argument's specificity -- higher than a bare `:root` or
    // `[data-theme='dark']` at (0,1,0), and media queries add no specificity
    // of their own. Without a matching (0,2,0) selector here, that block
    // wins the cascade regardless of source order, and a dark-OS visitor
    // with JS disabled prints the dark palette on white paper.
    expect(paletteSelectors).toContain(":root:not([data-theme='light'])");
  });
});
