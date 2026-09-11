/**
 * The fence that separates untrusted text from instructions, computed rather
 * than assumed.
 *
 * WHY THIS FILE EXISTS, and it is not tidiness. This function was copied into
 * four modules -- the fit engine, the chat engine, the chat context builder and
 * the judge -- and the fifth place that needed it, `buildCorpusContext`, got a
 * hard-coded three-backtick literal instead. That is not a coincidence: a
 * helper that lives in one feature's file is something the next feature copies
 * or reinvents, and reinventing this one means writing ``` and moving on.
 *
 * WHAT A FIXED FENCE COSTS. CommonMark closes a fenced block at the first fence
 * at least as long as the one that opened it. So a document containing its own
 * ``` run closes the wrapper early, and everything after it lands outside the
 * fence -- in the position where instructions live, in a prompt whose system
 * text says fenced content is data. MEASURED 2026-09-11: the published post
 * `terminal-setup.mdx` contains 14 fenced blocks, so every fit run over the
 * corpus was sending most of it outside the boundary.
 *
 * Opening with one more backtick than the longest run inside is CommonMark's
 * own answer, and the minimum of three keeps the ordinary case looking like
 * ordinary markdown.
 *
 * WHAT THIS DOES NOT DO: it does not make a prompt injection-proof. It makes
 * the data/instruction boundary hold for content that does not get to choose
 * its own fence, which is every source this repo feeds a model.
 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}
