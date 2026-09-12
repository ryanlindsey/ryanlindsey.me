import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

/**
 * The `@theme inline` body with comments stripped. Anchored on the at-rule
 * followed by `{` rather than on the bare string, so a mention of
 * "@theme inline" in a doc comment cannot be matched instead -- the trap
 * tests/print.test.ts records having fallen into once already.
 */
function themeBlock(): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const match = /@theme\s+inline\s*\{/.exec(source);
  expect(match, '@theme inline block not found').not.toBeNull();
  const open = match!.index + match![0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced @theme inline block');
}

const theme = themeBlock();

function declared(name: string): string | undefined {
  const match = new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'm').exec(theme);
  return match?.[1].trim();
}

interface Step {
  name: string;
  size: string;
  lineHeight?: string;
  letterSpacing?: string;
  fontWeight?: string;
}

// The whole scale, in one table, in descending size order. A step added to
// global.css and not to this list fails the completeness test below, and a
// step in this list that global.css does not declare fails its own case --
// the two directions are checked separately so the failure names which.
const SCALE: Step[] = [
  {
    name: 'numeral',
    size: '11rem',
    lineHeight: '0.8',
    letterSpacing: '-0.055em',
    fontWeight: '600',
  },
  {
    name: 'display',
    size: '4.5rem',
    lineHeight: '0.95',
    letterSpacing: '-0.04em',
    fontWeight: '600',
  },
  {
    name: 'headline',
    size: '4rem',
    lineHeight: '0.98',
    letterSpacing: '-0.035em',
    fontWeight: '600',
  },
  { name: 'lead', size: '3.5rem', lineHeight: '1', letterSpacing: '-0.035em', fontWeight: '600' },
  { name: 'banner', size: '3rem', lineHeight: '1.1', letterSpacing: '-0.03em', fontWeight: '600' },
  {
    name: 'title',
    size: '2.75rem',
    lineHeight: '1.02',
    letterSpacing: '-0.03em',
    fontWeight: '600',
  },
  { name: 'figure', size: '2.25rem', lineHeight: '1', fontWeight: '600' },
  {
    name: 'section',
    size: '2rem',
    lineHeight: '1.15',
    letterSpacing: '-0.02em',
    fontWeight: '600',
  },
  {
    name: 'heading',
    size: '1.5rem',
    lineHeight: '1.2',
    letterSpacing: '-0.02em',
    fontWeight: '600',
  },
  { name: 'standfirst', size: '1.25rem', lineHeight: '1.5' },
  { name: 'large', size: '1.1875rem', lineHeight: '1.65' },
  {
    name: 'subheading',
    size: '1.125rem',
    lineHeight: '1.35',
    letterSpacing: '-0.01em',
    fontWeight: '600',
  },
  { name: 'body', size: '1.0625rem', lineHeight: '1.65' },
  { name: 'small', size: '0.875rem', lineHeight: '1.5' },
  { name: 'micro', size: '0.75rem', lineHeight: '1.4', letterSpacing: '0.06em' },
];

describe('type scale', () => {
  for (const step of SCALE) {
    test(`--text-${step.name} declares the values the redesign uses`, () => {
      expect(declared(`--text-${step.name}`)).toBe(step.size);
      expect(declared(`--text-${step.name}--line-height`)).toBe(step.lineHeight);
      expect(declared(`--text-${step.name}--letter-spacing`)).toBe(step.letterSpacing);
      expect(declared(`--text-${step.name}--font-weight`)).toBe(step.fontWeight);
    });
  }

  test('declares no step this list does not name', () => {
    // Equality, not a subset. An unlisted step is either a value that should
    // be in the table above or one of the four belonging to the unchosen
    // homepage options (1d, 1f), which this repo deliberately does not carry.
    const declaredNames = [...theme.matchAll(/^\s*--text-([\w-]+)\s*:/gm)]
      .map((match) => match[1])
      .filter((name) => !name.includes('--'));
    expect(declaredNames.sort()).toEqual(SCALE.map((step) => step.name).sort());
  });

  test('carries no step belonging to an unchosen homepage option', () => {
    // 1f's 8.5rem and 1.375rem, 1d's 5.5rem and 1.75rem. Named as sizes
    // rather than as token names because the failure mode is someone adding
    // them back under some other name.
    for (const size of ['8.5rem', '5.5rem', '1.75rem', '1.375rem']) {
      expect(theme, `${size} belongs to a homepage option that was not chosen`).not.toContain(
        `: ${size};`,
      );
    }
  });
});
