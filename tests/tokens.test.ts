import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
// Source, not build output: lightningcss sits between the two and would put
// an optimizer between this assertion and the thing it's asserting (see the
// day-2 `[data-theme='dark']` gate that got its quotes stripped by build and
// could never pass).
const globalCss = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

/**
 * Pull the `--rl-*` declarations out of one CSS block, located by a pattern
 * that opens it. Matched by regex rather than literal text because Prettier
 * normalises selector quote style, and a literal would break on reformat.
 */
function block(opener: RegExp): Record<string, string> {
  const start = css.search(opener);
  expect(start, `block not found: ${opener}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const end = css.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const line of css.slice(open + 1, end).split('\n')) {
    const m = line.match(/^\s*(--rl-[a-z0-9-]+)\s*:\s*([^;]+);/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const srgbToLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return (
    0.2126 * srgbToLinear((n >> 16) & 255) +
    0.7152 * srgbToLinear((n >> 8) & 255) +
    0.0722 * srgbToLinear(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// `:root` followed by whitespace-then-brace, so it cannot match the
// `:root:not([data-theme='light'])` selector inside the media query.
const light = block(/:root\s*\{/);
const dark = block(/\[data-theme=['"]dark['"]\]\s*\{/);
const noJsDark = block(/@media\s*\(prefers-color-scheme:\s*dark\)/);

// Text tokens must clear WCAG AA against their own theme's background.
const TEXT_TOKENS = [
  '--rl-ink',
  '--rl-ink-muted',
  '--rl-accent',
  '--rl-ok',
  '--rl-warn',
  '--rl-danger',
];

describe('token contrast', () => {
  test.each(TEXT_TOKENS)('%s clears 4.5:1 in light mode', (token) => {
    expect(contrast(light[token], light['--rl-bg'])).toBeGreaterThanOrEqual(4.5);
  });

  test.each(TEXT_TOKENS)('%s clears 4.5:1 in dark mode', (token) => {
    expect(contrast(dark[token], dark['--rl-bg'])).toBeGreaterThanOrEqual(4.5);
  });

  test('near-black on the pink OG ground clears 4.5:1', () => {
    expect(contrast(dark['--rl-accent-on'], dark['--rl-accent-ground'])).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

describe('theme parity', () => {
  test('light and dark declare exactly the same token names', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  // The dark palette is declared twice -- once for the explicit toggle, once for
  // the no-JS `prefers-color-scheme` path. Drift between them is invisible in
  // every normal session, so it is asserted mechanically instead.
  test('the no-JS dark block matches the [data-theme] dark block exactly', () => {
    expect(noJsDark).toEqual(dark);
  });
});

describe('colour ownership', () => {
  // Invariant: tokens.css is the only file in the repo that declares a
  // colour. Everywhere else -- including global.css's print block -- must
  // consume a --rl-* custom property rather than hardcoding a hex literal.
  test('global.css contains no hex colour literal', () => {
    expect(globalCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
