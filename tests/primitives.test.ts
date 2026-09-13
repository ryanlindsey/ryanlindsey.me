import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
const source = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** A named at-rule block's body, brace-counted. */
function ruleBody(head: RegExp): string {
  const match = head.exec(source);
  expect(match, `${head} not found`).not.toBeNull();
  const open = source.indexOf('{', match!.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block for ${head}`);
}

describe('the hairline grid', () => {
  // ruleBody() is called inside each test rather than once at describe-body
  // level: a describe callback runs eagerly during collection, so a throw
  // there (the missing-@utility case, at RED) aborts collection of the whole
  // file -- every other describe block below included -- rather than failing
  // just this one. Calling it per-test keeps a missing utility a failure of
  // these two cases only, so the focus and prose-rl cases can still run and
  // pass at RED as the brief predicts.
  test('is a 1px gap over a rule-coloured ground inside a rule border', () => {
    const grid = ruleBody(/@utility\s+hairline-grid\s*\{/);
    expect(grid).toMatch(/gap:\s*1px/);
    expect(grid).toMatch(/background(-color)?:\s*var\(--rl-rule\)/);
    expect(grid).toMatch(/border:\s*1px\s+solid\s+var\(--rl-rule\)/);
  });

  test('leaves the column count and the cell background to the caller', () => {
    // Column count follows item count (the figures contract's own rule), and
    // cells are --rl-surface on 1e but --rl-bg on 4a. A utility that decided
    // either would be wrong on half its call sites.
    const grid = ruleBody(/@utility\s+hairline-grid\s*\{/);
    expect(grid).not.toMatch(/grid-template-columns/);
    expect(grid).not.toMatch(/var\(--rl-surface\)|var\(--rl-bg\)/);
  });
});

describe('link rules', () => {
  test('underlines by default, at the design offset and thickness', () => {
    expect(source).toMatch(/text-underline-offset:\s*3px/);
    expect(source).toMatch(/text-decoration-thickness:\s*1px/);
  });

  test('never sets text-decoration: none on a bare anchor', () => {
    // The default must be underlined with explicit exceptions, not the
    // reverse. An `a { text-decoration: none }` base ships prose that does
    // not look linked the first time a page forgets to opt in.
    expect(source).not.toMatch(/^\s*a\s*\{[^}]*text-decoration:\s*none/m);
  });

  test('switches the underline on, which offset and thickness do not', () => {
    // Tailwind's preflight resets `a` to `text-decoration: inherit`, so an
    // anchor inherits `none` from body and the three declarations above
    // style an underline that never appears. The longhand is what makes
    // "underlined by default" true rather than aspirational.
    const base = /^\s*a\s*\{([^}]*)\}/m.exec(source);
    expect(base, 'no bare `a` base rule found').not.toBeNull();
    expect(base![1]).toMatch(/text-decoration-line:\s*underline/);
  });

  test('pressed is the green ramp, which is the one place green is not status', () => {
    expect(source).toMatch(/:active[^{]*\{[^}]*color:\s*var\(--rl-ok\)/);
  });

  test('hover changes no colour', () => {
    // The design is explicit: hover keeps the underline and does not recolour.
    // The pre-redesign chrome used `hover:text-accent` everywhere, so this is
    // a real regression guard rather than a restatement.
    const hover = source.match(/a:hover[^{]*\{([^}]*)\}/g) ?? [];
    for (const rule of hover) expect(rule).not.toMatch(/color:/);
  });
});

describe('the long-form measure', () => {
  test('prose-rl is 72ch, the fix for "sparse and overly narrow"', () => {
    expect(ruleBody(/@utility\s+prose-rl\s*\{/)).toMatch(/max-width:\s*72ch/);
  });
});

describe('focus', () => {
  test('is a square accent outline at 2px offset', () => {
    const focus = ruleBody(/:focus-visible\s*\{/);
    expect(focus).toMatch(/outline:\s*2px\s+solid\s+var\(--rl-accent\)/);
    expect(focus).toMatch(/outline-offset:\s*2px/);
    expect(focus).toMatch(/border-radius:\s*0/);
  });
});
