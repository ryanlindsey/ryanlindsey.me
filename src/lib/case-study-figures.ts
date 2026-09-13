import { z } from 'astro/zod';
import { FIGURE_MAX, FIGURE_MIN, UNREADABLE_LABEL, UNREADABLE_VALUE } from './figures.mjs';

/**
 * The 2x2 figure block on a /work index row (design 1i, issue #106).
 *
 * A MODULE RATHER THAN THREE INLINE EXPRESSIONS IN content.config.ts AND THE
 * PAGE, for two reasons that are worth separating:
 *
 * 1. The schema has to be reachable from a plain Vitest run, and
 *    `src/content.config.ts` is not: it imports `astro:content`, a virtual
 *    module only the Astro pipeline provides, so `await import()`-ing that
 *    file from a test fails on resolution before any assertion runs.
 *    MEASURED, not assumed (2026-09-13) -- the issue's own draft of the cap
 *    test did exactly that and could never have executed. The schema lives
 *    here, content.config.ts consumes it, and tests/case-study-figures.test.ts
 *    parses the real thing.
 * 2. The rendered block has no page to be asserted on yet. Neither published
 *    case study declares figures, and the one entry that does is a draft that
 *    every index filters out, so the decisions below would otherwise ship
 *    untested until content arrived. Here they are called with real input.
 *
 * Nothing here is exported to `.md`, `/llms.txt` or the feeds, deliberately --
 * see the `figures` note in `frontmatterFor` (src/lib/markdown-export.ts) for
 * why, which is also where to look if that ever needs to change.
 */

/** One value/label pair, after the unreadable convention has been applied. */
export interface FigureCell {
  /** Ready to render: the declared value, or the word for an unreadable one. */
  value: string;
  label: string;
  /**
   * Whether `value` is an actual figure, and therefore whether the rendered
   * element carries `data-numeric` (global.css turns that into tabular
   * figures). Off for an unreadable value: "unavailable" is a word, and
   * tabular figures on a word are noise. Same split OpsMetric.astro makes.
   */
  numeric: boolean;
}

/**
 * The frontmatter shape, and the whole reason it is this shape: it is the
 * `value — label` pair the `:::figures` directive already uses in article
 * bodies, so an author writes one thing in two places rather than two things.
 *
 * Optional, on the logic content.config.ts already applies to
 * `orgScale`/`domain`/`outcomes`: the template ships before the content that
 * fills it, and a required field would either block the page or invite a
 * placeholder. An entry that omits it renders no block at all and its row's
 * left column takes the full width -- never an empty cell.
 *
 * `FIGURE_MIN`/`FIGURE_MAX` come from src/lib/figures.mjs rather than being
 * retyped as 2 and 4, so the fence and the frontmatter cannot disagree about
 * what counts as a figure row.
 *
 * `.min(1)` ON BOTH STRINGS IS NOT DECORATION. The directive has no way to
 * express a blank value -- `splitItem` requires a separator, and an unreadable
 * figure is written as the em dash -- so blankness is unrepresentable there
 * and has to be refused here, or `value: ""` reaches the page as a cell with
 * nothing in it. That is the one shape the "never an empty cell" contract
 * fails as, and a build error at authoring time is a cheaper place to catch it
 * than a rendered row nobody re-reads.
 */
export const caseStudyFiguresSchema = z
  .array(z.object({ value: z.string().min(1), label: z.string().min(1) }))
  .min(FIGURE_MIN)
  .max(FIGURE_MAX)
  .optional();

export type CaseStudyFigures = z.infer<typeof caseStudyFiguresSchema>;

/** The cells to render, which is none at all when the entry declares none. */
export function figureCellsFor(figures: CaseStudyFigures): FigureCell[] {
  return (figures ?? []).map(({ value, label }) => {
    const readable = value !== UNREADABLE_VALUE;
    return { value: readable ? value : UNREADABLE_LABEL, label, numeric: readable };
  });
}

/**
 * How many columns that many cells take.
 *
 * Four is the design's 2x2 and is why this function exists at all; everything
 * else follows the item count, which is the rule the figures contract states
 * for itself. Deliberately NOT the `.rl-figures[data-figures='4']` rule in
 * global.css, which lays four out in a single row: that is right for a figure
 * block spanning a prose column and wrong for one in the narrow right-hand
 * column of an index row.
 *
 * The reason a hole is unacceptable rather than merely untidy: `hairline-grid`
 * paints the gaps by showing a rule-coloured ground through them, so an unused
 * slot is not blank space, it is a visibly empty bordered cell.
 */
export function figureColumns(count: number): number {
  return count === FIGURE_MAX ? 2 : count;
}
