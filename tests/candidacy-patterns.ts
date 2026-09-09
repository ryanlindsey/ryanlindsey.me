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
  // Added Day 5 Task 16 (the candidate-mode audit): this repo's own term of
  // art for the thing the whole private tier exists to keep off the public
  // surface, and nothing above already catches it -- `candidates?` matches
  // neither "candidacy" nor "candidacies" (no trailing `s` or `es`). Checked
  // before adding, not assumed: against every file `SCAN_ROOTS` covers, this
  // pattern hits only workers/mcp/src/server.ts, which `SCAN_EXCEPTIONS`
  // already excuses for the same reason ("Candidacy-language discipline"
  // sits inside the very comment that enumerates the forbidden vocabulary in
  // order to forbid it). tests/candidacy-patterns.ts's own filename and this
  // comment are unreachable by the static scan (`tests/` is outside
  // `SCAN_ROOTS`, by design -- see that constant's doc comment), and
  // evals/cases/tier/invisibility.json's mirrored `banned_patterns` array
  // carries the pattern SOURCES as escaped strings ("\\bcandidac(y|ies)\\b"),
  // which contains no literal "candidacy" substring for this pattern to catch.
  /\bcandidac(y|ies)\b/i,
];

/**
 * What the static candidacy scan reads (tests/tier-invisibility.test.ts).
 *
 * `tests/` is deliberately absent: this file itself enumerates the forbidden
 * vocabulary, and a scan that read its own pattern list would be permanently
 * red. Test files are also not shipped, and every surface that IS shipped is
 * covered here or by a runtime scan of the real response.
 *
 * `CHANGELOG.md` (fix round 1, finding 6) is the one entry added after the
 * others, and for a different reason than any of them: it is GENERATED, by
 * release-please, from squash-merged PR titles -- a channel no human reviews
 * line by line the way a PR body or a code comment gets read. Clean today,
 * which is exactly the day to start scanning a surface whose whole point is
 * that its content arrives through someone else's typing.
 */
export const SCAN_ROOTS = [
  'src',
  'workers',
  'prompts',
  'evals',
  'scripts',
  'public',
  'migrations',
  'README.md',
  'CHANGELOG.md',
];

/**
 * Files that legitimately match a banned pattern, and why.
 *
 * A REGISTER, not a suppression list, and the test asserts EQUALITY against it
 * -- a new match fails, and so does an entry whose cause has been removed.
 * Adding to it is a deliberate act with a reason attached, which is the whole
 * difference between an exception and a hole.
 */
export const SCAN_EXCEPTIONS: Record<string, string> = {
  'src/lib/corpus.ts':
    'The chunker names a local variable `candidate` -- ordinary programming English for "the value under consideration", with no candidacy sense. Renaming it to satisfy a regex would make the code worse to read in exchange for nothing.',
  'workers/mcp/src/server.ts':
    'The instructions comment ENUMERATES the forbidden vocabulary in order to forbid it (09 §2). A rule that cannot name what it prohibits cannot be read by the next person to edit that string.',
};
