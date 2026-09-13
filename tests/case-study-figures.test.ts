import { describe, expect, test } from 'vitest';
import {
  caseStudyFiguresSchema,
  figureCellsFor,
  figureColumns,
} from '../src/lib/case-study-figures';
import { FIGURE_MAX, FIGURE_MIN, UNREADABLE_LABEL, UNREADABLE_VALUE } from '../src/lib/figures.mjs';

/**
 * The figure block on a /work index row (design 1i, issue #106).
 *
 * THIS SUITE EXISTS BECAUSE THE RENDERED BLOCK CANNOT BE ASSERTED ON THE PAGE
 * TODAY, and that is worth stating rather than discovering. Neither published
 * case study declares `figures` -- issue #106 is explicit that inventing
 * numbers for real work is not its job -- and the one entry that does declare
 * a set is `shape-specimen`, a draft, which every aggregation surface on this
 * site filters out by design. So `/work` currently renders no figure block at
 * all, and a test that scraped the page for one would pass by finding nothing.
 *
 * The issue's own draft of that test conceded the point with an early
 * `return`, which is the shape tests/case-studies.test.ts already refuses in
 * as many words: "a suite that silently checks nothing reports that nobody
 * minds it having asked nothing." So the decisions moved here, where they can
 * be called with real input, and tests/pages.test.ts asserts the page-level
 * half off disk -- which turns live the day a published case study declares a
 * set, with nobody having to remember this file.
 */

const figure = (value: string, label: string) => ({ value, label });

describe('the schema', () => {
  test(`caps a block at ${FIGURE_MAX}, because the design is a 2x2`, () => {
    // Five is a table, not a figure row -- the same rule src/lib/figures.mjs
    // states for the :::figures directive, read from the same constant so the
    // authored body and the frontmatter cannot drift apart on it.
    const five = Array.from({ length: FIGURE_MAX + 1 }, () => figure('1', 'x'));
    expect(() => caseStudyFiguresSchema.parse(five)).toThrow();
    expect(() => caseStudyFiguresSchema.parse(five.slice(0, FIGURE_MAX))).not.toThrow();
  });

  test(`refuses a block of fewer than ${FIGURE_MIN}, because one figure is a sentence`, () => {
    expect(() => caseStudyFiguresSchema.parse([figure('1', 'x')])).toThrow();
    expect(() => caseStudyFiguresSchema.parse([])).toThrow();
  });

  test('refuses an empty value or an empty label, rather than rendering an empty cell', () => {
    // The contract issue #106 states for the absent case ("never an empty
    // cell") applied to the declared one. An author who has no figure to put
    // here omits the block or writes the unreadable mark; a blank string is
    // neither, and it reaches the page as a cell with nothing in it.
    expect(() => caseStudyFiguresSchema.parse([figure('', 'Runs'), figure('2', 'x')])).toThrow();
    expect(() => caseStudyFiguresSchema.parse([figure('12', ''), figure('2', 'x')])).toThrow();
  });

  test('is optional, so a case study that declares nothing still parses', () => {
    expect(caseStudyFiguresSchema.parse(undefined)).toBeUndefined();
  });
});

describe('figureCellsFor', () => {
  test('renders no cells at all when the entry declares none', () => {
    // Not one empty cell, not a placeholder row: nothing, so the row's left
    // column takes the full width.
    expect(figureCellsFor(undefined)).toEqual([]);
  });

  test('carries a declared value through and marks it as a number', () => {
    const cells = figureCellsFor([figure('84%', 'Forecast accuracy'), figure('12', 'Teams')]);
    expect(cells).toEqual([
      { value: '84%', label: 'Forecast accuracy', numeric: true },
      { value: '12', label: 'Teams', numeric: true },
    ]);
  });

  test('says a figure is unavailable rather than rendering the bare mark', () => {
    // The directive's own convention (src/lib/figures.mjs, constraint 3): an
    // em dash in the value position is the authored spelling of "this could
    // not be read". The index has to say the same word the article says, or
    // one surface quietly shows a dash where the other shows a state.
    //
    // `numeric` goes off with it, matching OpsMetric.astro's absent arm --
    // "unavailable" is a word, not a number, and tabular figures on a word
    // are noise.
    const [cell] = figureCellsFor([figure(UNREADABLE_VALUE, 'Alerts fired'), figure('2', 'x')]);
    expect(cell).toEqual({ value: UNREADABLE_LABEL, label: 'Alerts fired', numeric: false });
  });
});

describe('figureColumns', () => {
  test('lays four figures out two by two, which is the design', () => {
    expect(figureColumns(4)).toBe(2);
  });

  test('never leaves a hole, so the column count follows the item count otherwise', () => {
    // A three-item block in two columns leaves the fourth slot showing the
    // grid's rule-coloured ground -- a visible empty cell, which is the one
    // thing this block must never render.
    expect(figureColumns(2)).toBe(2);
    expect(figureColumns(3)).toBe(3);
  });
});
