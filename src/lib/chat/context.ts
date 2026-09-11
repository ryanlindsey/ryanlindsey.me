import type { Citation } from '../mcp/search';
import { fenceFor } from '../fence';

// The grounded half of 04 §1. PURE: retrieved citations in, prompt text out,
// plus the arithmetic that decides which `[n]` in an answer means anything.
//
// WHY NUMBERS AND NOT URLS. The fit engine validates a finished document and
// can drop a citation whose URL is not in `allowedUrls`. A stream cannot be
// retracted -- by the time an invented URL is on screen it has been read -- so
// chat's equivalent guarantee has to be structural rather than corrective.
//
// THE GUARANTEE IS NOT THAT THE MODEL HAS NO URLS. It has one per source:
// `renderChatContext` below emits a `Source:` line carrying the real URL, for
// provenance, and `startAnswer` puts that block verbatim into the user message.
// This comment claimed the opposite until 2026-09-11, and the claim had already
// been copied into the published risk register before anyone checked it against
// the function twenty lines down.
//
// What holds instead: the citation CHANNEL is numbers. The model is told never
// to cite a URL, and -- the structural half -- the reader's page builds every
// link by looking a cited number up in the list the server sent, and inserts the
// answer as a text node with no markdown pass over it. So a steered model can
// type a URL into its prose and still produce no link to anywhere, and an
// invented `[9]` against four sources resolves to nothing, renders as plain
// text, and is counted.
//
// The reader's page owns the link. That is the second half of the same
// property: nothing the model emits is ever interpolated into an `href`.

export interface ChatSource extends Citation {
  /** 1-based, and the only handle the model is given. */
  n: number;
  /** What the source is called on screen. The slug today; a title when one is cheap. */
  title: string;
}

/**
 * How much retrieved text one message may carry.
 *
 * A fifth of the fit engine's budget, and deliberately so: fit compares a whole
 * description against the whole corpus once, at Opus prices, while chat answers
 * a question per turn at Sonnet's -- and a chat answer grounded in eight
 * passages is better than one grounded in forty, because the model spends its
 * attention on the passages that matched rather than on the corpus.
 */
export const CHAT_CONTEXT_CHAR_BUDGET = 24_000;

/** How many passages retrieval asks Vectorize for. */
export const CHAT_TOP_K = 8;

export function numberSources(citations: readonly Citation[]): ChatSource[] {
  return citations.map((citation, index) => ({
    ...citation,
    n: index + 1,
    title: citation.slug,
  }));
}

/**
 * The fence long enough to enclose `text` whole.
 *
 * The same rule and the same reason as `fenceFor` in src/lib/fit/engine.ts: a
 * fixed three-backtick fence is a suggestion rather than a boundary, because
 * CommonMark closes a block at the first fence at least as long as the opener.
 * Here the fenced text is Ryan's own published writing rather than a stranger's
 * paste -- but this site's writing is ABOUT prompts and agents and contains
 * fenced code as a matter of course, so the case that breaks a fixed fence is
 * the ordinary one rather than the adversarial one.
 */

/**
 * The `# Sources` block, and exactly which sources survived into it.
 *
 * WHOLE PASSAGES ONLY, same rule as the fit engine's `renderContext`: a passage
 * cut in half lets the model cite a number for text whose ending it never saw.
 * A dropped source loses its number as well as its text -- `included` is what
 * the caller must send to the client and store on the transcript, so a number
 * the model never saw can never be a valid citation.
 */
export function renderChatContext(
  sources: readonly ChatSource[],
  budget: number = CHAT_CONTEXT_CHAR_BUDGET,
): { text: string; included: ChatSource[]; truncated: boolean } {
  if (sources.length === 0) {
    return { text: 'There are no sources for this question.', included: [], truncated: false };
  }

  const parts: string[] = [];
  const included: ChatSource[] = [];
  let used = 0;
  let truncated = false;

  for (const source of sources) {
    const fence = fenceFor(source.excerpt);
    // `exact: false` means the index and the published document have drifted and
    // the excerpt is the document's opening rather than the matched passage
    // (see `excerptFor` in src/lib/mcp/search.ts). The model is told, because a
    // model that quotes an opening as "the passage that matched" is making a
    // specific claim nobody made.
    const provenance = source.exact
      ? ''
      : '\nNote: this is the opening of the document, not the matched passage.';
    const rendered = `## [${source.n}] ${source.title}\nSource: ${source.url}${provenance}\n\n${fence}markdown\n${source.excerpt}\n${fence}\n`;
    const separator = parts.length > 0 ? 1 : 0;
    if (used + separator + rendered.length > budget) {
      truncated = true;
      continue;
    }
    parts.push(rendered);
    included.push(source);
    used += separator + rendered.length;
  }

  return { text: parts.join('\n'), included, truncated };
}

/**
 * Which numbers an answer cited, and which of them mean nothing.
 *
 * `invalid` is the fabrication signal (`chat_turns.invalid_citations`), and it
 * is counted rather than corrected for the reason at the top of this file: the
 * text is already on the reader's screen. What the client does with it is
 * render the number as plain text instead of a link, so the worst outcome is a
 * bracketed number that goes nowhere rather than a link to the wrong document.
 *
 * `sourceCount` must be the length of the INCLUDED list rather than of
 * everything retrieved -- see `startAnswer`'s return value in ./engine.ts.
 * Passing the retrieved count would score a citation to a budget-dropped source
 * as valid, which is the one thing this function exists to catch.
 */
export function citationsIn(
  answer: string,
  sourceCount: number,
): { cited: number[]; invalid: number[] } {
  const cited: number[] = [];
  const invalid: number[] = [];
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(match[1]);
    const bucket = n >= 1 && n <= sourceCount ? cited : invalid;
    if (!bucket.includes(n)) bucket.push(n);
  }
  return { cited, invalid };
}
