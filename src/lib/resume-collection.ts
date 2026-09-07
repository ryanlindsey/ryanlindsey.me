import { getCollection } from 'astro:content';
import type { Resume } from './resume';

// Impure half of the résumé data model (day 3, 02 §1) -- see the header of
// `src/lib/resume.ts` for why this is a separate file. `astro:content` only
// resolves inside Astro's own build/dev pipeline, so this module cannot be
// imported from a plain `vitest run` process; its one piece of logic (the
// exactly-one-entry guard below) is exercised at the HTTP level in Task 2,
// once `/resume` calls this for real.

/**
 * Thrown when the `resume` collection does not contain exactly one entry.
 * Two résumé files silently rendering the first is exactly the class of bug
 * day 2 kept finding.
 */
export class ResumeCollectionError extends Error {
  constructor(count: number) {
    super(`expected exactly one resume entry, found ${count}`);
    this.name = 'ResumeCollectionError';
  }
}

/**
 * Reads the résumé data. Thin by design: a collection read, the
 * exactly-one-entry guard, and nothing else -- every other rule about what
 * makes a résumé valid or complete lives in the pure functions in
 * `src/lib/resume.ts`, where it can actually be unit-tested.
 */
export async function getResume(): Promise<Resume> {
  const entries = await getCollection('resume');
  if (entries.length !== 1) {
    throw new ResumeCollectionError(entries.length);
  }
  return entries[0].data;
}
