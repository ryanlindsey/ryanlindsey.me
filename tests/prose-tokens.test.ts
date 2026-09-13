import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/*
 * BUILD OUTPUT, NOT SOURCE, and that is the whole point of this file.
 *
 * tests/print.test.ts reads src/styles/global.css and explains why: lightningcss
 * sits between source and output, so a source assertion is the one that cannot
 * be fooled by the optimiser. The defect this file guards is the opposite
 * shape. The source was always right -- `prose-rl` declared every `--tw-prose-*`
 * mapping it was supposed to -- and the build is where it was lost, because
 * Tailwind emitted `.prose-rl` before Typography's `.prose` and the two are
 * the same specificity in the same layer. Nothing readable in global.css says
 * which one wins. Only the compiled sheet does.
 *
 * MEASURED 2026-09-13 in the sheet this reads: `.prose-rl`'s
 * `--tw-prose-body: var(--rl-ink)` was emitted at byte 12284 and Typography's
 * gray-700 default at byte 22919, so every article and the AI policy page
 * rendered Tailwind's palette rather than this site's. On the light background
 * that clears 8.02:1 and merely looked wrong -- prose links and inline code
 * came out near-black instead of accent. In dark the same values land on the
 * near-black page at 2.36:1 body and 2.42:1 headings, links and code, which is
 * where a reader hit it.
 */
const dir = new URL('../dist/client/_astro/', import.meta.url).pathname;

const shellCss = (() => {
  const files = readdirSync(dir).filter((f) => f.startsWith('Shell.') && f.endsWith('.css'));
  expect(files.length, `expected one built Shell stylesheet in ${dir}, found ${files.length}`).toBe(
    1,
  );
  return readFileSync(dir + files[0], 'utf8');
})();

/**
 * The selectors carrying a given declaration in the compiled sheet, as written.
 * Compiled CSS is minified onto one line, so this walks back from the
 * declaration to the brace that opens its rule.
 */
function selectorsDeclaring(css: string, declaration: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(declaration, from);
    if (at === -1) return out;
    const open = css.lastIndexOf('{', at);
    const prev = Math.max(css.lastIndexOf('}', open), css.lastIndexOf('{', open - 1));
    out.push(css.slice(prev + 1, open).trim());
    from = at + declaration.length;
  }
}

describe('prose token mapping survives the build', () => {
  test('the --rl-* mapping is emitted at a selector that out-specifies .prose', () => {
    // `.prose-rl.prose` is (0,2,0) against Typography's (0,1,0), so it wins on
    // specificity and stops depending on which one Tailwind happens to sort
    // later. A bare `.prose-rl` here is the regression: it is the selector
    // that shipped, and it loses.
    const selectors = selectorsDeclaring(shellCss, '--tw-prose-body:var(--rl-ink)');
    expect(selectors.length, 'the --rl-ink body mapping is not in the built sheet').toBe(1);
    expect(selectors[0]).toBe('.prose-rl.prose');
  });

  test('the measure is the redesign’s 72ch, not Typography’s 65ch', () => {
    // Same mechanism, same fix, different property. This one is invisible
    // below about 1300px because the spine's centre column is narrower than
    // either value until then, which is why it went unnoticed with the colours.
    const selectors = selectorsDeclaring(shellCss, 'max-width:72ch');
    expect(selectors).toContain('.prose-rl.prose');
  });

  test('every mapped prose variable resolves to a token, never to a literal', () => {
    // The mapping block must name --rl-* custom properties throughout. A hex
    // or an oklch() landing here would mean a declaration had been written
    // against the palette rather than through it, which is the invariant
    // tests/tokens.test.ts holds for global.css as a whole.
    const at = shellCss.indexOf('.prose-rl.prose{');
    expect(at, 'no .prose-rl.prose rule in the built sheet').toBeGreaterThan(-1);
    const body = shellCss.slice(at + '.prose-rl.prose{'.length, shellCss.indexOf('}', at));
    const mappings = body.split(';').filter((d) => d.startsWith('--tw-prose-'));
    expect(mappings.length).toBeGreaterThanOrEqual(14);
    for (const decl of mappings) {
      expect(decl, `not a token reference: ${decl}`).toMatch(/:var\(--rl-[a-z-]+\)$/);
    }
  });
});
