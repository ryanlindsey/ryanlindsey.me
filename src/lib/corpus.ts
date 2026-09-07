import { SITE_ORIGIN } from './markdown-export';

// Day 3 Task 15 (01 §4): the publishing corpus's embedding job -- chunk every
// published document, embed the chunks with Workers AI, and upsert them into
// the `ryanlindsey-me-corpus` Vectorize index created in Task 14.
//
// WHERE THE TEXT COMES FROM, and why it is not `getCollection`. This module is
// imported by src/worker.ts, which the Cloudflare Vite plugin builds as the
// Worker ENTRY rather than as part of Astro's SSR graph -- `astro:content` is
// an Astro-only virtual module and does not resolve there. src/lib/resume-pdf.ts
// hit the same wall in Task 5 and answered it with a `?raw` import of the
// résumé source. That answer does not generalise: a `?raw` MDX body is
// unrendered, unstripped and still carries `draft: true`, so reusing it here
// would mean re-implementing frontmatter parsing, the draft filter and MDX
// stripping inside the Worker -- three second sources of truth for rules that
// already exist and are already tested.
//
// Instead this job reads the PRERENDERED `.md` assets through the `ASSETS`
// binding, which is the same "reuse, not re-derivation" move src/worker.ts's
// Task 8 negotiation already makes for the same files. Those assets are the
// output of Task 6's `toMarkdown` via Task 7's `.md` routes, so:
//
//   - the exporter runs exactly once, at build time;
//   - `toMarkdown`'s throw on unstrippable MDX fails the BUILD (it is not
//     caught anywhere -- see src/lib/llms-index.ts's note), so a corrupted
//     document can never reach an embedding in the first place;
//   - and the set of documents comes from `/llms.txt`, which is the site's
//     own published index and already applies the `!data.draft` aggregation
//     filter. Unpublishing a post removes it from `/llms.txt` on the next
//     build, and the refresh below then deletes its vectors.
//
// The corpus is therefore never able to contain something the site does not
// publish, without this module holding an opinion about drafts at all.

/**
 * Bump when chunking, the embedding model, or the metadata shape changes in a
 * way that should re-embed identical source text. Folded into every document
 * hash below, exactly like `RESUME_PDF_CONTRACT_VERSION` -- the manifest
 * short-circuit is otherwise indistinguishable from "nothing to do", and a
 * chunker change would silently never reach the index.
 */
export const CORPUS_CONTRACT_VERSION = 1;

/** KV key holding the manifest. The manifest write is the commit point. */
export const CORPUS_MANIFEST_KEY = 'corpus:manifest';

/**
 * Measured in Task 14 against this account and permanent for this index:
 * Vectorize has no resize. A model returning anything else is a loud failure
 * below rather than a partial upsert.
 */
export const CORPUS_DIMENSIONS = 1024;

export const CORPUS_EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b';

/**
 * Everything this job embeds is already served publicly, so `tier` is a
 * constant here. It is still written on every vector -- day 5's retrieval
 * filters on it, and a vector with no `tier` would be invisible to a filtered
 * query rather than merely unrestricted.
 *
 * String metadata indexes only cover the FIRST 64 BYTES of a value, so both
 * metadata values are short by construction. `assertShortMetadataValue` below
 * makes that a checked property rather than a habit.
 */
export const CORPUS_TIER = 'public';

/** Vectorize's string-metadata-index prefix limit. */
export const METADATA_INDEX_BYTE_LIMIT = 64;

export type CorpusType = 'post' | 'case-study' | 'resume';

// --- Chunk sizing -------------------------------------------------------
//
// qwen3-embedding-0.6b's documented input limit is 8,192 on its model page and
// 4,096 in the April 2026 changelog. The docs contradict each other and the
// conflict is unresolved, so the SMALLER reading is the one used here.
//
// The "Context Window" column is deliberately not used: `bge-base` advertises a
// context window of 153,600 alongside a maximum input of 512, so that figure
// measures something other than how much text one embedding call accepts, and
// sizing chunks off it would silently truncate every long document.

/** The smaller of the two documented input limits. Never exceeded, ever. */
export const MODEL_INPUT_TOKEN_LIMIT = 4096;

/** Target chunk size (01 §4 asks for roughly 1,000-1,500 tokens). */
export const MAX_CHUNK_TOKENS = 1500;

/**
 * Tokens are estimated from characters because there is no tokenizer in a
 * Worker and shipping one to count tokens for a job that embeds a handful of
 * documents a day is not a trade worth making.
 *
 * Four characters per token is the usual English-prose ratio and it is an
 * ESTIMATE, which is exactly why the target above sits at 1,500 rather than at
 * the limit: the estimate can be wrong by more than 2.5x in the dangerous
 * direction and a chunk still fits inside `MODEL_INPUT_TOKEN_LIMIT`. Headroom
 * is the point, not precision.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// --- What gets embedded -------------------------------------------------

/** One document to embed, and the prerendered asset its text is read from. */
export interface CorpusSource {
  type: CorpusType;
  slug: string;
  /** The `.md` asset path, e.g. `/writing/a-post.md`. */
  path: string;
}

/**
 * The résumé. Fixed rather than parsed out of `/llms.txt`, because
 * `/llms.txt`'s Resume section is a FORMAT MANIFEST -- four links to the same
 * document as HTML, Markdown, JSON and PDF (src/pages/llms.txt.ts) -- not a
 * list of documents. Parsing it would embed the résumé once per format.
 *
 * `slug` is `resume` because that is the path segment the site publishes it
 * under; there is exactly one résumé, so its type and its slug coincide. The
 * slug is derived from the public URL here for the same reason it is
 * everywhere else in this repo (`canonicalUrlFor`): the URL is a document's
 * identity, and a second identity sourced from a filename would drift.
 */
export const RESUME_SOURCE: CorpusSource = { type: 'resume', slug: 'resume', path: '/resume.md' };

/** `/writing/<slug>` holds posts, `/work/<slug>` holds case studies. */
const SECTION_TYPE: Record<string, CorpusType> = { writing: 'post', work: 'case-study' };

/** The `](href)` half of a markdown link. */
const MARKDOWN_LINK_HREF = /\]\(([^)\s]+)\)/g;

/** `/writing/<slug>.md` or `/work/<slug>.md`. */
const DOCUMENT_ASSET_PATH = /^\/(writing|work)\/(.+)\.md$/;

/**
 * The documents to embed, read out of the site's own `/llms.txt`.
 *
 * `/llms.txt` is the right input precisely because it is an AGGREGATION
 * surface: src/pages/llms.txt.ts filters `!data.draft` exactly as /writing and
 * /work's indexes do, and its Writing/Case studies links already point at the
 * `.md` form of each page rather than the HTML one (llms.txt v2's own
 * recommendation). So the draft rule this corpus must honour is inherited from
 * the file rather than restated here, where it would be a second place to
 * forget it.
 *
 * Both `.mdx` files in this repo are `draft: true` today, so today this
 * returns the résumé and nothing else. That is the correct answer, not a
 * degenerate one -- tests/corpus.test.ts covers a populated `/llms.txt` too,
 * because a function only ever exercised against an empty corpus is a function
 * nobody has tested.
 */
export function corpusSources(llmsTxt: string): CorpusSource[] {
  const sources: CorpusSource[] = [RESUME_SOURCE];
  const seen = new Set<string>([RESUME_SOURCE.path]);

  for (const match of llmsTxt.matchAll(MARKDOWN_LINK_HREF)) {
    const href = match[1];
    if (href === undefined) continue;
    let url: URL;
    try {
      url = new URL(href, SITE_ORIGIN);
    } catch {
      continue;
    }
    // `mcp.ryanlindsey.me` is a different origin and is not a document.
    if (url.origin !== SITE_ORIGIN) continue;
    const path = DOCUMENT_ASSET_PATH.exec(url.pathname);
    if (!path) continue;
    const [, section = '', slug = ''] = path;
    const type = SECTION_TYPE[section];
    if (!type || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    sources.push({ type, slug, path: url.pathname });
  }

  return sources;
}

/**
 * `<type>:<slug>` -- a document's stable address in the index, and the
 * manifest's key. Chunk ids extend it with `:<n>`, so a re-run of unchanged
 * content UPDATES the same vectors instead of appending a second copy.
 */
export function documentKey(source: CorpusSource): string {
  return `${source.type}:${source.slug}`;
}

export function chunkId(source: CorpusSource, index: number): string {
  return `${documentKey(source)}:${index}`;
}

/** The ids `key` expands to for a document that chunked into `count` pieces. */
export function chunkIdsFor(key: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${key}:${index}`);
}

/**
 * Exactly `{ tier, type }`, per 01 §4 and the metadata indexes Task 14 created
 * before any vector existed. Nothing else: Vectorize does not backfill a
 * metadata index, so a property added here later is unfilterable for every
 * vector already in the index.
 */
export function metadataFor(source: CorpusSource): { tier: string; type: CorpusType } {
  return { tier: CORPUS_TIER, type: source.type };
}

/**
 * Guards the 64-byte string-metadata-index prefix. Both values are short
 * constants today (`public`, and one of three literals), so this never fires --
 * it exists so that stops being true loudly rather than by producing vectors
 * that quietly fall out of a filtered query.
 */
export function assertShortMetadataValue(name: string, value: string): void {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > METADATA_INDEX_BYTE_LIMIT) {
    throw new Error(
      `corpus: metadata ${name}=${JSON.stringify(value)} is ${bytes} bytes; string metadata ` +
        `indexes only cover the first ${METADATA_INDEX_BYTE_LIMIT}`,
    );
  }
}

// --- Chunking -----------------------------------------------------------

/** An ATX heading line, and its depth. Setext headings are not used by this site's output. */
const ATX_HEADING = /^(#{1,6})\s+\S/;

/** A fenced code block delimiter, opening or closing. */
const CODE_FENCE = /^\s*(?:```|~~~)/;

interface HeadingBlock {
  /** Heading depth, or `null` for the text before the document's first heading. */
  depth: number | null;
  text: string;
}

/**
 * Splits markdown at heading boundaries, each block carrying its own heading
 * line. Fenced code is tracked so that a `# comment` inside a shell sample is
 * not mistaken for a heading -- this site's writing is about code, so that is
 * an ordinary line rather than a contrived one.
 *
 * The text before the first heading (a `.md` export's YAML frontmatter, and any
 * standfirst above the first section) becomes a leading block with a `null`
 * depth, which `sectionsAt` then attaches to whatever follows it.
 */
function splitIntoBlocks(markdown: string): HeadingBlock[] {
  const blocks: HeadingBlock[] = [];
  let depth: number | null = null;
  let lines: string[] = [];
  let inFence = false;

  const push = (): void => {
    const text = lines.join('\n');
    if (text.trim().length > 0) blocks.push({ depth, text });
  };

  for (const line of markdown.split('\n')) {
    if (CODE_FENCE.test(line)) {
      inFence = !inFence;
      lines.push(line);
      continue;
    }
    const heading = inFence ? null : ATX_HEADING.exec(line);
    if (heading) {
      push();
      depth = heading[1]?.length ?? 1;
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  push();

  return blocks;
}

/**
 * Splits `text` at the last whitespace before `maxChars`, or at `maxChars` when
 * there is none. The last resort, for a single paragraph with no internal
 * structure that is still over budget -- a minified blob, a long table row.
 */
function hardSplit(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const breakAt = window.search(/\s\S*$/);
    const cut = breakAt > 0 ? breakAt : maxChars;
    const part = rest.slice(0, cut).trim();
    if (part.length > 0) parts.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * Breaks one over-budget block into pieces that fit: paragraphs first (blank
 * line separated), then `hardSplit` for a paragraph that is over budget on its
 * own. A block already within budget is returned untouched -- this is the
 * fallback for when heading boundaries have run out, not a second chunker.
 */
function splitOversizeBlock(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') pieces.push(current);
    current = '';
  };

  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.trim().length === 0) continue;
    if (estimateTokens(paragraph) > maxTokens) {
      flush();
      pieces.push(...hardSplit(paragraph, maxChars));
      continue;
    }
    const candidate = current === '' ? paragraph : `${current}\n\n${paragraph}`;
    if (estimateTokens(candidate) > maxTokens) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  flush();

  return pieces;
}

/**
 * Groups `blocks` into sections at heading depth `depth`: each section is one
 * depth-`depth` heading plus everything under it, including its deeper
 * subsections. Anything before the first such heading (frontmatter, a `# Title`
 * above the first `##`) rides along with the section that follows it rather
 * than becoming a fragment.
 */
function sectionsAt(blocks: HeadingBlock[], depth: number): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let seen = false;
  for (const block of blocks) {
    // `seen` is what makes the lead-in ride along instead of becoming a section
    // of its own: the first depth-`depth` heading joins whatever came before it,
    // and only the second one onwards starts a new section. Without it, cutting
    // a `# Title / ## One / ## Two` document at `##` strands the title line as a
    // two-token chunk.
    if (block.depth === depth && seen && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    if (block.depth === depth) seen = true;
    current.push(block.text);
  }
  if (current.length > 0) sections.push(current.join('\n'));
  return sections;
}

/**
 * Splits top-down, and only as far as it has to: shallowest heading level
 * first, then deeper levels, then paragraphs, then raw characters.
 */
function splitRecursive(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  const blocks = splitIntoBlocks(text);
  const depths = [...new Set(blocks.map((block) => block.depth))]
    .filter((depth): depth is number => depth !== null)
    .sort((a, b) => a - b);

  // Shallowest first: cutting at `##` before `###` keeps the cut at the most
  // meaningful boundary the document offers. A depth that yields only one
  // section cannot cut anything (a lone `# Title` over the whole document), so
  // the next depth down is tried before giving up on headings entirely.
  for (const depth of depths) {
    const sections = sectionsAt(blocks, depth);
    if (sections.length > 1) {
      return sections.flatMap((section) => splitRecursive(section, maxTokens));
    }
  }

  return splitOversizeBlock(text, maxTokens);
}

/**
 * Chunks one document's markdown to roughly 1,000-1,500 tokens, cutting on
 * heading boundaries wherever it can.
 *
 * Two properties, and the second is the one that is easy to get wrong:
 *
 * 1. **No chunk exceeds `maxTokens`.** Headings run out, then paragraphs, then
 *    characters; something always cuts.
 * 2. **A document that already fits is never split at all.** The résumé renders
 *    to roughly 200 estimated tokens, so it is exactly one chunk. An earlier
 *    draft of this function split on every sibling heading regardless of size,
 *    which turned an 800-token post with six `##` sections into six fragments
 *    -- each a worse retrieval target than the whole, and none of them anywhere
 *    near the size 01 §4 asks for. The target is a ceiling with a shape, not a
 *    quota to fill.
 *
 * What the top-down order buys is that a chunk produced by a heading cut
 * contains exactly one heading at the depth it was cut on, plus that heading's
 * subtree -- so a chunk never spans two sibling sections, which would retrieve
 * badly for both.
 */
export function chunkMarkdown(markdown: string, maxTokens: number = MAX_CHUNK_TOKENS): string[] {
  if (markdown.trim().length === 0) return [];
  return splitRecursive(markdown, maxTokens)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

// --- The manifest -------------------------------------------------------

const encoder = new TextEncoder();

/**
 * SHA-256 over the contract version, the document's key and its markdown, hex
 * encoded. Same construction as `resumeSourceHash` in src/lib/resume-pdf.ts,
 * and taken over the same kind of input: the source text, never anything
 * derived from a build (an embedding is nondeterministic at the last float --
 * Task 14 measured batch-size-dependent drift -- so hashing vectors would
 * re-embed forever).
 */
export async function documentHash(key: string, markdown: string): Promise<string> {
  const input = `corpus/v${CORPUS_CONTRACT_VERSION}\n${key}\n${markdown}`;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * One document's manifest entry.
 *
 * This is `ResumePdfManifest`'s shape (src/lib/resume-pdf.ts), reused rather
 * than reinvented -- the two jobs have the same problem, "did the source move
 * since the last run", and should not have two answers to it. Field for field:
 *
 * | field     | résumé PDF                | corpus                                    |
 * | --------- | ------------------------- | ----------------------------------------- |
 * | `hash`    | résumé source hash        | document markdown hash                    |
 * | `key`     | R2 key the bytes live at  | `<type>:<slug>`, the vector-id prefix     |
 * | `etag`    | R2's `httpEtag`           | Vectorize's `mutationId` for the upsert   |
 * | `builtAt` | ISO 8601                  | ISO 8601                                  |
 * | `size`    | bytes written             | bytes of source markdown                  |
 *
 * `etag` is the one field that had to be re-pointed rather than reused
 * verbatim: a vector has no entity tag, because nothing serves it over HTTP.
 * `mutationId` is what stands in the same place -- the opaque, server-assigned
 * identity of the write that produced this state, and the value
 * `vectorize info`'s `processedUpToMutation` is compared against to tell
 * whether a write has been indexed yet. See `lastMutationId` for why it can be
 * empty.
 *
 * `chunks` is the one addition. It is not decoration: it is how a re-run knows
 * which vector ids a document USED to own, so a document that shrinks from
 * three chunks to two has `<key>:2` deleted instead of leaving a stale vector
 * behind that still answers queries.
 */
export interface CorpusDocumentEntry {
  hash: string;
  key: string;
  etag: string;
  builtAt: string;
  size: number;
  /** How many vectors `key` expands to. */
  chunks: number;
}

/** The whole manifest: one entry per document, keyed by `documentKey`. */
export type CorpusManifest = Record<string, CorpusDocumentEntry>;

export interface HashedDocument {
  source: CorpusSource;
  markdown: string;
  hash: string;
}

export interface CorpusPlan {
  /** Documents whose hash moved (or everything, under `force`). */
  embed: HashedDocument[];
  /** Document keys the manifest already has at the current hash. */
  unchanged: string[];
  /** Vector ids belonging to documents that are no longer published at all. */
  staleIds: string[];
  /** Manifest keys the `staleIds` came from. */
  removed: string[];
}

/**
 * Decides what a refresh has to do. Pure, so the interesting half of "only
 * changed documents" is unit-testable with no bindings at all.
 *
 * The `removed` arm matters more than the `embed` arm does: a post that goes
 * back to `draft: true` disappears from `/llms.txt`, and without this its
 * vectors would stay in the index answering queries about a document the site
 * no longer publishes. That is the same leak `/llms-full.txt`'s draft filter
 * exists to prevent, one layer down.
 */
export function planCorpusRefresh(
  manifest: CorpusManifest,
  documents: HashedDocument[],
  options: { force?: boolean } = {},
): CorpusPlan {
  const embed: HashedDocument[] = [];
  const unchanged: string[] = [];
  const present = new Set<string>();

  for (const document of documents) {
    const key = documentKey(document.source);
    present.add(key);
    if (!options.force && manifest[key]?.hash === document.hash) {
      unchanged.push(key);
    } else {
      embed.push(document);
    }
  }

  const removed: string[] = [];
  const staleIds: string[] = [];
  for (const [key, entry] of Object.entries(manifest)) {
    if (present.has(key)) continue;
    removed.push(key);
    staleIds.push(...chunkIdsFor(key, entry.chunks));
  }

  return { embed, unchanged, staleIds, removed };
}

/**
 * The ids a document owned last run but does not own now. Empty when a document
 * grew or stayed the same size, because those ids are overwritten by the upsert
 * rather than orphaned by it.
 */
export function surplusChunkIds(
  previous: CorpusDocumentEntry | undefined,
  nextChunks: number,
): string[] {
  if (!previous || previous.chunks <= nextChunks) return [];
  return chunkIdsFor(previous.key, previous.chunks).slice(nextChunks);
}

// --- The job ------------------------------------------------------------

/**
 * Only the bindings this module reads, narrower than `Env`, same as
 * `ResumePdfEnv`.
 */
export interface CorpusEnv {
  ASSETS: Fetcher;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  KV_CACHE: KVNamespace;
  /**
   * Only ever used to give `env.ASSETS.fetch` an absolute URL. The host is
   * irrelevant to an asset binding -- it never leaves the Worker -- but this is
   * the origin this site declares it has, and inventing a second sentinel here
   * would be one more string to keep in step with nothing.
   */
  SITE_ORIGIN: string;
  /**
   * Test-only seam, the same shape and the same reasoning as
   * `ResumePdfEnv.RESUME_PDF_RENDERER`: `'on'` (the deployed default, which
   * comes from the var being ABSENT rather than from a default branch) or
   * `'off'`. No deployed environment sets it -- wrangler.jsonc does not declare
   * it -- and an unrecognised value throws rather than guessing.
   *
   * `'off'` is set by tests/workers.ts, and the reason is not squeamishness
   * about network calls. Task 14 overrode the `AI` binding to a local service
   * (`workers/mock-ai`) so that `npm test` cannot open a remote proxy session or
   * bill neurons; a service binding hands the Worker a `Fetcher`, so
   * `env.AI.run()` is a TypeError there by design. And the `VECTORIZE` binding
   * under the harness is a LOCAL SIMULATION, not `ryanlindsey-me-corpus` -- so
   * a stub embedder feeding a simulated index would produce a green run that
   * says nothing at all about whether the corpus works. That is the exact
   * false positive this task was written to avoid, so the job does not run in
   * the harness and says so, rather than running against fakes and passing.
   *
   * The chunker, the source list, the hash and the plan are all pure and are
   * covered directly in tests/corpus.test.ts. The embed/upsert/query round trip
   * is verified by hand against the live index and recorded in
   * task-15-report.md.
   */
  CORPUS_REFRESH?: string;
}

/**
 * Whether `scheduled()` should run the refresh. Throws on an unrecognised
 * value: a typo that silently disabled the corpus refresh forever would look
 * exactly like a corpus that had nothing to do.
 *
 * Takes the whole `CorpusEnv` rather than `Pick<CorpusEnv, 'CORPUS_REFRESH'>`,
 * which looks tighter and does not compile. That Pick is all-optional, i.e. a
 * WEAK TYPE, and `Env` -- which does not declare the test-only var at all --
 * has no property in common with it, so TypeScript rejects the call at the one
 * place it is actually made (ts2559). Naming the same type `refreshCorpus`
 * takes makes both call sites in src/worker.ts identical and the weak-type rule
 * inapplicable.
 */
export function corpusRefreshEnabled(env: CorpusEnv): boolean {
  const mode = env.CORPUS_REFRESH ?? 'on';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  throw new Error(`unknown CORPUS_REFRESH ${JSON.stringify(mode)}`);
}

/**
 * How many chunks go in one `AI.run` call. Task 14 measured that `documents`
 * batches correctly (`{ documents: ['alpha','beta'] }` returns shape
 * `[2, 1024]`), and also that batched output is NOT bit-identical to the same
 * string embedded alone -- ordinary float nondeterminism, cosine 0.99999999999,
 * harmless here and the reason nothing downstream compares vectors for
 * equality.
 */
const EMBED_BATCH_SIZE = 20;

/** Vectors per `upsert` call, comfortably inside Vectorize's per-request caps. */
const UPSERT_BATCH_SIZE = 100;

async function readAsset(env: CorpusEnv, path: string): Promise<string> {
  const response = await env.ASSETS.fetch(new URL(path, env.SITE_ORIGIN).toString());
  if (!response.ok) {
    throw new Error(`corpus: ${path} returned ${response.status} from the ASSETS binding`);
  }
  return await response.text();
}

export async function readCorpusManifest(
  env: Pick<CorpusEnv, 'KV_CACHE'>,
): Promise<CorpusManifest> {
  return (await env.KV_CACHE.get<CorpusManifest>(CORPUS_MANIFEST_KEY, 'json')) ?? {};
}

/**
 * Embeds `chunks` as DOCUMENTS.
 *
 * `{ documents }`, no `instruction`, and never `text`. `text` is a plain alias
 * for `documents` -- Task 14 measured a bit-identical vector -- so it buys
 * nothing and says less.
 *
 * THIS MODEL DOES HAVE A QUERY SIDE, and it is `queries` (PLURAL). Task 14
 * probed `query` (singular), which is not in the model's input schema at all,
 * got `3030: invalid input`, and concluded from that rejection that no query
 * side existed. Re-measured 2026-09-07 against this account, with a repeated
 * identical call as the bit-identity control:
 *
 *   { documents: ['agentic engineering manager'] }  ->  5 prompt tokens
 *   { queries:   ['agentic engineering manager'] }  -> 24 prompt tokens
 *   cosine between the two: 0.717, NOT bit-identical
 *
 * The 19-token difference is a real instruction template the query side wraps
 * its input in. `instruction` customises that template and only affects
 * `queries`: on the documents side every instruction returned a bit-identical
 * vector at an unchanged 5 prompt tokens, which is the correct asymmetric
 * behaviour -- documents are meant to be embedded bare. `queries` and
 * `documents` cannot be combined; together they error 3030.
 *
 * None of which changes THIS call. A corpus document must be embedded
 * document-side, bare, and that is what happens here. What it changes is day
 * 5: queries should go through `{ queries: [...] }`, optionally with an
 * `instruction`, rather than being embedded as documents. See task-15-report.md
 * §7 for the full measurement, including the caveat that whether the query side
 * retrieves BETTER cannot be judged against a one-document corpus.
 *
 * The width check is not defensive padding. Vectorize cannot be resized, so a
 * model that starts returning a different width has to stop this job rather
 * than upsert what it can.
 */
async function embedChunks(env: Pick<CorpusEnv, 'AI'>, chunks: string[]): Promise<number[][]> {
  for (const chunk of chunks) {
    const tokens = estimateTokens(chunk);
    if (tokens > MODEL_INPUT_TOKEN_LIMIT) {
      throw new Error(
        `corpus: a chunk estimated at ${tokens} tokens exceeds the ${MODEL_INPUT_TOKEN_LIMIT}-token model input limit`,
      );
    }
  }

  const vectors: number[][] = [];
  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
    const result = await env.AI.run(CORPUS_EMBEDDING_MODEL, { documents: batch });
    const data = result.data;
    if (!data || data.length !== batch.length) {
      throw new Error(
        `corpus: embedding returned ${data?.length ?? 0} vectors for ${batch.length} chunks`,
      );
    }
    for (const vector of data) {
      if (vector.length !== CORPUS_DIMENSIONS) {
        throw new Error(
          `corpus: embedding width is ${vector.length}, but the index is ${CORPUS_DIMENSIONS} and cannot be resized`,
        );
      }
      vectors.push(vector);
    }
  }
  return vectors;
}

/**
 * Upserts `vectors` and returns the mutation id of the last batch.
 *
 * The type and the runtime disagree here, and only one of them is checkable at
 * build time. `wrangler types` emits the BETA `VectorizeIndex` class for a
 * `vectorize` binding, whose mutations are typed `VectorizeVectorMutation`
 * (`{ ids, count }`); a V2 index -- which `ryanlindsey-me-corpus` is, having
 * been created after the RC -- returns `VectorizeAsyncMutation`
 * (`{ mutationId }`) at runtime, because V2 mutations are asynchronous and
 * there is no synchronous id list to report. So both shapes are read rather
 * than one being asserted, and an empty return means "this binding answered in
 * the beta shape" rather than "the upsert failed" -- the upsert itself either
 * resolves or throws.
 */
async function upsertVectors(
  index: Pick<VectorizeIndex, 'upsert'>,
  vectors: VectorizeVector[],
): Promise<string> {
  let lastMutationId = '';
  for (let offset = 0; offset < vectors.length; offset += UPSERT_BATCH_SIZE) {
    const mutation: VectorizeVectorMutation | VectorizeAsyncMutation = await index.upsert(
      vectors.slice(offset, offset + UPSERT_BATCH_SIZE),
    );
    // Read, not asserted: `in` cannot narrow this the way it looks like it
    // should, because the declared half of the union has no `mutationId` and
    // TypeScript widens the property to `unknown` rather than excluding that
    // half. A `typeof` check on the value is the honest form of the same
    // question -- did this binding answer in the V2 shape?
    const { mutationId } = mutation as Partial<VectorizeAsyncMutation>;
    if (typeof mutationId === 'string') lastMutationId = mutationId;
  }
  return lastMutationId;
}

export interface CorpusRefreshResult {
  /** Documents embedded and upserted this run, with the chunk count each produced. */
  embedded: { key: string; chunks: number; mutationId: string }[];
  /** Document keys skipped because their hash had not moved. */
  unchanged: string[];
  /** Vector ids deleted: unpublished documents, plus chunks a shrunk document no longer owns. */
  deleted: string[];
  /** The manifest as written. */
  manifest: CorpusManifest;
}

/**
 * The embedding refresh. Called from `scheduled()` in src/worker.ts alongside
 * the résumé-PDF job.
 *
 * Steady state is two asset reads and one KV read: `planCorpusRefresh` finds
 * every hash unmoved and nothing is embedded, so a daily cron over unchanged
 * content bills no neurons. That is the same shape `regenerateResumePdf` uses
 * to keep browser-hours near zero, for the same reason.
 *
 * There is deliberately no render lock of the kind resume-pdf.ts takes. That
 * lock exists to bound a burst of expensive browser sessions started from the
 * REQUEST path; this job has exactly one caller, the daily cron, and its writes
 * are id-stable upserts of identical content -- two concurrent runs would
 * converge on the same index state. If a request-path caller is ever added,
 * that reasoning stops holding and the lock should come with it.
 */
export async function refreshCorpus(
  env: CorpusEnv,
  options: { force?: boolean } = {},
): Promise<CorpusRefreshResult> {
  const sources = corpusSources(await readAsset(env, '/llms.txt'));

  const documents: HashedDocument[] = [];
  for (const source of sources) {
    const markdown = await readAsset(env, source.path);
    documents.push({ source, markdown, hash: await documentHash(documentKey(source), markdown) });
  }

  const manifest = await readCorpusManifest(env);
  const plan = planCorpusRefresh(manifest, documents, options);

  const next: CorpusManifest = { ...manifest };
  for (const key of plan.removed) delete next[key];
  const deleted = [...plan.staleIds];
  const embedded: CorpusRefreshResult['embedded'] = [];

  for (const document of plan.embed) {
    const key = documentKey(document.source);
    const chunks = chunkMarkdown(document.markdown);
    if (chunks.length === 0) {
      throw new Error(`corpus: ${document.source.path} chunked to nothing`);
    }

    const metadata = metadataFor(document.source);
    for (const [name, value] of Object.entries(metadata)) assertShortMetadataValue(name, value);

    const values = await embedChunks(env, chunks);
    const vectors: VectorizeVector[] = values.map((vector, index) => ({
      id: chunkId(document.source, index),
      values: vector,
      metadata,
    }));

    const mutationId = await upsertVectors(env.VECTORIZE, vectors);

    // Chunks the previous run owned and this one does not. Deleted AFTER the
    // upsert, so a failure between the two leaves a stale vector rather than a
    // gap -- an extra answer is recoverable on the next run; a missing one that
    // the manifest claims is present is not.
    const surplus = surplusChunkIds(manifest[key], chunks.length);
    if (surplus.length > 0) {
      await env.VECTORIZE.deleteByIds(surplus);
      deleted.push(...surplus);
    }

    next[key] = {
      hash: document.hash,
      key,
      etag: mutationId,
      builtAt: new Date().toISOString(),
      size: encoder.encode(document.markdown).length,
      chunks: chunks.length,
    };
    embedded.push({ key, chunks: chunks.length, mutationId });
  }

  if (plan.staleIds.length > 0) {
    await env.VECTORIZE.deleteByIds(plan.staleIds);
  }

  // Written last, and only after every vector is in flight: the manifest flip
  // is the commit, same as resume-pdf.ts's. A half-finished run leaves vectors
  // no manifest entry claims -- re-upserted identically on the next run --
  // never a manifest entry pointing at vectors that were never sent.
  await env.KV_CACHE.put(CORPUS_MANIFEST_KEY, JSON.stringify(next));

  return { embedded, unchanged: plan.unchanged, deleted, manifest: next };
}
