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
