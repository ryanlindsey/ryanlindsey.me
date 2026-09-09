import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CORPUS_DIMENSIONS,
  CORPUS_TIER,
  documentKey,
  readCorpusManifest,
  RESUME_SOURCE,
  type CorpusType,
} from '../../../src/lib/corpus';
import {
  fetchDocument,
  fetchDocumentIndex,
  fetchResumeJson,
  pageUrlFor,
  parseFrontmatter,
  summarize,
  type DocumentsEnv,
  type DocumentSummary,
} from '../../../src/lib/mcp/documents';
import {
  citationFor,
  embedQuery,
  parseChunkId,
  UNKNOWN_CHUNK_COUNT,
  type Citation,
} from '../../../src/lib/mcp/search';
import type { McpEnv } from './env';
import { defineTool, ToolError, type ToolContext } from './define';

/**
 * The published documents, as this Worker reads them.
 *
 * `SITE` IS A BINDING NOW, and this comment used to say the opposite. Day 4
 * Task 3 wrote "`SITE` is not a binding this Worker declares" and assembled a
 * global-`fetch` wrapper over `SITE_ORIGIN` here, which was true and worked
 * until `ryanlindsey.me/mcp` started forwarding into this Worker -- after which
 * every document read on the primary endpoint returned 522. The correction is
 * issue #28's; workers/mcp/wrangler.jsonc's `services` entry carries the full
 * mechanism and `corpusEnv` in ./index.ts is the other half of the same fix.
 *
 * Two lines, both straight off `env`, so there is nothing left here to get
 * wrong: no wrapper, no unbound-`this` hazard, and no way for this to differ
 * from what the cron job reads.
 *
 * Exported for ./resources.ts, which reads the same published documents and
 * must read them the same way. A second copy of these two lines would be a
 * second place for the binding and the origin to drift apart.
 */
export function documentsEnv(env: McpEnv): DocumentsEnv {
  return {
    SITE: env.SITE,
    SITE_ORIGIN: env.SITE_ORIGIN,
  };
}

/**
 * The query's vector, through the test-only `MCP_SEARCH_EMBEDDER` seam.
 *
 * The seam is HERE rather than inside `embedQuery` on purpose: reading an
 * environment variable is Worker wiring, and src/lib/mcp/search.ts is the pure
 * module the root Vitest suite exercises with nothing bound. `embedQuery` is
 * therefore still the only thing that talks to Workers AI, and it is asserted
 * directly in tests/mcp-search.test.ts with a stub `Ai` at the call site --
 * which is what workers/mock-ai's own doc comment asks for, since a service
 * binding hands this Worker a `Fetcher` and `env.AI.run()` is a TypeError
 * against it.
 *
 * Throws on an unrecognised value, matching `corpusRefreshEnabled`: a typo
 * that silently stubbed out the embedder in production would look exactly like
 * a search that returns nothing.
 */
async function queryVector(env: McpEnv, query: string): Promise<number[]> {
  const mode = env.MCP_SEARCH_EMBEDDER ?? 'on';
  if (mode === 'on') return await embedQuery(env.AI, query);
  // A fixed vector of the index's own width. It retrieves nothing meaningful
  // and is not meant to: it exists so the rest of the handler -- the limiter,
  // the Vectorize call, the manifest read -- can be exercised without an
  // embedding call.
  if (mode === 'stub') return new Array<number>(CORPUS_DIMENSIONS).fill(0);
  throw new Error(`unknown MCP_SEARCH_EMBEDDER ${JSON.stringify(mode)}`);
}

const SEARCH_INPUT = z.object({
  query: z.string().min(1).max(500).describe('What to look for, in natural language.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('How many passages to return. Defaults to 5.'),
});

const RESUME_FORMAT = z.object({
  format: z
    .enum(['json', 'markdown', 'summary'])
    .default('json')
    .describe(
      'json = JSON Resume schema; markdown = the published document; summary = a short prose read.',
    ),
});

/** A non-empty string, or nothing. Every field the summary reads is optional in JSON Resume. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * One `work` entry as `role — company (range)`, or nothing when the entry does
 * not name both. An entry missing either is skipped rather than filled in with
 * a placeholder: a line reading "Role not stated" is a claim the résumé never
 * made.
 */
function roleLine(entry: Record<string, unknown>): string | undefined {
  const position = text(entry.position);
  // JSON Resume v1 names the employer `name`, not `company`.
  const company = text(entry.name);
  if (position === undefined || company === undefined) return undefined;

  const start = text(entry.startDate);
  // An absent `endDate` is how JSON Resume says "current", and "Present" is the
  // word the published résumé itself uses for it.
  const range = start === undefined ? '' : ` (${start} – ${text(entry.endDate) ?? 'Present'})`;
  return `${position} — ${company}${range}`;
}

/** How many `work` entries the summary names. `work` is published most-recent-first. */
const SUMMARY_ROLES = 3;

/**
 * A short prose read of the résumé, built from the same JSON `format=json`
 * returns so the two cannot contradict each other.
 *
 * The entries are taken in published order rather than re-sorted by date:
 * `/resume.json` publishes `work` most-recent-first, and a second ordering
 * computed here could disagree with the markdown a caller gets from
 * `format=markdown`.
 *
 * The citation prefers the résumé's own `basics.url` over `SITE_ORIGIN`, and
 * the difference matters: `SITE_ORIGIN` is the origin these documents were
 * FETCHED from, which under the test harness or a preview deploy is not an
 * address to send a reader to. `basics.url` is what the document publishes
 * about itself, so the summary cites the same source everything else in it
 * came from. `SITE_ORIGIN` is the fallback for a résumé that publishes no URL.
 */
function summaryOf(resume: unknown, origin: string): string {
  // Read defensively rather than parsed into a type: `format=json` hands this
  // same object back verbatim, so nothing here may narrow what the document is
  // allowed to contain.
  const json = (resume ?? {}) as { basics?: unknown; work?: unknown };
  const basics = (json.basics ?? {}) as Record<string, unknown>;
  const work = Array.isArray(json.work) ? (json.work as Record<string, unknown>[]) : [];

  const paragraphs: string[] = [];
  const label = text(basics.label);
  if (label !== undefined) paragraphs.push(label);
  const summary = text(basics.summary);
  if (summary !== undefined) paragraphs.push(summary);

  const roles = work
    .slice(0, SUMMARY_ROLES)
    .map(roleLine)
    .filter((line): line is string => line !== undefined);
  if (roles.length > 0) paragraphs.push(`Recent roles:\n${roles.join('\n')}`);

  paragraphs.push(`Full résumé: ${pageUrlFor(RESUME_SOURCE, text(basics.url) ?? origin)}`);
  return paragraphs.join('\n\n');
}

/**
 * What a caller is told when the résumé cannot be read.
 *
 * A `ToolError`, so `defineTool` shows this sentence rather than the generic
 * "the error was logged" -- the caller asked for a document and the honest
 * answer is that it is not there, not that something broke inside.
 *
 * Exported for ./resources.ts: `resume://json` serves the same document and
 * has to say the same thing when it is missing. One sentence, reviewed once.
 */
export const RESUME_UNAVAILABLE = 'The résumé could not be read from the site right now.';

/**
 * Shared by both case-study tools; `section` is the `CorpusType` they filter
 * to. Only `case-study` is used today, but the shape generalises to Task 8's
 * `list_writing`/`get_writing` (`section: 'post'`) without a second copy of
 * this loop.
 */
async function listDocuments(tc: ToolContext, section: CorpusType): Promise<DocumentSummary[]> {
  const documents = documentsEnv(tc.env);
  const index = await fetchDocumentIndex(documents);
  const summaries: DocumentSummary[] = [];
  for (const source of index.filter((s) => s.type === section)) {
    const markdown = await fetchDocument(documents, source);
    // A document the index lists but that will not fetch is a broken deploy,
    // not an empty section. Skip it rather than fail the whole listing.
    if (markdown !== null) summaries.push(summarize(source, markdown, tc.env.SITE_ORIGIN));
  }
  return summaries;
}

/**
 * The copy for `request_private_access`, verbatim -- 03 §2's single most
 * delicate string in the repo. Reviewed neutral wording: a private tier is
 * normal, and asking about one does not imply Ryan is searching for anything.
 * Asserted as a whole string in tests/mcp-tools.test.ts, the same discipline
 * tests/mcp.smoke.test.ts applies to the server's own `instructions`, so any
 * edit here has to be made deliberately rather than slipping past a keyword
 * scan.
 */
const PRIVATE_ACCESS_TEXT =
  'Some material on this site is served to scoped tokens rather than published: ' +
  'reference contacts, engagement logistics, and the unredacted layer of a few case ' +
  'studies. This is an ordinary access tier, not a waiting list. Email ' +
  'hello@ryanlindsey.me with who you are and what you are evaluating, and Ryan will ' +
  'issue a scoped, expiring token if it fits. Public tools cover the portfolio in full.';

/**
 * Every tool this server exposes beyond the one `createServer` registers
 * itself, through `defineTool` and nothing else (03 §3).
 *
 * One function rather than one per tool: adding a tool is a `defineTool(...)`
 * call appended here, and there is no second place to remember. Registering
 * one any other way skips the audit trail and the limiter, which is why
 * `defineTool` is the only registration path in this Worker.
 */
export function registerTools(server: McpServer, tc: ToolContext): void {
  defineTool<z.infer<typeof RESUME_FORMAT>>(
    server,
    tc,
    {
      name: 'get_resume',
      title: 'Résumé',
      description:
        "Ryan Lindsey's résumé: JSON Resume data, the published markdown document, or a short prose summary.",
      cost: 'cheap',
      inputSchema: RESUME_FORMAT,
      // NO `outputSchema`, and this is a decision rather than an omission.
      //
      // 04's step 3 asks for `structuredContent` on `format=json`, and
      // `defineTool` emits that only for a tool that declares an
      // `outputSchema`. Declaring one binds ALL THREE formats: the SDK
      // requires structured content on every non-error result of a tool that
      // advertises a schema, and validates it against that schema
      // (`validateToolOutput`, @modelcontextprotocol/server 2.0.0,
      // dist/mcp-DXXb3Vv3.mjs:1439). Two of this tool's formats answer with a
      // string, so a `z.ZodObject` schema rejects them -- measured, with
      // `z.looseObject({})`, the loosest object schema there is:
      //   "Output validation error: Invalid structured content for tool
      //    get_resume: Invalid input: expected object, received string"
      //
      // NOT an SDK limitation, and worth being exact about: the SDK accepts
      // any standard schema and handles a non-object root deliberately
      // (`isNonObjectJsonSchemaRoot`). It is `defineTool`'s own
      // `outputSchema?: z.ZodObject<z.ZodRawShape>` that narrows to objects.
      // The reason not to widen it is the behaviour on the other side: a
      // non-object root makes the SDK wrap structured content as
      // `{ result: <value> }` for 2025-era clients -- which is exactly the
      // envelope around JSON Resume that 02 §1 forbids -- and it would also
      // duplicate every markdown document into the response twice, once as
      // text and once as structured content. So the JSON format's object goes
      // out as the `content` text, valid JSON a client parses in one step, and
      // this tool advertises no output schema at all.
    },
    async ({ format }, { env }) => {
      const documents = documentsEnv(env);

      if (format === 'markdown') {
        const markdown = await fetchDocument(documents, RESUME_SOURCE);
        if (markdown === null) throw new ToolError(RESUME_UNAVAILABLE);
        // Frontmatter is the export format's own envelope, not part of the
        // document a reader was served.
        return parseFrontmatter(markdown).body;
      }

      const resume = await fetchResumeJson(documents);
      if (resume === null) throw new ToolError(RESUME_UNAVAILABLE);
      // `json` returns it UNRESHAPED (02 §1). `summary` is derived from the
      // same object rather than from a second fetch of the markdown.
      return format === 'summary' ? summaryOf(resume, env.SITE_ORIGIN) : resume;
    },
  );

  defineTool(
    server,
    tc,
    {
      name: 'list_case_studies',
      title: 'List case studies',
      description: 'Published case studies with their metadata and citation URLs.',
      cost: 'cheap',
    },
    async (_args, tc) => await listDocuments(tc, 'case-study'),
  );

  defineTool(
    server,
    tc,
    {
      name: 'get_case_study',
      title: 'Get a case study',
      description: 'The full markdown of one published case study, by slug.',
      cost: 'cheap',
      inputSchema: z.object({
        slug: z.string().min(1).describe('The slug from list_case_studies.'),
      }),
    },
    async ({ slug }: { slug: string }, tc) => {
      const documents = documentsEnv(tc.env);
      const index = await fetchDocumentIndex(documents);
      const source = index.find((s) => s.type === 'case-study' && s.slug === slug);
      if (!source) {
        const published = index.filter((s) => s.type === 'case-study').map((s) => s.slug);
        // Naming what IS available turns a dead end into a next step.
        throw new ToolError(
          `Case study "${slug}" not found. Published slugs: ${published.join(', ') || '(none yet)'}`,
        );
      }
      const markdown = await fetchDocument(documents, source);
      if (markdown === null) {
        throw new ToolError(`Case study "${slug}" is indexed but did not fetch.`);
      }
      return {
        slug,
        url: pageUrlFor(source, tc.env.SITE_ORIGIN),
        markdown: parseFrontmatter(markdown).body,
      };
    },
  );

  defineTool(
    server,
    tc,
    {
      name: 'list_writing',
      title: 'List writing',
      description: 'Published posts with their descriptions and citation URLs.',
      cost: 'cheap',
    },
    async (_args, tc) => await listDocuments(tc, 'post'),
  );

  defineTool(
    server,
    tc,
    {
      name: 'get_post',
      title: 'Get a post',
      description: 'The full markdown of one published post, by slug.',
      cost: 'cheap',
      inputSchema: z.object({ slug: z.string().min(1).describe('The slug from list_writing.') }),
    },
    async ({ slug }: { slug: string }, tc) => {
      const documents = documentsEnv(tc.env);
      const index = await fetchDocumentIndex(documents);
      const source = index.find((s) => s.type === 'post' && s.slug === slug);

      if (!source) {
        // A client that found a slug in /llms.txt or a search citation does not
        // necessarily know which collection it belongs to. Answering "not found"
        // when the document exists under the other tool would be true and
        // useless, so check before saying it.
        const asCaseStudy = index.find((s) => s.type === 'case-study' && s.slug === slug);
        if (asCaseStudy) {
          throw new ToolError(`"${slug}" is a case study — call get_case_study with that slug.`);
        }
        const published = index.filter((s) => s.type === 'post').map((s) => s.slug);
        throw new ToolError(
          `Post "${slug}" not found. Published slugs: ${published.join(', ') || '(none yet)'}`,
        );
      }

      const markdown = await fetchDocument(documents, source);
      if (markdown === null) throw new ToolError(`Post "${slug}" is indexed but did not fetch.`);
      return {
        slug,
        url: pageUrlFor(source, tc.env.SITE_ORIGIN),
        markdown: parseFrontmatter(markdown).body,
      };
    },
  );

  defineTool<z.infer<typeof SEARCH_INPUT>>(
    server,
    tc,
    {
      name: 'search_writing',
      title: 'Search the writing',
      // The `exact` flag is named in the description because a caller cannot
      // act on a field it does not know to read, and the whole point of
      // surfacing it is that a degraded excerpt is not quoted as a passage.
      description:
        'Semantic search across the published posts, case studies and résumé. Each result is a passage, the URL it is published at, and an "exact" flag saying whether the excerpt is the passage that matched.',
      // The only `inference` tool: it spends a Workers AI embedding call per
      // query, so it draws from the tighter of the two allowances in `LIMITS`
      // (src/lib/mcp/limits.ts) rather than the document reads' one.
      cost: 'inference',
      inputSchema: SEARCH_INPUT,
    },
    async ({ query, limit }, tc): Promise<Citation[]> => {
      const vector = await queryVector(tc.env, query);

      const found = await tc.env.VECTORIZE.query(vector, {
        topK: limit,
        // Asked for AND read: every match's `tier` is re-checked in the loop
        // below. Free at this level ("no additional overhead" for indexed
        // properties), and `tier` and `type` are the only two properties any
        // vector in this index carries (src/lib/corpus.ts's `metadataFor`).
        returnMetadata: 'indexed',
        // STRUCTURAL INTENT, not decoration, and day 5 replaces it -- read
        // 09 §3 before deleting or widening this line. Everything in
        // `ryanlindsey-me-corpus` today is `tier: 'public'` (src/lib/corpus.ts's
        // `CORPUS_TIER`), so the filter changes no result on this branch.
        //
        // DAY 5 ANSWERED THIS, and not the way the paragraph above expected --
        // read the answer before acting on the instruction.
        //
        // The instruction was: replace this filter with a SEPARATE index, so a
        // missing filter cannot return a private passage at all. Day 5 did not
        // create one, deliberately. Nothing it built embeds a gated document:
        // the fit engine grounds on the PUBLIC corpus because a citation has to
        // resolve to a URL a reader can open (03 §4), and every private-tier
        // tool is a keyed R2 read (src/lib/tier/private-docs.ts). A second
        // Vectorize index would therefore have been empty -- a claim about a
        // partition rather than a partition, and this repo has been bitten
        // often enough by green runs against fakes to name that failure.
        //
        // The partition day 5 SHIPPED is stronger where it counts and testable
        // today: two R2 buckets, and a public document layer (`DocumentsEnv`)
        // whose type does not declare `R2_PRIVATE` at all, so a public tool
        // cannot name the binding, filter or no filter.
        // tests/tier-private-docs.test.ts asserts that at the type level.
        //
        // SO THE INSTRUCTION TRANSFERS RATHER THAN EXPIRES: the day something
        // embeds a non-public document, this filter stops being sufficient and
        // the separate index has to be built in the same change.
        filter: { tier: CORPUS_TIER },
      });

      // Nothing matched: answer with the empty list before spending an
      // /llms.txt fetch and a KV read that could not change it.
      if (found.matches.length === 0) return [];

      const documents = documentsEnv(tc.env);
      const [manifest, index] = await Promise.all([
        // The chunk counts the embedding job recorded. They are what makes a
        // rebuilt excerpt checkable at all -- see `excerptFor`.
        readCorpusManifest(tc.env),
        fetchDocumentIndex(documents),
      ]);

      // One fetch per cited DOCUMENT, not per match: several chunks of the
      // same post routinely come back in one result set.
      const fetched = new Map<string, string | null>();
      const citations: Citation[] = [];

      for (const match of found.matches) {
        // The `filter` above should already have made this impossible, which
        // is precisely why it is checked rather than assumed. Vectorize's
        // documented behaviour for a filtered query against a property that is
        // not indexed is to return partial or EMPTY results with NO ERROR
        // (workers/mcp/wrangler.jsonc's note on the metadata indexes), so a
        // filter that stops doing its job does not announce itself -- and the
        // direction it fails in is the one that matters here, because day 5
        // puts a non-public tier behind this same call. The metadata is
        // already on the wire, so the second opinion costs one comparison.
        //
        // Fails CLOSED: a match whose tier cannot be confirmed `public` is
        // dropped rather than cited. Every vector this corpus writes carries
        // `{ tier, type }` and both are indexed, so a match reaching this
        // branch means something is wrong with the index rather than with the
        // document -- and the safe answer to "I cannot tell whose this is" on
        // a public tool is not to serve it.
        if (match.metadata?.tier !== CORPUS_TIER) {
          console.warn(
            `mcp/search: ${match.id} did not come back as tier=${CORPUS_TIER}; dropping the match`,
          );
          continue;
        }

        const parsed = parseChunkId(match.id);
        if (parsed === null) {
          console.warn(`mcp/search: unrecognised vector id ${JSON.stringify(match.id)}`);
          continue;
        }

        // The index is the live list of PUBLISHED documents, so this is also
        // the check that a citation can never name something the site no
        // longer serves. A vector for an unpublished document should have been
        // deleted by the refresh; if one survives, it is dropped here rather
        // than cited.
        const source = index.find((s) => s.type === parsed.type && s.slug === parsed.slug);
        if (source === undefined) {
          console.warn(`mcp/search: ${match.id} is not a published document; dropping the match`);
          continue;
        }

        const key = documentKey(source);
        if (!fetched.has(key)) fetched.set(key, await fetchDocument(documents, source));
        const markdown = fetched.get(key) ?? null;
        // Listed but unfetchable is a broken deploy, not an answerable result:
        // drop the match rather than cite a document with no excerpt, the same
        // call `listDocuments` makes for the same case.
        if (markdown === null) continue;

        const citation = citationFor({
          type: parsed.type,
          slug: parsed.slug,
          chunk: parsed.chunk,
          score: match.score,
          url: pageUrlFor(source, tc.env.SITE_ORIGIN),
          markdown,
          expectedChunks: manifest[key]?.chunks ?? UNKNOWN_CHUNK_COUNT,
        });

        // The caller is told through `citation.exact`; this is for us. A
        // degraded citation means the index and the chunker have drifted
        // apart, and the fix is a re-embed rather than anything in this file,
        // so the vector id has to reach the logs to be actionable.
        if (!citation.exact) {
          console.warn(
            `mcp/search: ${match.id} did not line up with the manifest; citing the document lead`,
          );
        }

        citations.push(citation);
      }

      return citations;
    },
  );

  defineTool(
    server,
    tc,
    {
      name: 'request_private_access',
      title: 'Request private access',
      description: 'Explains the private access tier and how to request a scoped token.',
      cost: 'cheap',
    },
    // No arguments and no lookup: the reviewed copy above is the whole
    // answer. 06 §3 treats a call here as a high-intent event worth a
    // notification, but the queue that would carry one is day 6's and is not
    // bound on this Worker (day 5 finding 7) -- this tool call's audit row is
    // the day-4 record of the event, and that gap is a recorded decision, not
    // an omission.
    async (_args, _tc) => PRIVATE_ACCESS_TEXT,
  );
}
