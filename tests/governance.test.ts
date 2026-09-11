import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  isStale,
  reviewAgeDays,
  severityOf,
  IMPACTS,
  LIKELIHOODS,
  REVIEW_MAX_AGE_DAYS,
} from '../src/lib/governance/register';
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

/**
 * How a window is spelled in prose, DERIVED FROM `days`.
 *
 * The second fix to this line, and the first one did not go far enough. It began
 * as `days === 30 ? '30 days' : '1 year'`, which asserted only that two literals
 * appeared somewhere in the file; fix round 1 bound each table to its own label
 * but KEPT that two-valued lookup, which distinguishes exactly-30 from
 * everything else and nothing more. MEASURED: `fit_reports` 365 -> 180 still
 * produced '1 year', so the page kept publishing "Fit reports — 1 year" while
 * the cron deleted at 180, with this suite green. The bucketing was the whole
 * defect both times; binding the table only moved it.
 *
 * Derived, so every distinct window is a distinct phrase and there is no bucket
 * left to hide in. `formatWindow` is NOT imported -- it lives on a parallel
 * branch and would not resolve here.
 */
function windowPhrase(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? '1 year' : `${years} years`;
  }
  return days === 1 ? '1 day' : `${days} days`;
}

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
    // The phrase itself is derived -- see `windowPhrase` above for why the
    // binding alone was not enough.
    for (const { table, days } of RETENTION) {
      const label = PUBLISHED_AS[table];
      expect(label, `${table} has no published name in this test's table`).toBeDefined();
      expect(policy, `${table} window`).toContain(`${label} — ${windowPhrase(days)}`);
    }
  });

  test('spells a distinct window as a distinct phrase', () => {
    // The property the assertion above rests on, pinned directly: no two windows
    // may share a phrase, or a changed window can land on the sentence already
    // published for a different one. Both previous versions of this test failed
    // exactly here.
    expect(windowPhrase(30)).toBe('30 days');
    expect(windowPhrase(365)).toBe('1 year');
    expect(windowPhrase(180)).toBe('180 days');
    expect(windowPhrase(60)).toBe('60 days');
    expect(windowPhrase(730)).toBe('2 years');
    expect(windowPhrase(1)).toBe('1 day');
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
    // DIRECTIONAL, because the grep this replaces was not. `/IP address/i` is
    // satisfied just as well by "we store your IP address" as by the claim the
    // test name promises, so it checked that the subject was mentioned rather
    // than that anything was disclaimed -- a test that cannot fail on the
    // opposite of what it asserts is not checking the assertion. Matching the
    // claim's own opening words makes editing it a deliberate act, which is the
    // right friction for a published promise.
    expect(policy, 'the no-cookies claim').toMatch(/No cookies\.\*\*\s+This site sets none/);
    expect(policy, 'the no-address claim').toMatch(
      /No IP address in any table\.\*\*\s+There is no address column/,
    );
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

  test('turns over AFTER the window, not on it', () => {
    // The boundary the `>` actually decides, which 100-and-14 never touched:
    // with only those two cases, flipping `>` to `>=` breaks nothing and every
    // row silently goes amber a day early. 2026-06-01 + 90 days is 2026-08-30.
    expect(reviewAgeDays(row, new Date('2026-08-30T00:00:00.000Z'))).toBe(90);
    expect(isStale(row, new Date('2026-08-30T00:00:00.000Z'))).toBe(false);
    expect(isStale(row, new Date('2026-08-31T00:00:00.000Z'))).toBe(true);
  });

  test('refuses a date that is shaped right and is not a day', () => {
    // MEASURED, and the obvious worry is the wrong one: `isoDate`'s regex
    // already rejects every form that makes `Date.parse` return NaN
    // (`2026-13-01`, `2026-01-32`), so NaN cannot arrive through the collection.
    // What does arrive is the rollover class -- `2026-02-31` parses cleanly to
    // 2026-03-03 -- and it fails in the direction that suppresses the marker,
    // by reading as a LATER date than was typed. Both classes are refused.
    const rolled = { id: 'rolled', lastReviewed: '2026-02-31' } as never;
    expect(() => reviewAgeDays(rolled, new Date('2026-09-09T00:00:00.000Z'))).toThrow(
      /not a real date/,
    );
    const nonsense = { id: 'nonsense', lastReviewed: '2026-13-01' } as never;
    expect(() => reviewAgeDays(nonsense, new Date('2026-09-09T00:00:00.000Z'))).toThrow(
      /not a real date/,
    );
    // And the register's own rows all survive it, which is the case that matters.
    for (const row_ of register.rows) {
      expect(() => reviewAgeDays(row_ as never, new Date())).not.toThrow();
    }
  });
});

describe('the severity ramp', () => {
  test('pins both scales, because severityOf colours by position on them', () => {
    // `severityOf` reads the INDEX, so inserting a value in the middle of either
    // array re-colours published rows with nothing red. Its own doc comment warns
    // about that and nothing enforced it until here.
    expect(LIKELIHOODS).toEqual(['rare', 'unlikely', 'possible', 'likely', 'almost-certain']);
    expect(IMPACTS).toEqual(['minor', 'moderate', 'major', 'severe']);
  });

  test('maps every scale value to the token the table paints it with', () => {
    // The boundaries are hand-derived float comparisons (`< 1/3`, `< 2/3`) and
    // were asserted only in prose. `moderate` at exactly 1/3 is the case that
    // depends on two identical divisions comparing equal, so it is the one worth
    // having written down.
    expect(severityOf('rare')).toBe('ok');
    expect(severityOf('unlikely')).toBe('ok');
    expect(severityOf('possible')).toBe('warn');
    expect(severityOf('likely')).toBe('danger');
    expect(severityOf('almost-certain')).toBe('danger');
    expect(severityOf('minor')).toBe('ok');
    expect(severityOf('moderate')).toBe('warn');
    expect(severityOf('major')).toBe('danger');
    expect(severityOf('severe')).toBe('danger');
  });
});
