import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { isStale, reviewAgeDays, REVIEW_MAX_AGE_DAYS } from '../src/lib/governance/register';
import { RETENTION } from '../src/lib/retention';
import { BANNED_PATTERNS } from './candidacy-patterns';

/**
 * The governance artifacts (06 §2): the published policy and the risk register.
 *
 * THE FILES ARE READ FROM DISK RATHER THAN THROUGH `getCollection`, on purpose.
 * What is under test is the CONTENT of two documents this repository publishes,
 * and `astro:content` is only importable from inside Astro's own module graph --
 * routing this through a built site would make a prose assertion depend on a
 * build. The collection schema in src/content.config.ts is the other half and
 * runs on every `astro build`: it validates the SHAPE, this validates what the
 * shape is carrying.
 *
 * THERE IS NO TEST THAT FAILS WHEN A ROW GOES STALE, and that is a deliberate
 * omission rather than a gap. A test whose result depends on today's date turns
 * `main` red one morning with no code change, and a build broken by the calendar
 * gets disabled rather than fixed -- which would take the rest of this file with
 * it. Staleness is RENDERED on /ai-policy instead, marked per row and counted
 * above the table, so it is visible to every reader including the owner. That is
 * the pressure that actually works on a document whose whole failure mode is
 * quiet neglect: the alternative is a red build nobody can act on at 9am, and a
 * document nobody is embarrassed by is a document nobody re-reads.
 *
 * `reviewAgeDays` and `isStale` are still pinned below, against FIXED dates. The
 * arithmetic is what the page renders staleness from, and it has to be right
 * whether or not anything is stale today.
 */

/**
 * The parsed register, typed LOOSELY and deliberately.
 *
 * `parse` returns `any`, which `npm test` is perfectly happy with and
 * `npm run check` is not: `register.rows.map((row) => row.id)` is ts(7006),
 * implicit any, and CI runs `astro check`. So an annotation is required -- but
 * annotating it as `{ rows: RiskRow[] }` would assert the exact shape this file
 * exists to verify, and every assertion below would be checking a claim the
 * type had already made. `Record<string, unknown>` types only what is needed to
 * index a row, leaving whether the fields are present and well-formed to the
 * tests. The shape proper is enforced on every build by the zod schema in
 * src/content.config.ts.
 */
const register = parse(readFileSync('governance/risk-register.yaml', 'utf8')) as {
  rows: Record<string, unknown>[];
};
const policy = readFileSync('governance/ai-policy.md', 'utf8');

describe('the register', () => {
  test('every row has every field 06 §2 requires', () => {
    for (const row of register.rows) {
      for (const field of [
        'id',
        'risk',
        'likelihood',
        'impact',
        'mitigation',
        'owner',
        'lastReviewed',
      ]) {
        expect(row[field], `${row.id}.${field}`).toBeTruthy();
      }
      expect(row.lastReviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('ids are unique', () => {
    const ids = register.rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('it carries a row for every risk 06 §2 enumerates', () => {
    const ids = register.rows.map((row) => row.id);
    for (const required of [
      'prompt-injection',
      'citation-fabrication',
      'private-tier-disclosure',
      'token-leakage',
      'cost-blowout',
      'tone-and-refusal',
    ]) {
      expect(ids).toContain(required);
    }
  });

  test('no row matches a banned pattern', () => {
    for (const pattern of BANNED_PATTERNS) {
      expect(JSON.stringify(register)).not.toMatch(pattern);
    }
  });
});

describe('the policy', () => {
  test('publishes exactly the retention windows the cron enforces', () => {
    // Computed from RETENTION rather than written down, which is the whole
    // point: adding a table to that constant without publishing its window
    // fails here. `formatWindow` is deliberately NOT imported -- it landed on a
    // parallel branch, and a dependency on it would be a merge conflict bought
    // for two lines of arithmetic.
    for (const { table, days } of RETENTION) {
      const phrase = days === 30 ? '30 days' : '1 year';
      expect(policy, `${table} window`).toContain(phrase);
    }
  });

  test('states what is never stored', () => {
    expect(policy).toMatch(/no cookie/i);
    expect(policy).toMatch(/IP address/i);
  });

  test('matches no banned pattern', () => {
    for (const pattern of BANNED_PATTERNS) expect(policy).not.toMatch(pattern);
  });
});

describe('staleness', () => {
  const row = { id: 'x', lastReviewed: '2026-06-01' } as never;

  test('reports the age in whole days', () => {
    expect(reviewAgeDays(row, new Date('2026-09-09T00:00:00.000Z'))).toBe(100);
  });

  test('is stale past the window and fresh inside it', () => {
    expect(isStale(row, new Date('2026-09-09T00:00:00.000Z'))).toBe(true);
    expect(isStale(row, new Date('2026-06-15T00:00:00.000Z'))).toBe(false);
    expect(REVIEW_MAX_AGE_DAYS).toBe(90);
  });
});
