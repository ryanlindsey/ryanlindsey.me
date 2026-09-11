// The release half of /ops (06 §1): what shipped, and when, read out of the
// CHANGELOG release-please already generates rather than out of a second list
// somebody has to remember to update.
//
// DATES ONLY, NEVER TIMES (10 §1.4). The published rule is that this site does
// not publish a time of day for the owner's activity -- a release feed stamped
// to the minute is a working-hours graph, and it is one nobody would think to
// audit because the numbers are all about software. The regex below is the
// mechanism: the date group matches exactly `YYYY-MM-DD` and the heading must
// END there, so a heading carrying anything more precise does not match at all
// and is skipped. That is a degrade (one fewer row on /ops), never a leak, and
// tests/ops-changelog.test.ts asserts the property directly rather than
// trusting the regex to be read correctly.
//
// Parsing the file rather than calling the GitHub API: /ops must render with no
// credential and no outbound request, the file is in this repo and ships with
// the build, and release-please's heading format is the most stable thing about
// it. Anything that does not match is skipped rather than guessed at.

export interface Release {
  version: string;
  date: string;
}

/**
 * release-please's own two heading shapes, and nothing else.
 *
 *   `## [1.12.0](https://github.com/.../compare/...) (2026-09-11)`  -- every release
 *   `## 1.0.0 (2026-09-01)`                                         -- the first one, unlinked
 *
 * `##` and not `###`: the section headings inside a release ("### Features",
 * "### Bug Fixes") are one level deeper, and the `\s` after the second `#` is
 * what excludes them.
 */
const HEADING = /^##[ \t]+(?:\[([^\]]+)\]\([^)]*\)|([^\s[]+))[ \t]+\((\d{4}-\d{2}-\d{2})\)[ \t]*$/;

/** The most recent releases, newest first -- the order release-please writes them in. */
export function recentReleases(changelog: string, limit = 5): Release[] {
  const releases: Release[] = [];
  for (const line of changelog.split('\n')) {
    if (releases.length >= limit) break;
    const match = HEADING.exec(line.trimEnd());
    if (match === null) continue;
    const version = match[1] ?? match[2];
    const date = match[3];
    if (version === undefined || date === undefined) continue;
    releases.push({ version, date });
  }
  return releases;
}
