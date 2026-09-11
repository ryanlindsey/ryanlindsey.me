// The risk register's arithmetic (06 §2). PURE: a row and a clock in, a number
// of days out -- no bindings, no collection, no `new Date()` of its own, which
// is what lets both the page and tests/governance.test.ts agree about what
// "reviewed 100 days ago" means without either one owning the definition.
//
// The row type is declared HERE and the zod schema in src/content.config.ts
// mirrors it, rather than the other way round. The collection schema validates
// what is on disk; this is what the page and the test compute over, and a page
// that rendered staleness from a shape only Astro's loader could produce would
// be untestable without booting Astro.

/**
 * The likelihood scale, ordered from least to most likely.
 *
 * A FULL SCALE, of which the register uses three values today. Declared whole
 * because the alternative -- an enum over exactly the values in use -- makes
 * adding a row with an honest `rare` a schema change, which is pressure in the
 * wrong direction on a document whose failure mode is nobody wanting to touch
 * it. Order is load-bearing: `severityOf` below reads the index, so inserting a
 * value in the middle re-colours the table.
 */
export const LIKELIHOODS = ['rare', 'unlikely', 'possible', 'likely', 'almost-certain'] as const;

/** The impact scale, ordered from least to most severe. Same reasoning as `LIKELIHOODS`. */
export const IMPACTS = ['minor', 'moderate', 'major', 'severe'] as const;

export type Likelihood = (typeof LIKELIHOODS)[number];
export type Impact = (typeof IMPACTS)[number];

/** One row of `governance/risk-register.yaml`, after the collection schema has validated it. */
export interface RiskRow {
  id: string;
  risk: string;
  likelihood: Likelihood;
  impact: Impact;
  mitigation: string;
  owner: string;
  /** `YYYY-MM-DD`, pinned by the schema's regex so this module never parses a surprise. */
  lastReviewed: string;
}

/**
 * How long a row may go unreviewed before the page says so.
 *
 * A quarter, because that is the cadence a document like this is actually
 * re-read at; anything shorter makes every row permanently amber and the marker
 * stops meaning anything.
 */
export const REVIEW_MAX_AGE_DAYS = 90;

/**
 * Whole days between the row's review date and `now`.
 *
 * UTC MIDNIGHT ON BOTH SIDES, which is why the date is parsed rather than
 * constructed field by field: `Date.parse` on a date-only ISO string is
 * specified to be UTC, while `new Date(2026, 5, 1)` is local, and a page
 * prerendered in one zone and read in another would otherwise disagree with
 * this function by a day.
 *
 * Floored, so a review 100.9 days old reports 100. The renderer says "reviewed
 * N days ago", and rounding that up would claim an age the row has not reached.
 *
 * NEGATIVE IS POSSIBLE and is left alone: a row dated in the future is a typo,
 * and reporting it as `-3` on the page is more useful than clamping it to 0 and
 * showing a fresh row that never was.
 *
 * THE ROUND-TRIP CHECK IS FOR A DATE THAT IS SHAPED RIGHT AND IS NOT A DATE.
 * `isoDate` in src/content.config.ts pins the SHAPE -- four digits, a month in
 * 01-12, a day in 01-31 -- which is not the same as pinning a day that exists.
 * MEASURED rather than assumed, because the obvious worry turns out to be the
 * wrong one: every form that makes `Date.parse` return NaN (`2026-13-01`,
 * `2026-01-32`, `2026-00-10`) is already rejected by that regex, so NaN cannot
 * reach here through the collection. What DOES get through is the rollover
 * class -- `2026-02-31` parses cleanly to 2026-03-03 and `2026-04-31` to
 * 2026-05-01 -- and it fails in the worse direction: a typo silently reads as a
 * LATER date, so the row renders fresher than it is and the staleness marker
 * this whole module exists to drive is the thing that gets suppressed.
 *
 * Comparing the parsed value back against the string catches both classes with
 * one check. THROWN rather than rendered around: this runs at build time on a
 * prerendered page, so a bad date fails the build with the row's id in the
 * message, which is where a typo in a dated attestation should surface.
 */
export function reviewAgeDays(row: RiskRow, now: Date): number {
  const reviewed = Date.parse(row.lastReviewed);
  if (
    Number.isNaN(reviewed) ||
    new Date(reviewed).toISOString().slice(0, 10) !== row.lastReviewed
  ) {
    throw new Error(
      `risk-register: ${row.id} has a lastReviewed that is not a real date: ${row.lastReviewed}`,
    );
  }
  return Math.floor((now.getTime() - reviewed) / 86_400_000);
}

/** Whether the page should mark this row as overdue for review. */
export function isStale(row: RiskRow, now: Date): boolean {
  return reviewAgeDays(row, now) > REVIEW_MAX_AGE_DAYS;
}

/**
 * Which of the three token colours a scale value gets, as a fraction of the
 * scale rather than as a hand-written map.
 *
 * Derived so the two scales cannot be coloured inconsistently: the bottom
 * third is `ok`, the top third `danger`, the middle `warn`. With five
 * likelihoods and four impacts that yields rare/unlikely -> ok,
 * possible -> warn, likely/almost-certain -> danger; minor -> ok,
 * moderate -> warn, major/severe -> danger.
 */
export function severityOf(value: Likelihood | Impact): 'ok' | 'warn' | 'danger' {
  const scale: readonly string[] = (LIKELIHOODS as readonly string[]).includes(value)
    ? LIKELIHOODS
    : IMPACTS;
  const position = scale.indexOf(value) / (scale.length - 1);
  if (position < 1 / 3) return 'ok';
  if (position < 2 / 3) return 'warn';
  return 'danger';
}
