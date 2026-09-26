import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { latestRelease, RELEASE_TAG_PREFIX } from '../src/lib/home/latest-release';

/**
 * The latest release for the system band tile.
 *
 * The function consumes `recentReleases(changelog, 1)` and builds the URL from
 * a constant prefix plus the version. Every release-please release is tagged
 * with that prefix and the semantic version, so the URL is predictable without
 * a GitHub API call.
 *
 * The function returns null rather than throwing when the changelog has no
 * releases, because the tile renders an absence: the build must not fail on a
 * changelog that opens with text rather than a `## [x.y.z]` heading.
 */

const FIXTURE_WITH_RELEASE = `# Changelog

## [1.46.0](https://github.com/ryanlindsey/ryanlindsey.me/compare/v1.45.0...v1.46.0) (2026-09-26)


### Features

* something new ([#432](https://github.com/ryanlindsey/ryanlindsey.me/issues/432))
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

  test('against the real CHANGELOG.md, version matches the first heading and date is YYYY-MM-DD', () => {
    const result = latestRelease(readFileSync('CHANGELOG.md', 'utf8'));
    expect(result).not.toBeNull();
    if (result) {
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(result.url).toMatch(
        /^https:\/\/github\.com\/ryanlindsey\/ryanlindsey\.me\/releases\/tag\/.+/,
      );
    }
  });
});
