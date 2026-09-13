import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const globalCss = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../src/layouts/ArticleLayout.astro', import.meta.url), 'utf8');

/*
 * The blocks this redesign fills with --rl-ink and then has to un-fill in
 * dark, because --rl-ink is the near-white end of the ramp there and a large
 * near-white panel reads as glare rather than as emphasis.
 *
 * MEASURED 2026-09-13 over CDP at 1280px, in all three theme states, by
 * walking every element on every page and collecting the ones whose computed
 * background or border resolved to --rl-ink. Two of them are filled:
 *
 *   - the home page's Now strip, 1280x56, resolved when it was built;
 *   - the case-study masthead, 1280x456, which was left rendering the tokens
 *     mechanically for this pass to look at, and does read as glare.
 *
 * The writing index's active filter chip is the third filled block and is
 * deliberately NOT here: at 62x29 the inversion is what makes it read as
 * selected, and it was checked in dark rather than assumed. Everything else
 * that touches --rl-ink does so as a border, which flips correctly on its own.
 */
const DE_INVERTED = ['[data-now-strip]', "[data-masthead='case-study']"];

const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('blocks that drop their inversion in dark', () => {
  test.each(DE_INVERTED)('%s has a no-JS dark rule, not only a dark: variant', (hook) => {
    // `dark:` is bound to [data-theme='dark'], which only a visitor running
    // JavaScript ever receives -- the head script writes it. A visitor with
    // JavaScript disabled on a dark OS gets dark TOKENS from tokens.css's
    // prefers-color-scheme block and never gets the attribute, so the utility
    // alone leaves them on the near-white panel the variant exists to avoid.
    // Guarded with :not([data-theme='light']) so an explicit light choice
    // still wins, exactly as tokens.css guards its own no-JS block.
    const twin = new RegExp(`:root:not\\(\\[data-theme='light'\\]\\)\\s+${escapeForRegex(hook)}`);
    expect(globalCss).toMatch(twin);
  });

  test('every dark-path rule in global.css is scoped to screen', () => {
    // A no-JS twin is (0,3,0) and the print rule that has to take the block
    // back to the drawn design is (0,1,0). Both are unlayered, so source order
    // cannot settle it: without `screen` the dark treatment follows the reader
    // onto paper and the print block cannot win. MEASURED 2026-09-13,
    // printing / over CDP with prefers-color-scheme: dark: the Now strip
    // printed as a #1c1c1f bar carrying black text, because the print palette
    // has no --rl-surface-raised to forced-light. Scoping to `screen` is what
    // keeps the fix on the fix's own medium; tests/print.test.ts asserts the
    // other half.
    const darkAtRules = [...globalCss.matchAll(/@media([^{]*)\(prefers-color-scheme:\s*dark\)/g)];
    expect(darkAtRules.length, 'no dark-path rule found in global.css').toBeGreaterThan(0);
    for (const rule of darkAtRules) {
      expect(
        rule[1],
        `unscoped dark at-rule: @media${rule[1]}(prefers-color-scheme: dark)`,
      ).toMatch(/\bscreen\b/);
    }
  });

  test('the case-study masthead declares its dark treatment beside its light one', () => {
    // The whole class string is what Tailwind scans, so the variant has to
    // live in the same literal as the thing it overrides rather than being
    // assembled. Asserted on the shell because title and standfirst inherit
    // from it: one place declares the inversion and one place drops it.
    const shell = /shell:\s*'([^']*bg-ink[^']*)'/.exec(layout);
    expect(shell, 'no bg-ink masthead shell found in ArticleLayout').not.toBeNull();
    expect(shell![1]).toContain('dark:bg-surface-raised');
    expect(shell![1]).toContain('dark:text-ink');
  });
});
