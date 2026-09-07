import { describe, expect, test } from 'vitest';
import {
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
  surplusChunkIds,
  type CorpusDocumentEntry,
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
  test('defaults to on, so the deployed default comes from the var being absent', () => {
    expect(corpusRefreshEnabled({})).toBe(true);
    expect(corpusRefreshEnabled({ CORPUS_REFRESH: 'on' })).toBe(true);
  });

  test('is off only when something says so', () => {
    expect(corpusRefreshEnabled({ CORPUS_REFRESH: 'off' })).toBe(false);
  });

  test('refuses to guess at a value it does not know', () => {
    // Same house rule as RESUME_PDF_RENDERER: a typo that silently disabled the
    // refresh forever would be indistinguishable from a corpus with nothing to
    // do.
    expect(() => corpusRefreshEnabled({ CORPUS_REFRESH: 'false' })).toThrow(/CORPUS_REFRESH/);
    expect(() => corpusRefreshEnabled({ CORPUS_REFRESH: '' })).toThrow(/CORPUS_REFRESH/);
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
