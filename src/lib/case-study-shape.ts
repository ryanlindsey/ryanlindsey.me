// 02 §4 fixes the case-study shape: Context, Constraint, Intervention,
// Mechanism, Outcome, What I'd do differently. A plan document cannot enforce
// itself, so the list lives here and tests/case-studies.test.ts asserts every
// rendered case study carries exactly these six <h2>s in this order.
//
// Deliberately not a schema field. The shape lives in the body and a collection
// schema only sees frontmatter, so Zod cannot reach it. Checking the rendered
// page is the stronger test anyway: it asserts what a reader receives rather
// than what an author wrote in a file.
export const CASE_STUDY_SECTIONS = [
  'Context',
  'Constraint',
  'Intervention',
  'Mechanism',
  'Outcome',
  "What I'd do differently",
] as const;

// --- 1j's facts bar (issue #107, epic #96) -------------------------------
//
// The four cells under the inverted masthead. This module already exists to
// hold the list the shape test and any future UI both read from, which makes
// it the right home for the two rules below -- a ternary buried in
// ArticleLayout.astro would be neither.
//
// Everything here is a pure function of plain fields, never of a
// CollectionEntry, for the reason src/lib/case-study-figures.ts records at
// length: importing src/content.config.ts from a test fails on `astro:content`
// before any assertion runs, so a rule that can only be reached through a
// rendered page is a rule whose edge cases never get tested.

/** One rendered cell of the facts bar. */
export interface CaseStudyFact {
  label: string;
  value: string;
  /**
   * The value's colour class, when the cell has one. Only Status does.
   *
   * Carried on the cell rather than decided in the template, so ArticleLayout
   * never has to match on a label string to work out which cell is the status
   * -- a comparison that would keep working right up until a label was
   * reworded.
   */
  valueClass?: string;
}

/** The four flat scalars content.config.ts declares, all optional. */
export interface CaseStudyFactFields {
  role?: string;
  stack?: string;
  model?: string;
  status?: string;
}

/**
 * The status ramp, spelled as whole class strings.
 *
 * Tailwind scans source text for complete class names, so a computed
 * `text-${tone}` would be scanned as nothing and ship unstyled. Same map, same
 * reason, as `SEVERITY_CLASS` in src/pages/ai-policy.astro.
 */
const STATUS_LIVE = 'text-ok';
const STATUS_OTHER = 'text-ink';

/**
 * `--rl-ok` when the status reads as live, `--rl-ink` otherwise.
 *
 * A CASE-INSENSITIVE MATCH ON THE WHOLE TRIMMED VALUE, not a substring test,
 * and "Delivered" is the case that decides it: it contains "live", so a
 * substring match would paint a finished, handed-off project with the live
 * ramp. That failure is invisible until a reader believes a dead thing is
 * still running.
 *
 * Colouring every status green would make `--rl-ok` decorative, which is the
 * thing tokens.css's header is protecting when it says green is the
 * success/live ramp and never a brand colour. A status this rule renders in
 * ink is not a status that is wrong -- the value is content and the colour is
 * a presentation rule, which is also why content.config.ts keeps `status` a
 * plain string rather than an enum.
 */
export function statusClass(status: string | undefined): string {
  return status?.trim().toLowerCase() === 'live' ? STATUS_LIVE : STATUS_OTHER;
}

/**
 * The cells to render, which is none at all when the entry declares none.
 *
 * ORDER IS THE DESIGN'S, NOT THE FRONTMATTER'S: 1j reads Role / Stack / Model
 * / Status left to right, and an author reordering four keys in a YAML block
 * should not reorder the bar.
 *
 * A BLANK VALUE IS DROPPED, not rendered. `role: ""` is a declaration, so
 * `frontmatterFor` keeps it in the export -- dropping it there is the
 * documented fix round in src/lib/markdown-export.ts, where absence has to
 * keep meaning "never declared." The bar is the opposite case: a label over
 * nothing is exactly the empty cell the figures contract forbids and /ops has
 * refused since launch, so here the cell goes and the row divides among what
 * is left. The two layers disagree on purpose.
 */
export function factsFor(fields: CaseStudyFactFields): CaseStudyFact[] {
  return [
    cell('Role', fields.role),
    cell('Stack', fields.stack),
    cell('Model', fields.model),
    // The only cell with a colour, and it is named here rather than matched
    // for later -- see `valueClass` above.
    cell('Status', fields.status, statusClass(fields.status)),
  ].filter((fact): fact is CaseStudyFact => fact !== undefined);
}

function cell(
  label: string,
  value: string | undefined,
  valueClass?: string,
): CaseStudyFact | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return valueClass === undefined
    ? { label, value: trimmed }
    : { label, value: trimmed, valueClass };
}
