// The fit report's shape (03 §4), and the citation rule that makes it
// trustworthy.
//
// ONE schema, two consumers. The zod object below validates whatever the
// model returns; `FIT_REPORT_JSON_SCHEMA` is DERIVED from it and is what the
// model is handed as a forced tool's `input_schema`. Deriving rather than
// hand-writing the second copy is the whole reason both can be believed: two
// maintained copies drift, and the drift is silent -- the model emits exactly
// what the JSON Schema asked for and zod rejects it, which reads as a model
// failure and is not.
//
// The engine is GENERIC (09 §2): it compares a profile against a target
// description. Nothing in this file knows what a description is for.

import { z } from 'zod';

export const STRENGTHS = ['strong', 'partial', 'none'] as const;

const Evidence = z.object({
  claim: z.string().min(1).describe('One specific claim about the subject, in your own words.'),
  citation_url: z
    .string()
    .url()
    .describe(
      'The URL of the corpus document that supports this claim. Must be one of the URLs supplied in the context.',
    ),
});

const Requirement = z.object({
  requirement: z
    .string()
    .min(1)
    .describe('One requirement, quoted or closely paraphrased from the target description.'),
  strength: z
    .enum(STRENGTHS)
    .describe('How well the subject meets this requirement on the evidence available.'),
  evidence: z
    .array(Evidence)
    .describe('Supporting evidence, each item citing a corpus URL. May be empty.'),
});

const Gap = z.object({
  requirement: z.string().min(1).describe('A requirement the subject does not meet.'),
  why: z.string().min(1).describe('What is missing, stated plainly.'),
});

export const FitReport = z.object({
  overall_read: z.string().min(1).describe('Two or three sentences: the honest overall read.'),
  /**
   * At least one. An empty map is not a report -- it is a refusal wearing
   * one, and a caller shown an empty table has no way to tell the difference.
   */
  requirement_map: z.array(Requirement).min(1),
  /**
   * MAY be empty, and is deliberately not `.min(1)`: forcing a gap would
   * invent one, which is the mirror image of the flattery the honesty
   * contract exists to prevent. The eval suite asserts gaps on the partial-fit
   * golden case, where their ABSENCE is the failure — that is the right place
   * for the requirement, because it depends on the input.
   */
  gaps: z.array(Gap),
  questions_to_ask: z
    .array(z.string().min(1))
    .describe('Questions worth asking the subject to probe the uncertain areas.'),
});

export type FitReport = z.infer<typeof FitReport>;

/**
 * The same shape as JSON Schema, for the forced tool the model emits through.
 *
 * `z.toJSONSchema` is zod 4's own converter, so the `.describe()` calls above
 * become field descriptions the model actually reads -- which is why the
 * descriptions are written as instructions rather than as documentation.
 */
export const FIT_REPORT_JSON_SCHEMA = z.toJSONSchema(FitReport) as Record<string, unknown>;

export interface CitationAudit {
  checked: number;
  dropped: number;
}

/**
 * Removes every piece of evidence whose citation does not resolve to a real
 * corpus document, and reports how many it removed.
 *
 * 03 §4 makes citations mandatory and forbids uncited claims, and 04 §4 asks
 * the eval suite to check for fabricated citations "against the corpus
 * manifest". This is the runtime half of that: the eval catches a prompt that
 * has started fabricating, and this makes sure a fabricated citation never
 * reaches a reader in the meantime.
 *
 * A requirement stripped of all its evidence is DEMOTED to `none` rather than
 * removed. Removing it would shorten the table, and a shorter table reads as a
 * shorter set of requirements -- the report would be quietly easier to pass.
 * Demotion says the true thing: this requirement is here and nothing supports
 * it.
 *
 * Pure: returns a new report, mutates nothing.
 */
export function enforceCitations(
  report: FitReport,
  allowed: Set<string>,
): { report: FitReport; audit: CitationAudit } {
  let checked = 0;
  let dropped = 0;

  const requirement_map = report.requirement_map.map((entry) => {
    const evidence = entry.evidence.filter((item) => {
      checked += 1;
      const ok = allowed.has(item.citation_url);
      if (!ok) dropped += 1;
      return ok;
    });
    return {
      ...entry,
      evidence,
      strength: evidence.length === 0 ? ('none' as const) : entry.strength,
    };
  });

  return { report: { ...report, requirement_map }, audit: { checked, dropped } };
}
