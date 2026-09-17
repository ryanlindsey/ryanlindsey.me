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
import { PUBLISHED_AS, RETENTION } from '../src/lib/retention';
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
 * What each `RETENTION` table is called on /ai-policy USED TO BE DECLARED HERE,
 * and the move is the point rather than a tidy-up.
 *
 * A table name is a schema identifier and the policy is written for a reader, so
 * the two cannot be the same string -- but they have to be bound to each other
 * somewhere, and this file was that somewhere for as long as the binding existed
 * only to check hand-typed prose. The 2026-09 redesign (issue #110) made the
 * page RENDER the rows from `RETENTION`, which needs the same binding at
 * runtime, and a copy in a test file that a page cannot import is a second copy
 * by construction. It lives in src/lib/retention.ts now, beside the constant and
 * beside `formatWindow`, for the reason that function's own header already
 * gives: one spelling, read by every surface that publishes it.
 *
 * Completeness is no longer this file's job either. `PUBLISHED_AS` is typed
 * against `RETENTION`'s own table names, so a table added there without a
 * published name is a ts(2741) under `npm run check` rather than a green suite
 * -- earlier and louder than the equality test that used to guard it, which is
 * kept below anyway because `npm test` does not typecheck.
 */

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
 * left to hide in. `formatWindow` is STILL NOT imported, though the reason has
 * changed: it used to live on a parallel branch and not resolve here, and it
 * resolves fine now. It stays a separate copy because the test above asserts an
 * ABSENCE, and an absence checked with the page's own formatter passes
 * vacuously the moment that formatter returns something unexpected. An
 * independent spelling is what keeps "the prose does not say it" from meaning
 * "we looked for the wrong string".
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
  test('restates no retention window in prose, because the page renders them', () => {
    // INVERTED BY ISSUE #110, and the claim it protects is the same one. This
    // used to assert that the document said `<label> — <window>` for every
    // retained table. The page now builds that row from `RETENTION` itself, so
    // a sentence here saying it again is a second copy of a number that only
    // the cron can settle: the two agree today and the first edit to either is
    // free to part them. The rendered assertion moved to tests/pages.test.ts's
    // "every retention window on the page is the one the cron enforces", which
    // is where the claim is now made.
    //
    // ANY OCCURRENCE, not just the old `<label> — <window>` shape. Asserting the
    // absence of that exact string would pass on "Chat transcripts are kept for
    // 30 days", which is the same duplication wearing a different sentence.
    //
    // "a year" at the end of the fingerprinting bullet is untouched by this and
    // should be: it describes how long an MCP client's name is kept, in prose,
    // and it is not the phrase `formatWindow` produces.
    for (const { table, days } of RETENTION) {
      expect(
        policy,
        `${table}'s window is restated in prose; the table on /ai-policy carries it`,
      ).not.toContain(windowPhrase(days));
    }
  });

  test('still names every retained table, in the words the page renders', () => {
    // The other half of the inversion above. Dropping the windows from the prose
    // must not turn into dropping the disclosure: each table is still named in
    // the document, in the same words the rendered table labels it with, so the
    // section a reader lands on from the rail describes the row they just read.
    for (const { table } of RETENTION) {
      expect(policy, `${table} is no longer named in the policy`).toContain(PUBLISHED_AS[table]);
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
    // also fails. Without this, `PUBLISHED_AS[table]` would be `undefined` and
    // /ai-policy would render a row labelled "undefined", which nobody would
    // read as a missing disclosure.
    //
    // KEPT AFTER THE TYPE MOVED WITH IT (issue #110). `PUBLISHED_AS` is now
    // typed against `RETENTION`'s table names, so `npm run check` catches a
    // missing entry first -- but `npm test` does not typecheck, and this suite
    // is what runs in the loop while somebody is editing the constant.
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
    // Issue #146 added a fourth surface to this page's analytics paragraph and
    // the only reason this line exists is that the paragraph drifted first: it
    // said "six bounded labels" and enumerated exactly six while a search row
    // had already grown to nine fields. Nothing here read that sentence, so the
    // count was falsified in silence. Directional for the same reason as the
    // two above -- what has to survive an edit is the DISCLAIMER, since the
    // promise that no query text is recorded is the whole reason the row is
    // publishable at all, and the count beside it is the thing most likely to
    // go stale next.
    expect(policy, 'the no-query-text claim').toMatch(
      /text of the search is not\s+among them and is not recorded anywhere/,
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
