/**
 * The candidacy-language banned-pattern list (09 §2), defined exactly once so
 * every surface this repo checks -- the HTTP routes in tests/pages.test.ts and
 * the JSON-RPC/MCP surface in tests/mcp-tools.test.ts -- share the same list
 * rather than each hand-typing its own copy that could silently drift from
 * the other. Day 1's ruling (recorded in the plan's global constraints)
 * governs the shape: word-boundary, inflection-aware regexes over sanctioned
 * text, with no target names -- this repo is public, and the check must never
 * enumerate forbidden vocabulary into a file that ships publicly.
 *
 * Naive substrings ("hire", bare "candidate") both miss real leaks
 * ("candidates", "recruitment") and catch false positives ("Yorkshire",
 * "Cheshire", "Hampshire" all contain "hire"). "looking for" is dropped --
 * too generic ("looking for the source?") and a check that cries wolf gets
 * weakened by whoever trips it next. "open to work" is added -- it's
 * LinkedIn's own badge text and the single most canonical public candidacy
 * signal.
 *
 * NOT included, on the same "too generic" reasoning as "looking for": Task
 * 10's original inline copy of this check (tests/mcp-tools.test.ts, before
 * this list was unified) also banned `/\bavailab(le|ility) for\b/i`
 * ("available for" / "availability for"). Deliberately dropped rather than
 * carried forward when the two lists were unified (Day 4 Task 15 fix round):
 * every other pattern here has one fixed idiomatic reading, but "available
 * for ___" does not -- "available for hire" is a leak, while "available for
 * download", "available for review" and "available for reference" are
 * ordinary technical-writing phrases this site's own case studies and posts
 * are exactly the kind of content to use for something that has nothing to do
 * with candidacy. The one case that actually matters, "available for hire",
 * is already caught by `hir(e|es|ed|ing)` above without that added risk --
 * this pattern's only unique catch would be a phrase like "available for new
 * opportunities" that names no other banned word, which is a narrower, real
 * gap this list accepts in exchange for not crying wolf on generic prose.
 *
 * This lives in its own module rather than inside tests/pages.test.ts (where
 * it was first written) because a `.test.ts` file's `beforeAll`/`test()` calls
 * all run again for whichever suite imports it -- MEASURED (Day 4 Task 15):
 * `tests/mcp-tools.test.ts` runs 37 tests standalone; importing this constant
 * straight from `tests/pages.test.ts` made it run 80 (its own 37, plus all 43
 * of pages.test.ts's tests re-registered under mcp-tools.test.ts, plus a
 * second, redundant site+MCP harness boot alongside its own). tests/workers.ts
 * is this repo's existing precedent for a shared, non-`.test.ts` module in
 * this directory for exactly this reason -- vitest.config.ts only collects
 * `tests/**\/*.test.ts` as suites, so this file is inert to import.
 */
export const BANNED_PATTERNS = [
  /\bhir(e|es|ed|ing)\b/i,
  /\bcandidates?\b/i,
  /\brecruit(er|ers|ing|ment)?\b/i,
  /\bjob[-\s]?search(es|ing)?\b/i,
  /\bactively looking\b/i,
  /\bopen to (work|opportunities|offers)\b/i,
];
