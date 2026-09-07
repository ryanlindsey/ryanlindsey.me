import { describe, expect, test } from 'vitest';
import {
  CORPUS_DIMENSIONS,
  CORPUS_MANIFEST_KEY,
  CORPUS_TIER,
  MAX_CHUNK_TOKENS,
  METADATA_INDEX_BYTE_LIMIT,
  MODEL_INPUT_TOKEN_LIMIT,
  RESUME_SOURCE,
  assertShortMetadataValue,
  corpusRefreshEnabled,
  chunkId,
  chunkIdsFor,
  chunkMarkdown,
  corpusSources,
  documentHash,
  documentKey,
  estimateTokens,
  metadataFor,
  planCorpusRefresh,
  refreshCorpus,
  surplusChunkIds,
  type CorpusDocumentEntry,
  type CorpusEnv,
  type CorpusManifest,
  type CorpusSource,
  type HashedDocument,
} from '../src/lib/corpus';

// Day 3 Task 15. Everything here runs with NO bindings and no credentials: the
// chunker, the source list, the hash and the refresh plan are all pure, which
// is the whole reason they are separated from `refreshCorpus` at all. The
// upsert and the query round trip are verified by hand against the live index
// and recorded in task-15-report.md -- a local Vectorize binding is a
// SIMULATION (wrangler.jsonc's own comment), so a test asserting against it
// would prove nothing about `ryanlindsey-me-corpus`.

// --- Fixtures -----------------------------------------------------------

/**
 * `/llms.txt` exactly as this repo builds it TODAY: both `.mdx` files are
 * `draft: true`, so the aggregation filter leaves the Writing and Case studies
 * sections omitted entirely and only the Resume format manifest and the MCP
 * link survive. Copied from dist/client/llms.txt rather than paraphrased.
 */
const LLMS_TXT_TODAY = `# Ryan Lindsey

> Agentic engineering is making engineers dramatically faster. I build the instruments that let the organization around them keep pace.

## Resume

- [Resume (Markdown)](https://ryanlindsey.me/resume.md): Portable markdown résumé -- the cleanest format for a model to read.
- [Resume (JSON)](https://ryanlindsey.me/resume.json): JSON Resume schema, machine-readable.
- [Resume (PDF)](https://ryanlindsey.me/resume.pdf): Print-formatted résumé.
- [Resume (HTML)](https://ryanlindsey.me/resume): The résumé as a web page.

## MCP

- [MCP server](https://mcp.ryanlindsey.me/mcp): Model Context Protocol server. One tool today: get_contact.
`;

/**
 * The same file once something is published. This is the case the empty one
 * above can never exercise, and the reason it is here: a source list only ever
 * tested against an all-draft site is a source list nobody has tested.
 */
const LLMS_TXT_POPULATED = `${LLMS_TXT_TODAY}
## Writing

- [Second Post](https://ryanlindsey.me/writing/second-post.md): Newer.
- [First Post](https://ryanlindsey.me/writing/first-post.md): Older.

## Case studies

- [A Case Study](https://ryanlindsey.me/work/a-case-study.md): What happened.
`;

/** `/resume.md` as built today, verbatim from dist/client/resume.md. */
const RESUME_MARKDOWN = `# Ryan Lindsey

Senior Engineering Manager

Agentic engineering is making engineers dramatically faster. I build the instruments that let the organization around them keep pace.

## Experience

### Weedmaps

**Senior Engineering Manager** · Feb 2021 — Present

**Engineering Manager** · Sep 2017 — Feb 2021

### RED Digital Cinema

**Sr. Front End Developer** · Oct 2011 — Feb 2016

### Freelance

**Web design & development** · Jan 2001 — Jun 2007
`;

/** A paragraph of roughly `tokens` estimated tokens. */
const paragraph = (tokens: number, word = 'alpha'): string =>
  Array.from({ length: Math.ceil((tokens * 4) / (word.length + 1)) }, () => word).join(' ');

const source = (overrides: Partial<CorpusSource> = {}): CorpusSource => ({
  type: 'post',
  slug: 'a-post',
  path: '/writing/a-post.md',
  ...overrides,
});

const entry = (overrides: Partial<CorpusDocumentEntry> = {}): CorpusDocumentEntry => ({
  hash: 'abc',
  key: 'post:a-post',
  etag: 'mutation-1',
  builtAt: '2026-09-07T00:00:00.000Z',
  size: 100,
  chunks: 1,
  ...overrides,
});

const document = (overrides: Partial<HashedDocument> = {}): HashedDocument => ({
  source: source(),
  markdown: 'Body.',
  hash: 'abc',
  ...overrides,
});

/** Heading lines at `depth`, ignoring fenced code (none of these fixtures nest). */
const headingsAt = (text: string, depth: number): string[] =>
  text.split('\n').filter((line) => new RegExp(`^#{${depth}}\\s`).test(line));

// --- corpusSources ------------------------------------------------------

describe('corpusSources', () => {
  test('today, with both specimens draft, the corpus is the résumé and nothing else', () => {
    expect(corpusSources(LLMS_TXT_TODAY)).toEqual([RESUME_SOURCE]);
  });

  test('picks up published posts and case studies, résumé first, /llms.txt order after', () => {
    expect(corpusSources(LLMS_TXT_POPULATED)).toEqual([
      RESUME_SOURCE,
      { type: 'post', slug: 'second-post', path: '/writing/second-post.md' },
      { type: 'post', slug: 'first-post', path: '/writing/first-post.md' },
      { type: 'case-study', slug: 'a-case-study', path: '/work/a-case-study.md' },
    ]);
  });

  test('does not embed the résumé four times over its own format manifest', () => {
    // /llms.txt's Resume section links the SAME document as .md, .json, .pdf
    // and HTML. Parsing it as a document list would produce four sources.
    const resumeSources = corpusSources(LLMS_TXT_TODAY).filter((s) => s.type === 'resume');
    expect(resumeSources).toHaveLength(1);
  });

  test('ignores links on other origins, including the MCP endpoint', () => {
    const withForeignMarkdown = `${LLMS_TXT_TODAY}
- [Elsewhere](https://example.invalid/writing/not-ours.md): Not this site.
`;
    expect(corpusSources(withForeignMarkdown)).toEqual([RESUME_SOURCE]);
  });

  test('ignores HTML page links, which have no .md suffix', () => {
    const withPageLink = `${LLMS_TXT_TODAY}
- [A Post](https://ryanlindsey.me/writing/a-post/): The page, not the export.
`;
    expect(corpusSources(withPageLink)).toEqual([RESUME_SOURCE]);
  });

  test('lists a document once even when it is linked twice', () => {
    const linkedTwice = `${LLMS_TXT_TODAY}
- [A Post](https://ryanlindsey.me/writing/a-post.md): One.
- [A Post again](https://ryanlindsey.me/writing/a-post.md): Two.
`;
    expect(corpusSources(linkedTwice)).toHaveLength(2);
  });

  test('keeps a nested slug intact', () => {
    const nested = `${LLMS_TXT_TODAY}
- [Nested](https://ryanlindsey.me/writing/2026/a-post.md): Nested slug.
`;
    expect(corpusSources(nested)[1]).toEqual({
      type: 'post',
      slug: '2026/a-post',
      path: '/writing/2026/a-post.md',
    });
  });
});

// --- ids and metadata ---------------------------------------------------

describe('chunk ids', () => {
  test('are <type>:<slug>:<n>, so a re-run updates instead of duplicating', () => {
    expect(chunkId(source(), 0)).toBe('post:a-post:0');
    expect(chunkId(source({ type: 'case-study', slug: 'a-study' }), 2)).toBe(
      'case-study:a-study:2',
    );
    expect(chunkId(RESUME_SOURCE, 0)).toBe('resume:resume:0');
  });

  test('chunkIdsFor expands a document key to the ids it owns', () => {
    expect(chunkIdsFor(documentKey(source()), 3)).toEqual([
      'post:a-post:0',
      'post:a-post:1',
      'post:a-post:2',
    ]);
    expect(chunkIdsFor('post:a-post', 0)).toEqual([]);
  });
});

describe('metadata', () => {
  test('is exactly { tier, type }', () => {
    expect(metadataFor(RESUME_SOURCE)).toEqual({ tier: 'public', type: 'resume' });
    expect(Object.keys(metadataFor(source()))).toEqual(['tier', 'type']);
  });

  test('every value this job can emit fits the 64-byte metadata-index prefix', () => {
    const types: CorpusSource['type'][] = ['post', 'case-study', 'resume'];
    for (const type of [...types]) {
      const metadata = metadataFor(source({ type }));
      for (const [name, value] of Object.entries(metadata)) {
        expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(
          METADATA_INDEX_BYTE_LIMIT,
        );
        expect(() => assertShortMetadataValue(name, value)).not.toThrow();
      }
    }
    expect(CORPUS_TIER).toBe('public');
  });

  test('assertShortMetadataValue throws past the prefix, rather than shipping an unfilterable vector', () => {
    expect(() => assertShortMetadataValue('tier', 'x'.repeat(65))).toThrow(/64/);
    expect(() => assertShortMetadataValue('tier', 'x'.repeat(64))).not.toThrow();
    // Bytes, not characters: 32 three-byte characters is 96 bytes.
    expect(() => assertShortMetadataValue('type', '€'.repeat(32))).toThrow(/96 bytes/);
  });
});

// --- chunkMarkdown ------------------------------------------------------

describe('chunkMarkdown', () => {
  test('does not split a document that already fits', () => {
    expect(estimateTokens(RESUME_MARKDOWN)).toBeLessThan(MAX_CHUNK_TOKENS);
    const chunks = chunkMarkdown(RESUME_MARKDOWN);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('# Ryan Lindsey');
    expect(chunks[0]).toContain('RED Digital Cinema');
  });

  test('splits on heading boundaries when a document is over budget', () => {
    const body = paragraph(900);
    const markdown = `# Title\n\n## One\n\n${body}\n\n## Two\n\n${body}\n\n## Three\n\n${body}\n`;
    const chunks = chunkMarkdown(markdown);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Rule 1: a chunk never spans a sibling-or-shallower heading.
      expect(headingsAt(chunk, 2).length).toBeLessThanOrEqual(1);
    }
    expect(chunks.some((chunk) => chunk.includes('## Two'))).toBe(true);
  });

  test('does not split a small document just because it has sibling headings', () => {
    // The regression this pins: an earlier chunker cut on every sibling heading
    // regardless of size, turning a short post into a pile of 40-token
    // fragments.
    const markdown = `## Experience\n\n### Weedmaps\n\nA role.\n\n### RED\n\nAnother role.\n\n## Education\n\nNone.\n`;
    expect(chunkMarkdown(markdown)).toHaveLength(1);
  });

  test('cuts at the shallowest heading, keeping each section with its subsections', () => {
    // 1,200 + 600 estimated tokens: over budget as a whole, but `## Experience`
    // and its two `###` subsections fit together, so the only cut is the `##`
    // boundary.
    const markdown = `## Experience\n\n### Weedmaps\n\n${paragraph(600)}\n\n### RED\n\n${paragraph(600)}\n\n## Education\n\n${paragraph(600)}\n`;
    const chunks = chunkMarkdown(markdown);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('### Weedmaps');
    expect(chunks[0]).toContain('### RED');
    expect(chunks[1]).toContain('## Education');
    expect(chunks[1]).not.toContain('### RED');
  });

  test('cuts deeper when one section is over budget on its own', () => {
    const markdown = `## Experience\n\n### Weedmaps\n\n${paragraph(900)}\n\n### RED\n\n${paragraph(900)}\n`;
    const chunks = chunkMarkdown(markdown);
    // `##` offers no cut here (there is only one), so the `###` boundary does.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.includes('### RED'))).toBe(true);
    for (const chunk of chunks) {
      expect(headingsAt(chunk, 3).length).toBeLessThanOrEqual(1);
    }
  });

  test('does not strand the lead-in above the first section as its own chunk', () => {
    const markdown = `# Title\n\n## One\n\n${paragraph(900)}\n\n## Two\n\n${paragraph(900)}\n`;
    const chunks = chunkMarkdown(markdown);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('# Title');
    expect(chunks[0]).toContain('## One');
  });

  test('never emits a chunk over the target, or over the model input limit', () => {
    const markdown = [
      '# Title',
      '',
      paragraph(400),
      '',
      '## One',
      '',
      paragraph(5000),
      '',
      '## Two',
      '',
      paragraph(20),
    ].join('\n');
    const chunks = chunkMarkdown(markdown);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
      expect(estimateTokens(chunk)).toBeLessThan(MODEL_INPUT_TOKEN_LIMIT);
    }
  });

  test('hard-splits a single paragraph with no internal structure', () => {
    const chunks = chunkMarkdown(`# Title\n\n${'x'.repeat(MAX_CHUNK_TOKENS * 4 * 3)}\n`);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
  });

  test('does not treat a comment inside a fenced code block as a heading', () => {
    // Deliberately over budget, so the chunker actually has to choose a cut.
    // Without fence tracking, `# install the thing` reads as the shallowest
    // heading in the document and becomes the cut point -- so this asserts on a
    // document where the bug would change the output, not one where it could
    // not.
    const markdown = [
      '## Setup',
      '',
      paragraph(1000),
      '',
      '```bash',
      '# install the thing',
      'npm install',
      '```',
      '',
      paragraph(1000),
    ].join('\n');
    const chunks = chunkMarkdown(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith('# install the thing')).toBe(false);
    }
    expect(chunks.join('\n')).toContain('# install the thing');
  });

  test('emits no empty chunks and loses no words', () => {
    const markdown = `---\ntitle: "A Post"\n---\n\nIntro.\n\n## One\n\n${paragraph(1200)}\n\n## Two\n\n${paragraph(1200)}\n`;
    const chunks = chunkMarkdown(markdown);
    for (const chunk of chunks) expect(chunk.trim()).not.toBe('');

    const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
    expect(words(chunks.join('\n'))).toEqual(words(markdown));
  });

  test('an empty document produces no chunks at all', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('\n\n   \n')).toEqual([]);
  });
});

// --- documentHash -------------------------------------------------------

describe('documentHash', () => {
  test('is a stable hex SHA-256 of the same input', async () => {
    const first = await documentHash('resume:resume', RESUME_MARKDOWN);
    const second = await documentHash('resume:resume', RESUME_MARKDOWN);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test('moves when the markdown moves', async () => {
    const before = await documentHash('resume:resume', RESUME_MARKDOWN);
    const after = await documentHash('resume:resume', `${RESUME_MARKDOWN}\n## Skills\n`);
    expect(after).not.toBe(before);
  });

  test('is keyed per document, so two documents with identical text do not alias', async () => {
    const post = await documentHash('post:a-post', 'Same body.');
    const study = await documentHash('case-study:a-post', 'Same body.');
    expect(post).not.toBe(study);
  });
});

// --- planCorpusRefresh --------------------------------------------------

describe('planCorpusRefresh', () => {
  const manifest = (): CorpusManifest => ({
    'resume:resume': entry({ key: 'resume:resume', hash: 'resume-hash', chunks: 1 }),
    'post:a-post': entry({ key: 'post:a-post', hash: 'post-hash', chunks: 3 }),
  });

  test('skips a document whose hash has not moved', () => {
    const plan = planCorpusRefresh(manifest(), [
      document({ source: RESUME_SOURCE, hash: 'resume-hash' }),
      document({ hash: 'post-hash' }),
    ]);
    expect(plan.embed).toEqual([]);
    expect(plan.unchanged).toEqual(['resume:resume', 'post:a-post']);
    expect(plan.staleIds).toEqual([]);
  });

  test('embeds a document whose hash has moved', () => {
    const plan = planCorpusRefresh(manifest(), [
      document({ source: RESUME_SOURCE, hash: 'resume-hash' }),
      document({ hash: 'post-hash-2' }),
    ]);
    expect(plan.embed.map((d) => documentKey(d.source))).toEqual(['post:a-post']);
    expect(plan.unchanged).toEqual(['resume:resume']);
  });

  test('embeds a document the manifest has never seen', () => {
    const plan = planCorpusRefresh({}, [document({ source: RESUME_SOURCE, hash: 'resume-hash' })]);
    expect(plan.embed).toHaveLength(1);
    expect(plan.unchanged).toEqual([]);
  });

  test('deletes every vector of a document that is no longer published', () => {
    // A post going back to draft: true drops out of /llms.txt, and its vectors
    // must drop out of the index with it.
    const plan = planCorpusRefresh(manifest(), [
      document({ source: RESUME_SOURCE, hash: 'resume-hash' }),
    ]);
    expect(plan.removed).toEqual(['post:a-post']);
    expect(plan.staleIds).toEqual(['post:a-post:0', 'post:a-post:1', 'post:a-post:2']);
  });

  test('force re-embeds everything and reports nothing unchanged', () => {
    const plan = planCorpusRefresh(
      manifest(),
      [document({ source: RESUME_SOURCE, hash: 'resume-hash' }), document({ hash: 'post-hash' })],
      { force: true },
    );
    expect(plan.embed).toHaveLength(2);
    expect(plan.unchanged).toEqual([]);
  });
});

describe('corpusRefreshEnabled', () => {
  // Only the var is read, but the parameter is the full CorpusEnv -- see its
  // doc comment for why a narrower Pick does not compile at the real call site.
  // The bindings are never touched, so a cast is honest here in a way a fake
  // `Ai` or `VectorizeIndex` would not be.
  const envWith = (CORPUS_REFRESH?: string): CorpusEnv =>
    ({ SITE_ORIGIN: 'https://ryanlindsey.me', CORPUS_REFRESH }) as unknown as CorpusEnv;

  test('defaults to on, so the deployed default comes from the var being absent', () => {
    expect(corpusRefreshEnabled(envWith())).toBe(true);
    expect(corpusRefreshEnabled(envWith('on'))).toBe(true);
  });

  test('is off only when something says so', () => {
    expect(corpusRefreshEnabled(envWith('off'))).toBe(false);
  });

  test('refuses to guess at a value it does not know', () => {
    // Same house rule as RESUME_PDF_RENDERER: a typo that silently disabled the
    // refresh forever would be indistinguishable from a corpus with nothing to
    // do.
    expect(() => corpusRefreshEnabled(envWith('false'))).toThrow(/CORPUS_REFRESH/);
    expect(() => corpusRefreshEnabled(envWith(''))).toThrow(/CORPUS_REFRESH/);
  });
});

describe('surplusChunkIds', () => {
  test('drops the ids a shrunk document no longer owns', () => {
    expect(surplusChunkIds(entry({ key: 'post:a-post', chunks: 3 }), 2)).toEqual(['post:a-post:2']);
  });

  test('returns nothing when a document grew or held steady', () => {
    expect(surplusChunkIds(entry({ chunks: 2 }), 3)).toEqual([]);
    expect(surplusChunkIds(entry({ chunks: 2 }), 2)).toEqual([]);
  });

  test('returns nothing for a document the manifest has never seen', () => {
    expect(surplusChunkIds(undefined, 2)).toEqual([]);
  });
});

// --- refreshCorpus: what happens when a run does not finish ---------------
//
// WHAT THESE TESTS DO AND DO NOT CLAIM (fix round 2). They say NOTHING about
// whether the corpus works: the bindings below are hand-written fakes, and the
// module doc at the top of this file explains why a green run against a fake
// (or against wrangler's local Vectorize simulation) would prove nothing about
// `ryanlindsey-me-corpus`. The embed/upsert/query round trip stays where it
// was verified, by hand against the live index in task-15-report.md.
//
// What they DO cover is `refreshCorpus`'s own control flow -- the order it does
// things in and where it commits -- which is not a fact about Vectorize at all
// and is exactly what fix round 2 changed:
//
//   1. an unpublished document's vectors were deleted AFTER the embed loop, so
//      any throw in that loop left them in the index answering queries; and
//   2. the manifest was written ONCE, at the very end, so any throw discarded
//      the record of every document already embedded -- and paid for -- and
//      the next run re-embedded and re-billed all of them.
//
// Both are latent today (one document, `staleIds` always empty), which is the
// argument for fixing them before content makes them live rather than after.

/** A vector of the right width. Values are irrelevant; nothing here compares them. */
const fakeVector = (): number[] => Array.from({ length: CORPUS_DIMENSIONS }, () => 0.1);

interface FakeCorpus {
  env: CorpusEnv;
  /** Vector ids currently "in the index", sorted. */
  vectorIds: () => string[];
  /** The manifest as actually committed to KV -- not the value refreshCorpus returned. */
  committedManifest: () => CorpusManifest;
  /** Every chunk text handed to `AI.run`, in order: this is the billing record. */
  embedded: string[];
}

/**
 * The four bindings `refreshCorpus` touches, and nothing else. Deliberately
 * hand-written rather than mocked with a library: each one is a few lines, and
 * writing them out is what makes it obvious that they simulate storage and
 * ordering only, with no opinion about embeddings or similarity.
 */
function fakeCorpus(options: {
  assets: Record<string, string>;
  manifest?: CorpusManifest;
  seedVectorIds?: string[];
  /** Makes `AI.run` throw for any chunk containing this substring. */
  failEmbedContaining?: string;
}): FakeCorpus {
  const vectors = new Set<string>(options.seedVectorIds ?? []);
  const kv = new Map<string, string>();
  if (options.manifest) kv.set(CORPUS_MANIFEST_KEY, JSON.stringify(options.manifest));
  const embedded: string[] = [];

  const env = {
    SITE_ORIGIN: 'https://ryanlindsey.me',
    ASSETS: {
      fetch: async (input: string) => {
        const body = options.assets[new URL(input).pathname];
        return body === undefined ? new Response('nope', { status: 404 }) : new Response(body);
      },
    },
    AI: {
      run: async (_model: string, input: { documents: string[] }) => {
        for (const chunk of input.documents) {
          if (
            options.failEmbedContaining !== undefined &&
            chunk.includes(options.failEmbedContaining)
          ) {
            throw new Error('corpus test: embedding failed');
          }
          embedded.push(chunk);
        }
        return { data: input.documents.map(fakeVector) };
      },
    },
    VECTORIZE: {
      upsert: async (batch: { id: string }[]) => {
        for (const vector of batch) vectors.add(vector.id);
        return { mutationId: 'mutation-test' };
      },
      deleteByIds: async (ids: string[]) => {
        for (const id of ids) vectors.delete(id);
        return { mutationId: 'mutation-test' };
      },
    },
    KV_CACHE: {
      get: async (key: string) => {
        const value = kv.get(key);
        return value === undefined ? null : JSON.parse(value);
      },
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
  } as unknown as CorpusEnv;

  return {
    env,
    vectorIds: () => [...vectors].sort(),
    committedManifest: () => {
      const value = kv.get(CORPUS_MANIFEST_KEY);
      return value === undefined ? {} : (JSON.parse(value) as CorpusManifest);
    },
    embedded,
  };
}

/** The `.md` bodies the populated /llms.txt fixture above points at. */
const POPULATED_ASSETS: Record<string, string> = {
  '/llms.txt': LLMS_TXT_POPULATED,
  '/resume.md': RESUME_MARKDOWN,
  '/writing/second-post.md': '# Second Post\n\nThe newer post body.\n',
  '/writing/first-post.md': '# First Post\n\nThe older post body.\n',
  '/work/a-case-study.md': '# A Case Study\n\nWhat happened, at length.\n',
};

describe('refreshCorpus', () => {
  test('embeds every published document once, then embeds nothing on a re-run', async () => {
    // The baseline the two failure tests below are departures from: a clean run
    // upserts one vector per chunk and commits an entry per document, and the
    // next run finds every hash unmoved and bills nothing.
    const corpus = fakeCorpus({ assets: POPULATED_ASSETS });

    const first = await refreshCorpus(corpus.env);
    expect(first.embedded.map((document) => document.key)).toEqual([
      'resume:resume',
      'post:second-post',
      'post:first-post',
      'case-study:a-case-study',
    ]);
    expect(corpus.vectorIds()).toEqual([
      'case-study:a-case-study:0',
      'post:first-post:0',
      'post:second-post:0',
      'resume:resume:0',
    ]);
    expect(Object.keys(corpus.committedManifest()).sort()).toEqual([
      'case-study:a-case-study',
      'post:first-post',
      'post:second-post',
      'resume:resume',
    ]);

    const embeddedAfterFirstRun = corpus.embedded.length;
    const second = await refreshCorpus(corpus.env);
    expect(second.embedded).toEqual([]);
    expect(second.unchanged).toHaveLength(4);
    expect(
      corpus.embedded.length,
      'a run over unchanged content must not embed (bill for) anything',
    ).toBe(embeddedAfterFirstRun);
  });

  test("deletes an unpublished document's vectors even when the run later fails", async () => {
    // The leak the old ordering allowed: `post:gone` is in the manifest but no
    // longer in /llms.txt, so its vectors must go -- and they must go whether or
    // not the rest of the run succeeds. Here the résumé's embedding throws, which
    // under the old order (delete AFTER the embed loop) meant the delete never
    // ran at all and an unpublished document kept answering queries.
    const corpus = fakeCorpus({
      assets: { '/llms.txt': LLMS_TXT_TODAY, '/resume.md': RESUME_MARKDOWN },
      manifest: {
        'post:gone': entry({ key: 'post:gone', hash: 'gone-hash', chunks: 2 }),
      },
      seedVectorIds: ['post:gone:0', 'post:gone:1'],
      failEmbedContaining: 'Senior Engineering Manager',
    });

    await expect(refreshCorpus(corpus.env)).rejects.toThrow(/embedding failed/);

    expect(
      corpus.vectorIds(),
      "an unpublished document's vectors must not survive a failed run",
    ).toEqual([]);
    expect(
      corpus.committedManifest(),
      'and the removal must be committed, so the next run does not re-delete blind',
    ).toEqual({});
  });

  test('keeps what it already embedded when a later document fails, so a retry re-bills nothing', async () => {
    // The re-billing the single end-of-run manifest write caused: three
    // documents embed successfully, the fourth throws, and with one write at the
    // end the first three were paid for and then forgotten -- every subsequent
    // run re-embedded all of them, forever, for as long as the fourth kept
    // failing.
    const corpus = fakeCorpus({
      assets: POPULATED_ASSETS,
      failEmbedContaining: 'What happened, at length.',
    });

    await expect(refreshCorpus(corpus.env)).rejects.toThrow(/embedding failed/);
    const afterFailedRun = [...corpus.embedded];
    expect(
      afterFailedRun,
      'the three documents before the failure should have embedded',
    ).toHaveLength(3);
    expect(Object.keys(corpus.committedManifest()).sort()).toEqual([
      'post:first-post',
      'post:second-post',
      'resume:resume',
    ]);

    // The retry: the same failure, and nothing already paid for is paid for
    // again. Only the still-broken document is attempted.
    await expect(refreshCorpus(corpus.env)).rejects.toThrow(/embedding failed/);
    expect(
      corpus.embedded,
      'a retry must re-embed nothing that already succeeded and committed',
    ).toEqual(afterFailedRun);
  });
});
