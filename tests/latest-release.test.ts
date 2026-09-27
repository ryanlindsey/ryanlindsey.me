import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { latestRelease, RELEASE_TAG_PREFIX } from '../src/lib/home/latest-release';

/**
 * The latest release for the system band tile.
 *
 * The function reads the changelog's first `## ` heading through
 * `recentReleases(firstLine, 1)` and builds the URL from a constant prefix plus
 * the version. Every release-please release is tagged
 * with that prefix and the semantic version, so the URL is predictable without
 * a GitHub API call.
 *
 * The function returns null rather than throwing when there is no `## `
 * heading, or when the first one does not parse, because the tile renders an
 * absence. It does not fall through to the next heading: the plan's
 * `recentReleases(changelog, 1)[0]` did, since `recentReleases` skips a line it
 * cannot parse, and would have shown an older release as the latest.
 */

const FIXTURE_WITH_RELEASE = `# Changelog

## [1.46.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/v1.45.0...v1.46.0) (2026-09-26)


### Features

* something new ([#432](https://github.com/ryanlindsey/ryanlindsey.me/issues/432))
`;

const FIXTURE_FIRST_HEADING_UNPARSEABLE = `# Changelog

## [1.47.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/v1.46.0...v1.47.0) (2026-09-27T10:00Z)

## [1.46.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/v1.45.0...v1.46.0) (2026-09-26)
`;

const FIXTURE_NO_RELEASES = `# Changelog

No releases yet.
`;

describe('latestRelease', () => {
  test('reads the first release and builds a GitHub release URL', () => {
    const result = latestRelease(FIXTURE_WITH_RELEASE);
    expect(result).toEqual({
      version: '1.46.0',
      date: '2026-09-26',
      url: `https://github.com/ryanlindsey/ryanlindsey.me/releases/tag/${RELEASE_TAG_PREFIX}1.46.0`,
    });
  });

  test('returns null when the changelog has no releases', () => {
    expect(latestRelease(FIXTURE_NO_RELEASES)).toBeNull();
  });

  test('returns null when the newest heading does not parse, rather than the one after it', () => {
    expect(latestRelease(FIXTURE_FIRST_HEADING_UNPARSEABLE)).toBeNull();
  });

  test('against the real CHANGELOG.md, version equals the first heading and date is YYYY-MM-DD', () => {
    const changelog = readFileSync('CHANGELOG.md', 'utf8');
    const firstHeadingMatch = /^##[ \t]+\[(\d+\.\d+\.\d+)\]/m.exec(changelog);
    expect(firstHeadingMatch).not.toBeNull();

    if (firstHeadingMatch) {
      const expectedVersion = firstHeadingMatch[1];
      const result = latestRelease(changelog);
      expect(result).not.toBeNull();
      if (result) {
        expect(result.version).toBe(expectedVersion);
        expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result.url).toBe(
          `https://github.com/ryanlindsey/ryanlindsey.me/releases/tag/${RELEASE_TAG_PREFIX}${expectedVersion}`,
        );
      }
    }
  });
});
