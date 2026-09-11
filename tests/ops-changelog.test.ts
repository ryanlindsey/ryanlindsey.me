import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { recentReleases } from '../src/lib/ops/changelog';

/**
 * The release feed on /ops, and the no-times rule it has to keep (10 §1.4).
 *
 * Two kinds of test here, deliberately. The fixture tests pin the parse against
 * headings chosen to break it; the last one runs the parser over the REAL
 * CHANGELOG.md in this repo, which is the file /ops will actually read and the
 * only input nobody in this repo writes by hand -- release-please generates it
 * from squash-merged PR titles. A parser that is green on fixtures and wrong on
 * the real file is the failure worth spending a `readFileSync` on.
 */

const FIXTURE = `# Changelog

## [1.12.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/v1.11.0...v1.12.0) (2026-09-11)


### Features

* publish the first post ([#66](https://github.com/ryanlindsey/ryanlindsey.me/issues/66)) ([a91a504](https://github.com/ryanlindsey/ryanlindsey.me/commit/a91a504))

## [1.11.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/v1.10.1...v1.11.0) (2026-09-11)


### Bug Fixes

* something ([#64](https://github.com/ryanlindsey/ryanlindsey.me/issues/64))

## 1.0.0 (2026-08-01)


### Features

* the first release, which release-please writes unlinked
`;

describe('recentReleases', () => {
  test('reads release-please headings, newest first', () => {
    expect(recentReleases(FIXTURE)).toEqual([
      { version: '1.12.0', date: '2026-09-11' },
      { version: '1.11.0', date: '2026-09-11' },
      { version: '1.0.0', date: '2026-08-01' },
    ]);
  });

  test('the unlinked first-release heading is read too', () => {
    // release-please writes the very first release without a compare link, so a
    // regex that required the brackets would drop the one release a new repo
    // has -- which is the state /ops would have shipped in.
    expect(recentReleases('## 1.0.0 (2026-08-01)')).toEqual([
      { version: '1.0.0', date: '2026-08-01' },
    ]);
  });

  test('the limit is honoured and defaults to a handful', () => {
    expect(recentReleases(FIXTURE, 2)).toEqual([
      { version: '1.12.0', date: '2026-09-11' },
      { version: '1.11.0', date: '2026-09-11' },
    ]);
    expect(recentReleases(FIXTURE, 0)).toEqual([]);
    expect(recentReleases(FIXTURE).length).toBeLessThanOrEqual(5);
  });

  test('the section headings inside a release are not releases', () => {
    // "### Features" and "### Bug Fixes" are one level deeper, and a `##`
    // prefix match that ignored the level would read them as versions.
    const versions = recentReleases(FIXTURE, 99).map((release) => release.version);
    expect(versions).not.toContain('Features');
    expect(versions).not.toContain('Fixes');
  });

  test('the body links that look like headings are ignored', () => {
    // Every bullet in a changelog carries `[#66](...)` and `[a91a504](...)`,
    // which is the same bracket-then-parenthesis shape as a heading. Only a
    // line that STARTS with `##` counts.
    expect(recentReleases('* a change ([#66](https://example.test/66)) (2026-09-11)')).toEqual([]);
  });

  test('an empty changelog is an empty list rather than a throw', () => {
    expect(recentReleases('')).toEqual([]);
    expect(recentReleases('# Changelog\n\nNothing has shipped yet.\n')).toEqual([]);
  });

  test('no release entry carries anything that could be a time of day', () => {
    for (const release of recentReleases(FIXTURE)) {
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(JSON.stringify(release)).not.toMatch(/\d{2}:\d{2}/);
    }
  });

  test('A HEADING CARRYING A TIME IS SKIPPED, NOT TRUNCATED', () => {
    // 10 §1.4 as a mechanism rather than a convention. If release-please ever
    // starts stamping headings to the minute, this parser must publish nothing
    // rather than publish the time -- and truncating a timestamp to its date
    // would be the tempting wrong answer, because it would keep the row while
    // quietly proving the format had changed under us.
    const stamped = '## [1.12.0](https://example.test/c) (2026-09-11T05:17:00Z)';
    expect(recentReleases(stamped)).toEqual([]);
  });

  test('the REAL CHANGELOG.md parses, and carries no time either', () => {
    const releases = recentReleases(readFileSync('CHANGELOG.md', 'utf8'), 99);
    // A regex that matched nothing would pass every fixture test above by
    // returning `[]`; this is the assertion that catches it.
    expect(releases.length).toBeGreaterThan(0);
    for (const release of releases) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(JSON.stringify(release)).not.toMatch(/\d{2}:\d{2}/);
    }
    // Newest first, which is the order the page renders them in -- and it comes
    // from the file rather than from a sort in this parser, so it is worth
    // asserting that the file really is in that order.
    const dates = releases.map((release) => release.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
