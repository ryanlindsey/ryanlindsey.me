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
  documents: number;
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
 */
export function renderContext(
  blocks: CorpusBlock[],
  budget: number = CONTEXT_CHAR_BUDGET,
): { text: string; truncated: boolean } {
  if (blocks.length === 0) {
    return { text: 'There are no documents in the corpus.', truncated: false };
  }

  const parts: string[] = [];
  let used = 0;
  let truncated = false;

  for (const block of blocks) {
    const rendered = `## ${block.title}\nSource: ${block.url}\n\n\`\`\`markdown\n${block.markdown}\n\`\`\`\n`;
    if (used + rendered.length > budget) {
      truncated = true;
      continue;
    }
    parts.push(rendered);
    used += rendered.length;
  }

  return { text: parts.join('\n'), truncated };
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

  const { text, truncated } = renderContext(blocks, budget);
  // A DROPPED document must lose its citation licence too, or the model could
  // cite a URL for a document that is not in front of it. Recomputed from
  // what was actually rendered rather than from what was fetched.
  const rendered = new Set([...allowedUrls].filter((url) => text.includes(url)));

  return { text, allowedUrls: rendered, documents: rendered.size, truncated };
}
