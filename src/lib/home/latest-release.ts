// The latest release for the system band tile on the home page, read from the
// same CHANGELOG.md that /ops reads. Every release-please release is tagged
// `ryanlindsey-me-v<version>`, verified 2026-09-26 against the three most recent
// releases, so the GitHub release URL is predictable from the version alone
// without a GitHub API call.
//
// Returns null rather than throwing when the changelog has no releases, because
// the tile renders an absence: the build must not fail on a changelog whose
// first heading does not parse.

import { recentReleases } from '../ops/changelog';

export const RELEASE_TAG_PREFIX = 'ryanlindsey-me-v';

export interface LatestRelease {
  version: string;
  date: string;
  url: string;
}

export function latestRelease(changelog: string): LatestRelease | null {
  const recent = recentReleases(changelog, 1);
  if (recent.length === 0) {
    return null;
  }

  const { version, date } = recent[0];
  const url = `https://github.com/ryanlindsey/ryanlindsey.me/releases/tag/${RELEASE_TAG_PREFIX}${version}`;

  return {
    version,
    date,
    url,
  };
}
