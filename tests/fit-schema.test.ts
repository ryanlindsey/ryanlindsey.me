import { expect, test } from 'vitest';
import { enforceCitations, FitReport, FIT_REPORT_JSON_SCHEMA } from '../src/lib/fit/schema';

const report = () => ({
  overall_read: 'A generic summary of the comparison.',
  requirement_map: [
    {
      requirement: 'Runs platform teams',
      strength: 'strong' as const,
      evidence: [
        { claim: 'Led a platform group', citation_url: 'https://ryanlindsey.me/resume' },
        { claim: 'Ran an incident programme', citation_url: 'https://invented.example/nope' },
      ],
    },
  ],
  gaps: [{ requirement: 'Field service', why: 'No evidence in the corpus.' }],
  questions_to_ask: ['How is the on-call rotation staffed?'],
});

test('a well-formed report parses', () => {
  expect(FitReport.safeParse(report()).success).toBe(true);
});

test('a report with no requirements is refused', () => {
  // An empty requirement map is not a fit report, it is a refusal wearing
  // one -- and the caller should see the engine's own error rather than an
  // empty table.
  expect(FitReport.safeParse({ ...report(), requirement_map: [] }).success).toBe(false);
});

test('an unknown strength is refused', () => {
  const bad = report();
  bad.requirement_map[0].strength = 'excellent' as never;
  expect(FitReport.safeParse(bad).success).toBe(false);
});

test('gaps and questions may be empty arrays but must be present', () => {
  expect(FitReport.safeParse({ ...report(), gaps: [], questions_to_ask: [] }).success).toBe(true);
  const missing = report() as Record<string, unknown>;
  delete missing.gaps;
  expect(FitReport.safeParse(missing).success).toBe(false);
});

test('the JSON Schema is derived from the zod schema, not hand-written', () => {
  // The model is handed the JSON Schema and the response is validated with
  // the zod one. Two hand-maintained copies of the same shape drift, and the
  // drift is invisible: the model emits what the JSON Schema asked for and
  // zod rejects it.
  expect(FIT_REPORT_JSON_SCHEMA).toMatchObject({ type: 'object' });
  const properties = (FIT_REPORT_JSON_SCHEMA as { properties: Record<string, unknown> }).properties;
  expect(Object.keys(properties).sort()).toEqual(
    ['gaps', 'overall_read', 'questions_to_ask', 'requirement_map'].sort(),
  );
});

test('enforceCitations drops evidence whose URL is not in the corpus', () => {
  const allowed = new Set(['https://ryanlindsey.me/resume']);
  const { report: cleaned, audit } = enforceCitations(FitReport.parse(report()), allowed);
  expect(audit).toEqual({ checked: 2, dropped: 1 });
  expect(cleaned.requirement_map[0].evidence).toHaveLength(1);
  expect(cleaned.requirement_map[0].evidence[0].citation_url).toBe('https://ryanlindsey.me/resume');
});

test('a requirement left with no evidence is demoted to strength "none"', () => {
  // The honesty contract (03 §4) in one line: a "strong" rating whose only
  // support was a fabricated citation is not a strong rating. Demoting rather
  // than deleting keeps the requirement visible, which is what a reader
  // needs -- a silently shorter table reads as a shorter job.
  const one = report();
  one.requirement_map[0].evidence = [
    { claim: 'Invented', citation_url: 'https://invented.example/nope' },
  ];
  const { report: cleaned, audit } = enforceCitations(FitReport.parse(one), new Set());
  expect(audit).toEqual({ checked: 1, dropped: 1 });
  expect(cleaned.requirement_map[0].strength).toBe('none');
  expect(cleaned.requirement_map[0].evidence).toEqual([]);
});

test('enforcement does not mutate its input', () => {
  const original = FitReport.parse(report());
  const before = JSON.stringify(original);
  enforceCitations(original, new Set());
  expect(JSON.stringify(original)).toBe(before);
});

test('describe strings survive in the derived JSON Schema', () => {
  // Field descriptions are instructions to the model. If they stop surviving
  // the zod-to-JSON-Schema conversion, the engine silently loses field-level
  // guidance: every report gets subtly worse, but nothing fails to alert us.
  // This test ensures descriptions remain intact at all nesting levels.
  const properties = (FIT_REPORT_JSON_SCHEMA as { properties: Record<string, unknown> })
    .properties as Record<string, unknown>;

  // Top-level field: overall_read should have its description
  const overallRead = properties.overall_read as Record<string, unknown>;
  expect(overallRead.description).toContain('honest overall read');

  // Nested field inside requirement_map's items: strength should have its description
  const requirementMap = properties.requirement_map as Record<string, unknown>;
  const items = requirementMap.items as Record<string, unknown>;
  const itemsProperties = items.properties as Record<string, unknown>;
  const strength = itemsProperties.strength as Record<string, unknown>;
  expect(strength.description).toContain('How well the subject meets this requirement');
});

test('citation_url refuses a non-https scheme, including the ones z.string().url() admits', () => {
  // Deferred minor L691 and final-review Important 5, pinned together: this
  // is the second fence behind `enforceCitations`, and it is the ONLY one on
  // the permalink read path, where `parseStoredReport` re-validates a stored
  // row with this schema and renders `citation_url` into an anchor's `href`.
  //
  // The three hostile values are not hypothetical shapes -- each was measured
  // as `true` against a bare `z.string().url()` on the installed zod (4.5.4),
  // which is what this field used to be.
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    // Not hostile, but outside what any corpus URL can be: every one is built
    // from SITE_ORIGIN, which is https in both wrangler configs and in the
    // fit fixtures. Admitting http would widen the rule for nothing.
    'http://ryanlindsey.me/resume',
    'not-a-url-at-all',
  ]) {
    const hostile = report();
    hostile.requirement_map[0]!.evidence[0]!.citation_url = url;
    expect(FitReport.safeParse(hostile).success, `${url} must be refused`).toBe(false);
  }
});

test('citation_url still accepts an ordinary https corpus URL', () => {
  const ok = report();
  ok.requirement_map[0]!.evidence[0]!.citation_url = 'https://ryanlindsey.me/writing/some-post';
  expect(FitReport.safeParse(ok).success).toBe(true);
});
