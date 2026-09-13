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
 * Pull the selector list of the rule carrying `declaration` inside the given
 * block, as an array of trimmed, comma-split selector tokens. Selector-level,
 * not substring: this is what lets the guard test tell `[data-site-header]`
 * apart from a bare `header` even though the former contains the latter as a
 * substring.
 */
function selectorsCarrying(block: string, declaration: string): string[] {
  const ruleStart = block.indexOf(declaration);
  expect(ruleStart, `no "${declaration}" rule found in the print block`).toBeGreaterThan(-1);
  const openBrace = block.lastIndexOf('{', ruleStart);
  const selectorStart = block.lastIndexOf('}', openBrace) + 1;
  return block
    .slice(selectorStart, openBrace)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The chrome-hiding rule.
 */
const chromeHidingSelectors = (block: string) =>
  selectorsCarrying(block, 'display: none !important');

/**
 * The rule that overrides the --rl-* palette, identified by `--rl-bg:
 * #ffffff`, the print-only forced-light value.
 */
const paletteOverrideSelectors = (block: string) => selectorsCarrying(block, '--rl-bg: #ffffff');

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

  test('resets color-scheme, so the sheet itself is light and not just its ink', () => {
    // MEASURED (2026-09-13), printing /resume over CDP with
    // prefers-color-scheme: dark, JavaScript disabled and print media -- the
    // exact case the specificity note below exists for. The tokens won: black
    // ink on a white content area. The SHEET did not: `color-scheme: dark` was
    // still on :root from the no-JS block, Chrome paints the page canvas --
    // the margins, which body's own background box never covers -- from that
    // rather than from body's background-color, and browserRenderer passes
    // printBackground: true. Every one of the seven sheets came out framed in
    // a 0.6in black border. Re-printed after the fix, the frame is gone.
    // Overriding the palette is not enough on its own; the property that
    // decides the canvas has to be overridden with it.
    expect(tokensPrintBlock).toMatch(/color-scheme:\s*light/);
  });

  test('pins the blocks that invert to the light design, whatever the reader picked', () => {
    // The Now strip and the case-study masthead are filled with --rl-ink in
    // light and drop the inversion in dark (see tests/inverted-blocks.test.ts).
    // Paper is neither theme, and the print palette exists so the sheet does
    // not depend on what the reader chose -- so both blocks are pinned here to
    // the one design that was drawn, rather than being left to whichever
    // branch the reader's theme happens to select.
    //
    // MEASURED 2026-09-13, printing / over CDP with prefers-color-scheme:
    // dark: the Now strip came out a #1c1c1f bar carrying black text, 1.24:1.
    // The dark treatment sets `background-color: var(--rl-surface-raised)`,
    // and that is the one token the forced-light palette below does not
    // redeclare, so it stayed dark while the ink on it went black. Pinning
    // here rather than adding a token to the print palette, because the fix
    // belongs to the two blocks that invert and not to every raised surface
    // on the site.
    const pinned = selectorsCarrying(printBlock, 'background-color: var(--rl-ink)');
    expect(pinned).toContain('[data-now-strip]');
    expect(pinned).toContain("[data-masthead='case-study']");
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
