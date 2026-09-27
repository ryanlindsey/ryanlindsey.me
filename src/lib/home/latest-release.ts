// The latest release for the system band tile on the home page, read from the
// same CHANGELOG.md that /ops reads. Every release-please release is tagged
// `ryanlindsey-me-v<version>`, verified 2026-09-26 against the three most recent
// releases, so the GitHub release URL is predictable from the version alone
// without a GitHub API call.
//
// Returns null rather than throwing, because the tile renders an absence: the
// build must not fail on a changelog it cannot read.
//
// ONLY THE FIRST `## ` HEADING IS READ, and null is returned when there is no
// such heading or it does not parse. The plan said `recentReleases(changelog,
// 1)[0]`, and the final review of #437 found that wrong: `recentReleases` skips
// a line it cannot parse, so a newest heading carrying a time, such as
// `## [1.47.0](...) (2026-09-27T10:00Z)`, would have been passed over and the
// tile would have shown the release before it as the latest. That is a
// confident wrong answer where an absence is the honest one. The changelog's
// `# Changelog` title has one `#` and is never read, and the release
// sections' `### ` headings are excluded by the `[ \t]` after the second `#`.

import { recentReleases } from '../ops/changelog';

export const RELEASE_TAG_PREFIX = 'ryanlindsey-me-v';

export interface LatestRelease {
  version: string;
  date: string;
  url: string;
}

export function latestRelease(changelog: string): LatestRelease | null {
  const first = changelog.split('\n').find((line) => /^##[ \t]/.test(line));
  if (first === undefined) {
    return null;
  }
  const newest = recentReleases(first, 1)[0];
  if (newest === undefined) {
    return null;
  }

  const { version, date } = newest;
  const url = `https://github.com/ryanlindsey/ryanlindsey.me/releases/tag/${RELEASE_TAG_PREFIX}${version}`;

  return {
    version,
    date,
    url,
  };
}
