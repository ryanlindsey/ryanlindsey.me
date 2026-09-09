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

/**
 * A report with THREE requirements, and the reason it exists rather than a
 * fourth variation on the one-requirement fixture above.
 *
 * Deferred minor L688: every `enforceCitations` assertion in this file ran
 * against a `requirement_map` of length one, so `checked` and `dropped` --
 * which are accumulated across the whole map -- were indistinguishable from
 * counters reset on each entry. MEASURED before this fixture was added:
 * moving `let checked = 0; let dropped = 0;` inside the `.map()` callback
 * left all eleven tests in this file green.
 *
 * That is not a cosmetic gap. The two counters are what `/fit/r/<id>` prints
 * in its footer as the evidence for the honesty contract, so the regression
 * would have made a report state "2 checked, 0 dropped" while silently having
 * dropped citations from every requirement but the last.
 */
const wideReport = () => ({
  overall_read: 'A generic summary across several requirements.',
  requirement_map: [
    {
      requirement: 'First requirement',
      strength: 'strong' as const,
      evidence: [
        { claim: 'Kept', citation_url: 'https://ryanlindsey.me/resume' },
        { claim: 'Dropped', citation_url: 'https://invented.example/one' },
      ],
    },
    {
      requirement: 'Second requirement',
      strength: 'partial' as const,
      evidence: [{ claim: 'Dropped', citation_url: 'https://invented.example/two' }],
    },
    {
      requirement: 'Third requirement',
      strength: 'strong' as const,
      evidence: [{ claim: 'Kept', citation_url: 'https://ryanlindsey.me/writing' }],
    },
  ],
  gaps: [],
  questions_to_ask: ['A question.'],
});

test('enforceCitations counts across the whole requirement map, not per requirement', () => {
  const allowed = new Set(['https://ryanlindsey.me/resume', 'https://ryanlindsey.me/writing']);
  const { report: cleaned, audit } = enforceCitations(FitReport.parse(wideReport()), allowed);

  // 4 pieces of evidence across 3 requirements, 2 of them unresolvable. Both
  // totals are only reachable by accumulating across entries: a per-entry
  // reset would leave the LAST requirement's numbers here (1 checked, 0
  // dropped), which is the exact shape of the regression this pins.
  expect(audit).toEqual({ checked: 4, dropped: 2 });

  // The middle requirement lost its only evidence and is demoted -- asserted
  // alongside the counts because a demotion in the MIDDLE of the map is the
  // other thing a one-entry fixture could never show.
  expect(cleaned.requirement_map[1].strength).toBe('none');
  expect(cleaned.requirement_map[1].evidence).toHaveLength(0);
  expect(cleaned.requirement_map[0].strength).toBe('strong');
  expect(cleaned.requirement_map[2].strength).toBe('strong');
});

test('describe strings survive at every nesting level, including inside evidence', () => {
  // Deferred minor L686: the existing survival test asserts levels 0 and 1,
  // and `Evidence`'s own fields sit one deeper -- so a `describe` lost from
  // `citation_url`, the field whose description carries the https rule the
  // model is steered by, was unchecked.
  const props = (FIT_REPORT_JSON_SCHEMA as { properties: Record<string, unknown> }).properties;
  const evidence = (
    (
      (props.requirement_map as { items: { properties: Record<string, unknown> } }).items.properties
        .evidence as { items: { properties: Record<string, { description?: string }> } }
    ).items as { properties: Record<string, { description?: string }> }
  ).properties;

  expect(evidence.claim!.description, 'Evidence.claim lost its description').toBeTruthy();
  expect(
    evidence.citation_url!.description,
    'Evidence.citation_url lost its description',
  ).toBeTruthy();
  // The https rule specifically -- it is the only place the model is told,
  // since z.toJSONSchema emits no pattern for the protocol constraint.
  expect(evidence.citation_url!.description).toMatch(/https/i);
});
