import { CORPUS_EMBEDDING_MODEL, chunkMarkdown, type CorpusType } from '../corpus';

// Task 9 (Day 4 §3): the pure half of `search_writing` -- everything about a
// cited excerpt that can be decided without a binding, an index or a network
// call. The Worker wiring (the Vectorize query, the manifest read, the
// document fetches) lives in workers/mcp/src/tools.ts; this module is what
// tests/mcp-search.test.ts can exercise with nothing bound at all.
//
// WHY EXCERPTS ARE REBUILT RATHER THAN STORED. A Vectorize vector's metadata
// is exactly `{ tier, type }` (src/lib/corpus.ts's `metadataFor`, and day 3
// created the metadata indexes before any vector existed because Vectorize
// does not backfill them). Putting the chunk's text on the vector would mean a
// metadata-shape change, a `CORPUS_CONTRACT_VERSION` bump and a full re-embed
// of the corpus -- and metadata is truncated at 64 bytes for indexed string
// properties anyway. So the excerpt is reconstructed on read by re-chunking
// the cited document with the SAME pure `chunkMarkdown` that produced the
// vectors, and the manifest's `chunks` count is the check that the
// reconstruction still lines up.

/** A retrieved passage, and everything a caller needs to verify it themselves. */
export interface Citation {
  type: CorpusType;
  slug: string;
  /** The chunk index within the document -- the `<n>` of the vector's id. */
  chunk: number;
  /** The page the document is published at, so the claim can be checked at source. */
  url: string;
  score: number;
  excerpt: string;
}

/**
 * A chunk id, `<type>:<slug>:<n>`, as `chunkId` in src/lib/corpus.ts builds it.
 *
 * ANCHORED ON THE LAST SEGMENT, not split naively on `:`. The id is made by
 * string concatenation and nothing in the pipeline forbids a colon in a slug,
 * so a `.split(':')` reading of `post:a:b:3` would hand back slug `a` and
 * chunk `b` -- a well-formed-looking parse of the wrong document. The greedy
 * middle group plus the `$`-anchored digits makes the index the last segment
 * by construction.
 *
 * The type alternation is spelled out rather than accepted as any word, so an
 * id from some future namespace is REJECTED rather than parsed into a
 * `CorpusType` the rest of the code then trusts.
 */
const CHUNK_ID = /^(post|case-study|resume):(.+):(\d+)$/;

/**
 * The document and chunk a vector id names, or `null` if the id is not one
 * this corpus writes.
 *
 * `null` rather than a throw or a guess: an unrecognised id is a stale or
 * foreign vector, and the tool should drop that match and answer with the rest
 * rather than fail a whole search over it.
 */
export function parseChunkId(id: string): { type: CorpusType; slug: string; chunk: number } | null {
  const match = CHUNK_ID.exec(id);
  if (!match) return null;
  const [, type = '', slug = '', chunk = ''] = match;
  return { type: type as CorpusType, slug, chunk: Number(chunk) };
}

/**
 * What to pass as `expectedChunks` when the manifest has no entry for the
 * document at all. Negative, so it can never equal a real chunk count and the
 * excerpt degrades to inexact instead of being accepted unchecked.
 */
export const UNKNOWN_CHUNK_COUNT = -1;

/**
 * The text that produced vector `chunk` of this document, rebuilt by
 * re-chunking `markdown` exactly as the embedding job did.
 *
 * `chunkMarkdown` is called with its default `MAX_CHUNK_TOKENS`, which is the
 * same call `refreshCorpus` makes -- passing a different size here would
 * produce different boundaries and therefore a different passage under the
 * same chunk number.
 *
 * `exact` is the honesty flag, and it is the reason this function exists
 * rather than the two-line version. If `chunkMarkdown` ever changes without a
 * re-embed, or the document has been edited since it was embedded, chunk N of
 * the re-chunked document is no longer the text that produced vector N -- and
 * the failure mode is the dangerous one: a citation carrying real prose from a
 * real document that does not contain what was matched. The manifest's
 * `chunks` count is what makes that detectable at all, so a count mismatch
 * (or an index the re-chunked document does not have) returns the document's
 * FIRST chunk with `exact: false`: still text from the cited document, still
 * under the document's own URL, but the tool has degraded to "here is the
 * document" rather than claiming "here is the passage".
 */
export function excerptFor(
  markdown: string,
  chunk: number,
  expectedChunks: number,
): { text: string; exact: boolean } {
  const chunks = chunkMarkdown(markdown);
  const lead = chunks[0] ?? '';
  if (chunks.length !== expectedChunks) return { text: lead, exact: false };
  const text = chunks[chunk];
  if (text === undefined) return { text: lead, exact: false };
  return { text, exact: true };
}

/**
 * The query's embedding, QUERY-SIDE.
 *
 * `{ queries: [...] }` and nothing else, and this is the one call in day 4
 * where a plausible-looking mistake degrades retrieval silently and forever.
 * Measured day 3 against this account and recorded in workers/mcp/wrangler.jsonc:
 *
 * - `queries` is PLURAL and is the model's actual schema key. Singular `query`
 *   is not a key at all and answers `3030: invalid input`.
 * - The query side wraps its input in an instruction template (24 prompt
 *   tokens against the document side's 5), so the same string embedded as a
 *   DOCUMENT lands cosine 0.717 away from where it belongs. The corpus was
 *   embedded document-side and bare, so a query embedded document-side
 *   retrieves worse results while erroring not at all.
 * - `queries` and `documents` in one call also error 3030.
 *
 * No `instruction`: the corpus was embedded with the model's default template
 * on the document side, and customising the query template is a retrieval-quality
 * change that should be measured against the live index rather than assumed.
 *
 * No width check either, unlike `embedChunks` in src/lib/corpus.ts. That check
 * exists because Vectorize cannot be resized and a bad upsert is permanent;
 * here the vector goes straight into `VECTORIZE.query`, which rejects a
 * wrong-width vector itself, so a second check would only duplicate a loud
 * failure.
 */
export async function embedQuery(ai: Ai, query: string): Promise<number[]> {
  const result = await ai.run(CORPUS_EMBEDDING_MODEL, { queries: [query] });
  const vector = result.data?.[0];
  if (vector === undefined) {
    throw new Error('mcp/search: the embedding model returned no vector for the query');
  }
  return vector;
}
