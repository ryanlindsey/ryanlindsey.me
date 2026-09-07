// Pure half of /resume.json's own transform (day 3 Task 3, carried forward
// by Task 13). Extracted out of src/pages/resume.json.ts rather than kept
// inline: that route also imports `getResume`
// (src/lib/resume-collection.ts), which resolves `astro:content` and can
// only run inside Astro's own build/dev pipeline -- not from a plain
// `vitest run` process. Living here, with no value import at all, is what
// lets tests/resume.test.ts unit-test this function directly against a
// synthetic fixture, the same "pure lib, thin route" split
// src/lib/resume.ts, markdown-export.ts, llms-index.ts and feeds.ts already
// use, and for the same reason.
//
// Deferred from Task 3 (progress.md's Task 3 entry, "SHOULD FIX BEFORE
// MERGE"): no work entry populates `x_artifacts` today, so the pre-existing
// HTTP-level assertion in tests/resume.test.ts ("/resume.json ... has no
// x_-prefixed key at any depth") passed VACUOUSLY -- it proved there was
// nothing to strip, not that stripping works. This export plus its unit
// test in tests/resume.test.ts closes that gap with a synthetic nested `x_`
// fixture the real résumé data will never happen to provide on its own.

/**
 * Strips every `x_`-prefixed key, at any depth, from an arbitrarily nested
 * JSON-compatible value. `x_artifacts` is this site's own extension (see
 * content.config.ts) and a consumer validating against the JSON Resume
 * schema should never meet it -- stripping by prefix rather than naming
 * `x_artifacts` explicitly means a future `x_`-prefixed extension is handled
 * here without anyone having to remember to edit this file.
 */
export function stripXKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripXKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith('x_'))
        .map(([key, entryValue]) => [key, stripXKeys(entryValue)]),
    );
  }
  return value;
}
