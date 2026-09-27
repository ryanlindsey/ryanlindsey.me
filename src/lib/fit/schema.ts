// The fit report's shape (03 §4), and the citation rule that makes it
// trustworthy.
//
// ONE schema, two consumers. The zod object below validates whatever the
// model returns; `FIT_REPORT_JSON_SCHEMA` is DERIVED from it and is what the
// model is handed as `output_config.format`, less its `format` keywords (see
// the constant, and #446). Deriving rather than
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
  // SCHEME-CONSTRAINED, and the constraint is the security control rather
  // than a tidiness one. MEASURED against the installed zod (4.5.4): a bare
  // `z.string().url()` returns `true` for `javascript:alert(1)`,
  // `data:text/html,...` and `vbscript:...`. This value is rendered as
  // `<a href={item.citation_url}>` by src/pages/fit/r/[id].astro, so a
  // permissive schema puts the scheme of an anchor on ryanlindsey.me under
  // the control of whatever produced the report.
  //
  // Today `enforceCitations` (../fit/engine.ts) already drops any URL outside
  // `allowedUrls`, so no current path can reach that anchor with a hostile
  // scheme. This is the SECOND fence, and it exists because the two paths are
  // not the same path: `parseStoredReport` in [id].astro re-validates a row
  // read back from D1 with this schema and renders it WITHOUT re-running
  // `enforceCitations`. A permalink is designed to be forwarded to people
  // holding no token, so one future writer that skips the filter would be
  // stored XSS on the apex domain. Constraining the scheme here covers both
  // paths with one rule.
  //
  // `https` only, not `https?`: every corpus URL is built from `SITE_ORIGIN`,
  // which is `https://ryanlindsey.me` in both wrangler configs and
  // `https://site.test` in the fit fixtures. Nothing in this repo produces an
  // `http:` citation, so admitting one would widen the rule past anything it
  // needs to accept.
  citation_url: z
    .url({ protocol: /^https$/ })
    .describe(
      'The URL of the corpus document that supports this claim. Must be one of the URLs supplied in the context, and must be https.',
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
 * The same shape as JSON Schema, sent as `output_config.format` (#405). It was
 * the input schema of a forced tool until Opus 5.5 refused forced tool use.
 *
 * `z.toJSONSchema` is zod 4's own converter, so the `.describe()` calls above
 * become field descriptions the model actually reads -- which is why the
 * descriptions are written as instructions rather than as documentation.
 *
 * `format` IS STRIPPED, AND THAT IS WHAT KEEPS CITATIONS INTACT (#446). The
 * converter turns `citation_url`'s `z.url()` into `"format": "uri"`, and under
 * `output_config.format` the schema is enforced by constrained decoding.
 * MEASURED 2026-09-27 in the AI Gateway logs, on `anthropic/claude-opus-5.5`:
 * every citation of a URL ending in `/` came back with a stray token appended
 * (`.../work/silent-failure/r`, `.../work/delivery-forecasting/Human`), 12 of
 * 12, while all 23 citations of `/resume`, which has no trailing slash, came
 * back intact. `enforceCitations` dropped every corrupted one, so each case
 * study and post fell out of the report as evidence. The forced-tool path on
 * Opus 5 had cited the same URLs cleanly.
 *
 * Nothing is lost by the strip. The scheme rule never lived in the JSON Schema
 * -- `format: "uri"` admits `javascript:` as readily as `https:` -- it lives in
 * the zod schema above, which every report is still parsed with, including by
 * `parseStoredReport`. The model is steered by `citation_url`'s description.
 *
 * SCHEMA-WIDE, NOT `citation_url` ALONE, ON PURPOSE. `citation_url` is the
 * only field that emits a `format` today, but a later `z.email()` or
 * `z.iso.datetime()` would put the same keyword under the same decoder, and
 * zod is what validates every field anyway. tests/fit-schema.test.ts asserts
 * no `format` survives anywhere.
 *
 * WHAT IS NOT MEASURED: that `format` alone is the trigger. This is the fix
 * the evidence above points to, and the scheduled `fit` suite's
 * `max_dropped_citations: 0` is what will say whether it held.
 */
export const FIT_REPORT_JSON_SCHEMA = z.toJSONSchema(FitReport, {
  override: (ctx) => {
    delete ctx.jsonSchema.format;
  },
}) as Record<string, unknown>;

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
