// The private tier's read side (03 §3, 09 §1) -- and the reason 09 §3's
// "public code paths CANNOT reach gated data (partition, not filter)" is a
// structural claim here rather than a discipline.
//
// The partition is two R2 buckets. `ryanlindsey-me-assets` holds what the
// site publishes; `ryanlindsey-me-private` holds what a grant unlocks. This
// module is the only reader of the second one, and the public document layer
// (src/lib/mcp/documents.ts) declares an env interface -- `DocumentsEnv` --
// that does not name `R2_PRIVATE` at all. So a public tool cannot leak a
// private document by forgetting a filter: it has no reference to the bucket.
// tests/tier-private-docs.test.ts asserts that at the type level.
//
// Nothing here knows what any of these documents MEAN. They are markdown at
// keys, and the meaning is supplied by whoever writes them -- which is 09 §2's
// rule ("audience-specific meaning arrives only via runtime data") applied to
// storage.

export interface PrivateDocsEnv {
  R2_PRIVATE: R2Bucket;
}

/**
 * The fixed keys the three profile tools read.
 *
 * Fixed rather than parameterised because there is exactly one of each, and a
 * tool that took a key argument would be a general-purpose read primitive on
 * the private bucket -- which is precisely the shape this partition exists to
 * avoid handing to a caller.
 */
export const PROFILE_KEYS = {
  availability: 'profile/availability.md',
  references: 'profile/references.md',
  compensation: 'profile/compensation.md',
} as const;

/**
 * One path segment: letters, digits, hyphens, underscores and dots, but never
 * a leading dot and never `.` or `..` entire.
 *
 * Rejecting rather than sanitising, deliberately: a sanitiser turns a hostile
 * input into a plausible key and reads SOMETHING, and "which document did that
 * actually open?" is then a question the audit trail cannot answer. A refusal
 * is legible.
 *
 * Percent-encoding is refused along with everything else by the character
 * class -- `%` is not in it -- so a caller cannot smuggle a slash past this
 * and rely on some later layer decoding it.
 */
function safeSegment(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..')
  );
}

/** The unredacted layer of one case study, or `null` for a slug that is not a slug. */
export function caseStudyDetailKey(slug: string): string | null {
  return safeSegment(slug) ? `case-study/${slug}.md` : null;
}

/**
 * The narrative document for one audience, or `null`.
 *
 * The audience comes from a SIGNED claim, so it cannot be edited by the
 * holder -- but it is still checked, because the value is typed by hand into
 * a mint command and a stray slash there would silently create a key in a
 * directory nobody deploys to. Failing at key construction turns that into
 * "no document", which is what the tool already knows how to say.
 */
export function narrativeKey(audience: string): string | null {
  return safeSegment(audience) ? `narrative/${audience}.md` : null;
}

/**
 * One document, or `null` if it is not there.
 *
 * `null` rather than a throw for a miss: a private tier whose documents are
 * deployed separately (scripts/private-doc.mjs, run from the private repo)
 * will routinely have a key that has not been written yet, and that is an
 * ordinary state for a tool to report rather than an error to log.
 */
export async function readPrivateDoc(env: PrivateDocsEnv, key: string): Promise<string | null> {
  const object = await env.R2_PRIVATE.get(key);
  return object === null ? null : object.text();
}
