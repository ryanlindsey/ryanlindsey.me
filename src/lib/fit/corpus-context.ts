// The corpus, as the fit engine sees it (03 §4: "with the full corpus as
// context").
//
// NO RETRIEVAL. The published corpus is a résumé, a handful of case studies
// and a handful of posts -- small enough to send whole, and sending it whole
// removes an entire failure mode: a retrieval step that misses the one
// document a requirement depended on produces a confidently wrong "no
// evidence" gap, which is worse than a slower call. Revisit when the corpus
// outgrows the budget below, and revisit by measuring rather than by feel.
//
// PUBLIC DOCUMENTS ONLY, and that is a design constraint rather than a
// simplification: every claim in a report has to cite a URL a reader can open
// (03 §4), and a private-tier document has no such URL. The private tier is
// reached by its own tools, not by grounding.

import { fetchDocument, fetchDocumentIndex, pageUrlFor, type DocumentsEnv } from '../mcp/documents';

/**
 * How much corpus text one call may carry.
 *
 * Chosen against the model's context rather than against the corpus: 120k
 * characters is roughly 30k tokens by this repo's own estimator
 * (`CHARS_PER_TOKEN` in src/lib/corpus.ts), which leaves the prompt, the
 * target description and a 4k-token report comfortably inside a 200k window.
 * The live corpus is a small fraction of it today, so this is a ceiling that
 * has not yet been approached -- which is exactly when to write one down.
 */
export const CONTEXT_CHAR_BUDGET = 120_000;

export interface CorpusBlock {
  url: string;
  title: string;
  markdown: string;
}

export interface CorpusContext {
  text: string;
  /** Exactly the URLs a citation may name. `enforceCitations` takes this set. */
  allowedUrls: Set<string>;
  /**
   * How many documents survived into `text` -- after the budget drops any,
   * not how many `/llms.txt` listed or how many fetched successfully. Equal
   * to `allowedUrls.size`. Fix round 1, finding 3: the ordinary happy-path
   * and skip-path tests never distinguish this from the fetched count, only
   * a budget-drop case does.
   */
  documents: number;
  /** True when the budget forced at least one whole document out of `text`; never true because a document merely failed to fetch. */
  truncated: boolean;
}

/**
 * Renders blocks into one fenced, source-labelled string.
 *
 * WHOLE DOCUMENTS ONLY. A block that does not fit is dropped, never cut: half
 * a document would let the model cite a URL for a passage whose ending it
 * never saw, and that citation would pass validation because the URL is real.
 * A missing document produces an honest gap; a truncated one produces a
 * confident error.
 *
 * The fences are a prompt-injection boundary as much as a formatting choice.
 * Corpus text is Ryan's own, but the same renderer's shape is what the target
 * description gets in ./engine.ts, and there the text is a stranger's.
 *
 * Also returns `includedUrls` -- exactly the `block.url` of every block this
 * call kept, recorded in the same loop that decides what to keep. Fix round
 * 1, finding 1: `buildCorpusContext` used to recompute its citation set by
 * searching the returned `text` for each candidate URL, and that is unsound
 * -- a KEPT document's own markdown can contain a link to a DROPPED
 * document's URL (an ordinary thing for a résumé or case study to do), which
 * would make the URL appear as a substring of `text` even though the model
 * was never shown that document. Reporting membership from the loop that
 * decided it is precise in a way searching the output never can be.
 */
export function renderContext(
  blocks: CorpusBlock[],
  budget: number = CONTEXT_CHAR_BUDGET,
): { text: string; truncated: boolean; includedUrls: Set<string> } {
  if (blocks.length === 0) {
    return {
      text: 'There are no documents in the corpus.',
      truncated: false,
      includedUrls: new Set(),
    };
  }

  const parts: string[] = [];
  const includedUrls = new Set<string>();
  let used = 0;
  let truncated = false;

  for (const block of blocks) {
    const rendered = `## ${block.title}\nSource: ${block.url}\n\n\`\`\`markdown\n${block.markdown}\n\`\`\`\n`;
    // The returned text is `parts.join('\n')`, which inserts one '\n'
    // between this block and the previous one -- charged here, before
    // deciding whether the block fits, so `used` never undercounts the
    // actual text.length by parts.length - 1 (fix round 1, finding 4). The
    // first included block pays no separator.
    const separator = parts.length > 0 ? 1 : 0;
    if (used + separator + rendered.length > budget) {
      truncated = true;
      continue;
    }
    parts.push(rendered);
    includedUrls.add(block.url);
    used += separator + rendered.length;
  }

  return { text: parts.join('\n'), truncated, includedUrls };
}

/**
 * Every published document, plus the set of URLs a citation may name.
 *
 * The index is `/llms.txt` -- the same one every content tool reads -- so
 * "published" means exactly what a reader is served, drafts already filtered
 * out by the generator rather than by a second rule here.
 *
 * A document the index lists but that will not fetch is SKIPPED rather than
 * fatal, matching `listDocuments` in workers/mcp/src/tools.ts: a broken deploy
 * should narrow the evidence available, not refuse to produce a report.
 *
 * `budget` is optional and defaults to `CONTEXT_CHAR_BUDGET` -- it exists so
 * tests/fit-context.test.ts can force a shortfall and assert that the
 * document the budget drops also loses its place in `allowedUrls`.
 * Production code never passes it; this is not a per-call tuning knob.
 */
export async function buildCorpusContext(
  env: DocumentsEnv,
  budget: number = CONTEXT_CHAR_BUDGET,
): Promise<CorpusContext> {
  const index = await fetchDocumentIndex(env);
  const blocks: CorpusBlock[] = [];
  const allowedUrls = new Set<string>();

  for (const source of index) {
    const markdown = await fetchDocument(env, source);
    if (markdown === null) continue;
    const url = pageUrlFor(source, env.SITE_ORIGIN);
    blocks.push({ url, title: source.slug, markdown });
    allowedUrls.add(url);
  }

  const { text, truncated, includedUrls } = renderContext(blocks, budget);
  // A DROPPED document must lose its citation licence too, or the model could
  // cite a URL for a document that is not in front of it. Intersected against
  // `includedUrls` -- the membership `renderContext` itself decided, in its
  // own loop -- rather than by searching `text` for each fetched URL (fix
  // round 1, finding 1: that search was unsound, because a kept document's
  // own markdown can link to a dropped document's URL and reappear as a
  // substring of `text` even though the model never saw that document).
  const rendered = new Set([...allowedUrls].filter((url) => includedUrls.has(url)));

  return { text, allowedUrls: rendered, documents: rendered.size, truncated };
}
