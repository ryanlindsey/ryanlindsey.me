import { getCollection } from 'astro:content';

// Reader for the home page's Now strip (2026-09 redesign, issue #103).
// Modelled on src/lib/resume-collection.ts, including why it is a separate
// file from anything pure: `astro:content` only resolves inside Astro's own
// build/dev pipeline, so this module cannot be imported from a plain
// `vitest run` process. Its one piece of logic is exercised at the HTTP level
// by tests/pages.test.ts's Now strip assertions.
//
// The copy itself lives in src/content/now/now.yaml and is expected to go
// stale and be edited often. See that file's header.

/**
 * Thrown when the `now` collection does not contain exactly one entry.
 *
 * The same guard `getResume()` carries, for the same reason: two files
 * silently rendering the first is the class of bug that is invisible until
 * someone notices the site has been advertising last quarter's work for a
 * month. There is one Now line.
 */
export class NowCollectionError extends Error {
  constructor(count: number) {
    super(`expected exactly one now entry, found ${count}`);
    this.name = 'NowCollectionError';
  }
}

/**
 * The Now strip's clauses, in the order the file lists them. Joining them is
 * the template's job, not this function's -- the separator is a design
 * decision (a middot, per the handoff) rather than a property of the content.
 */
export async function getNowItems(): Promise<string[]> {
  const entries = await getCollection('now');
  if (entries.length !== 1) {
    throw new NowCollectionError(entries.length);
  }
  return entries[0].data.items;
}
