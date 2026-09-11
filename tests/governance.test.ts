import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
const registerText = readFileSync('governance/risk-register.yaml', 'utf8');
const register = parse(registerText) as { rows: Record<string, unknown>[] };
const policy = readFileSync('governance/ai-policy.md', 'utf8');

/**
 * What each `RETENTION` table is called on /ai-policy.
 *
 * A table name is a schema identifier and the policy is written for a reader, so
 * the two cannot be the same string -- but they have to be bound to each other
 * somewhere, and this is that somewhere. The test below asserts key-set equality
 * with `RETENTION`, so this is a register rather than a lookup that can quietly
 * go out of date.
 */
const PUBLISHED_AS: Record<string, string> = {
  chat_turns: 'Chat transcripts',
  mcp_tool_calls: 'The tool-call audit trail',
  fit_reports: 'Fit reports',
};

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

  test('stops denying a published metrics view the day one lands', () => {
    // THE ONE CROSS-PR GAP THIS FILE CAN CLOSE, and the shape of it matters more
    // than the assertion. `private-tier-disclosure` deliberately claims nothing
    // about a metrics page, because none is in this repository: a register is a
    // dated attestation, and a forward-looking claim would be false for the whole
    // interval between this branch merging and /ops merging. The failure mode is
    // the /ops branch landing and nobody remembering to re-review the row, which
    // would leave the page denying a surface the site is serving.
    //
    // PRESENCE-COUPLED, NOT DATE-COUPLED, and that distinction is the same one
    // this file's header makes about staleness. A test keyed on the calendar goes
    // red on a morning when nothing changed, and gets disabled rather than acted
    // on. This one can only go red as a CONSEQUENCE of a code change, in the very
    // commit that causes it -- whoever adds src/lib/ops or src/pages/ops.astro
    // gets a failure naming the sentence they have just falsified, while the
    // context for fixing it is still in front of them.
    //
    // Both paths, because either one arriving alone is enough to make the denial
    // wrong: the module is where a tier filter would live, and the page is what a
    // reader would see.
    const opsExists = existsSync('src/lib/ops') || existsSync('src/pages/ops.astro');
    if (opsExists) {
      expect(
        registerText,
        'a metrics surface now exists -- re-review private-tier-disclosure, state the tier filter, and move its lastReviewed forward',
      ).not.toMatch(/not in this repository/);
    } else {
      // Pinned from the other side too, so the guard cannot be defeated by
      // rewording the row: if that sentence is dropped while no metrics surface
      // exists, the row has started claiming something about a page that is not
      // here, which is the overclaim this whole register was rewritten to avoid.
      expect(registerText).toMatch(/not in this repository/);
    }
  });
});

describe('the policy', () => {
  test('publishes exactly the retention windows the cron enforces, table by table', () => {
    // BOUND TABLE-TO-WINDOW, not window-to-anywhere. The version this replaces
    // asserted only that the LITERALS '30 days' and '1 year' appeared somewhere
    // in the file, which with RETENTION = [30, 365, 365] is nearly free:
    // changing `chat_turns` to 60 days turns its phrase into '1 year', which the
    // page still contains for two other tables, so the suite stayed green while
    // the page said 30 and the cron enforced 60. The published NAME of each
    // table has to sit next to its own window for this to mean anything.
    //
    // `formatWindow` is deliberately NOT imported -- it landed on a parallel
    // branch, and a dependency on it would be a merge conflict bought for two
    // lines of arithmetic.
    for (const { table, days } of RETENTION) {
      const label = PUBLISHED_AS[table];
      expect(label, `${table} has no published name in this test's table`).toBeDefined();
      const phrase = days === 30 ? '30 days' : '1 year';
      expect(policy, `${table} window`).toContain(`${label} — ${phrase}`);
    }
  });

  test('names every retained table and no table it does not retain', () => {
    // EQUALITY, the same reasoning as SCAN_EXCEPTIONS: adding a table to
    // RETENTION without giving it a published name fails here rather than
    // silently skipping it above, and dropping one leaves a stale entry that
    // also fails. Without this, `PUBLISHED_AS[table]` would be `undefined` for a
    // new table and the `toContain` above would be checking a string beginning
    // "undefined —", which nobody would read as a missing disclosure.
    expect(Object.keys(PUBLISHED_AS).sort()).toEqual(RETENTION.map((row) => row.table).sort());
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
