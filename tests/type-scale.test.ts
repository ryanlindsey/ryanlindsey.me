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
  /**
   * The value the handoff specifies, which is a desktop value at 1280px. For a
   * clamped step this is the clamp's MAX, so every approved design still
   * renders at exactly this size on the viewports that were designed.
   */
  size: string;
  /**
   * Present iff the step clamps (issue #113). The value it holds at 390px and
   * below. A step without one is a single number and is asserted as one.
   */
  min?: string;
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
    min: '5rem',
    lineHeight: '0.8',
    letterSpacing: '-0.055em',
    fontWeight: '600',
  },
  {
    name: 'display',
    size: '4.5rem',
    min: '2.5rem',
    lineHeight: '0.95',
    letterSpacing: '-0.04em',
    fontWeight: '600',
  },
  {
    name: 'headline',
    size: '4rem',
    min: '2.375rem',
    lineHeight: '0.98',
    letterSpacing: '-0.035em',
    fontWeight: '600',
  },
  {
    name: 'lead',
    size: '3.5rem',
    min: '2.25rem',
    lineHeight: '1',
    letterSpacing: '-0.035em',
    fontWeight: '600',
  },
  {
    name: 'banner',
    size: '3rem',
    min: '2.125rem',
    lineHeight: '1.1',
    letterSpacing: '-0.03em',
    fontWeight: '600',
  },
  {
    name: 'title',
    size: '2.75rem',
    min: '2rem',
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

/**
 * A clamped step, split into its three parts.
 *
 * Deliberately strict about the shape rather than just looking for the word
 * `clamp`: a test that only asserted a step "contains clamp" would pass for a
 * clamp with the wrong desktop value, and the desktop value is the one thing
 * here that must not drift -- every design in the handoff was drawn at 1280px.
 */
function clampParts(value: string): { min: string; preferred: string; max: string } | null {
  const match = /^clamp\(([^,]+),(.+),([^,]+)\)$/.exec(value);
  if (!match) return null;
  return { min: match[1].trim(), preferred: match[2].trim(), max: match[3].trim() };
}

/**
 * A `<rem> + <vw>` preferred value in pixels at a given viewport width, at the
 * 16px root this site never changes. This is what makes the two ends checkable
 * rather than merely declared: a clamp whose ramp misses its own max at 1280px
 * would still parse, and would quietly render every approved design at a size
 * nobody chose.
 */
function preferredPx(preferred: string, viewportPx: number): number {
  const match = /^([\d.]+)rem\s*\+\s*([\d.]+)vw$/.exec(preferred);
  expect(match, `cannot evaluate preferred value \`${preferred}\``).not.toBeNull();
  return Number(match![1]) * 16 + (Number(match![2]) / 100) * viewportPx;
}

const remPx = (value: string) => Number(/^([\d.]+)rem$/.exec(value)![1]) * 16;

// The two ends the ramp is built between. 390px is the handoff's only final
// mobile view (design 1c) and 1280px is the width every other design was drawn
// at, so these are the widths the values were chosen against rather than round
// numbers.
const MOBILE_PX = 390;
const DESKTOP_PX = 1280;

describe('type scale', () => {
  for (const step of SCALE) {
    test(`--text-${step.name} declares the values the redesign uses`, () => {
      const value = declared(`--text-${step.name}`);
      if (step.min) {
        const parts = clampParts(value ?? '');
        expect(parts, `--text-${step.name} should clamp (issue #113)`).not.toBeNull();
        expect(parts!.min).toBe(step.min);
        // The handoff's value, unchanged, at the top of the ramp.
        expect(parts!.max).toBe(step.size);
      } else {
        expect(value).toBe(step.size);
      }
      expect(declared(`--text-${step.name}--line-height`)).toBe(step.lineHeight);
      expect(declared(`--text-${step.name}--letter-spacing`)).toBe(step.letterSpacing);
      expect(declared(`--text-${step.name}--font-weight`)).toBe(step.fontWeight);
    });
  }

  for (const step of SCALE.filter((candidate) => candidate.min)) {
    test(`--text-${step.name} actually reaches both ends of its ramp`, () => {
      const parts = clampParts(declared(`--text-${step.name}`) ?? '');
      expect(parts, `--text-${step.name} should clamp`).not.toBeNull();
      // Half a pixel, which is below what a reader could see and well inside
      // the rounding the published coefficients carry.
      expect(preferredPx(parts!.preferred, DESKTOP_PX)).toBeCloseTo(remPx(step.size), 0);
      expect(preferredPx(parts!.preferred, MOBILE_PX)).toBeCloseTo(remPx(step.min!), 0);
    });
  }

  test('clamps the six display steps and leaves the rest alone', () => {
    // Equality, so this fails in both directions: a seventh step quietly made
    // fluid, and one of these six quietly made fixed again. `figure` (2.25rem)
    // and `section` (2rem) are deliberately not here -- 36px and 32px already
    // read at 390px, and a step that does not need to move should not be made
    // harder to read for nothing.
    const clamped = SCALE.filter((step) => clampParts(declared(`--text-${step.name}`) ?? ''))
      .map((step) => step.name)
      .sort();
    expect(clamped).toEqual(['banner', 'display', 'headline', 'lead', 'numeral', 'title']);
  });

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
    //
    // MATCHED ANYWHERE IN THE BLOCK, not as `: <size>;`. That spelling stopped
    // being able to fail once issue #113 made six steps `clamp(min, ramp, max)`:
    // no clamped step's size is written as a bare declaration any more, so a
    // banned value reintroduced as a clamp bound would have sailed past it.
    for (const size of ['8.5rem', '5.5rem', '1.75rem', '1.375rem']) {
      expect(theme, `${size} belongs to a homepage option that was not chosen`).not.toMatch(
        new RegExp(`(?<![\\d.])${size.replace('.', '\\.')}`),
      );
    }
  });
});
