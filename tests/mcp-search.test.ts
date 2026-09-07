import { expect, test } from 'vitest';
import { CORPUS_EMBEDDING_MODEL, chunkMarkdown } from '../src/lib/corpus';
import { citationFor, embedQuery, excerptFor, parseChunkId } from '../src/lib/mcp/search';

// Task 9's pure half. No bindings, no index, no credentials -- the same split
// tests/corpus.test.ts draws for the same reason: `env.VECTORIZE` under the
// harness is a LOCAL SIMULATION holding no vectors and `env.AI` is a mock
// service binding (tests/workers.ts), so a retrieval assertion made against
// either of them would be green and worthless.
//
// What IS covered here is the half that decides whether a citation is honest:
// the chunk-id grammar the corpus job writes, the re-chunking that rebuilds
// the cited passage on read, and the shape of the query-side embedding call.
// The retrieval round trip itself is verified by hand against the live index
// in Task 16.

test('parses the chunk id shape the corpus job writes', () => {
  expect(parseChunkId('post:a-post:2')).toEqual({ type: 'post', slug: 'a-post', chunk: 2 });
  expect(parseChunkId('resume:resume:0')).toEqual({ type: 'resume', slug: 'resume', chunk: 0 });
});

test('rejects ids it does not recognise instead of guessing', () => {
  expect(parseChunkId('post:a-post')).toBeNull();
  expect(parseChunkId('nonsense')).toBeNull();
  expect(parseChunkId('other:a:0')).toBeNull();
});

// Slugs may contain colons? They may not -- but the id is built by string
// concatenation, so the parser must be anchored on the LAST segment rather
// than split naively, or a slug with a colon would silently mis-parse.
test('takes the chunk index from the last segment', () => {
  expect(parseChunkId('post:a:b:3')).toEqual({ type: 'post', slug: 'a:b', chunk: 3 });
});

test('returns the same text the embedding job embedded', () => {
  const markdown = ['# One', 'a'.repeat(8000), '# Two', 'b'.repeat(8000)].join('\n\n');
  const chunks = chunkMarkdown(markdown);
  const { text, exact } = excerptFor(markdown, 1, chunks.length);
  expect(exact).toBe(true);
  expect(text).toBe(chunks[1]);
});

// The failure this guards is the quiet one: if chunkMarkdown ever changes
// without a re-embed, chunk N of the re-chunked document is no longer the
// text that produced vector N, and the citation would point at real content
// that does not contain the match.
test('reports inexact rather than returning a mismatched excerpt', () => {
  const markdown = '# One\n\nshort\n';
  const { exact } = excerptFor(markdown, 0, 7);
  expect(exact).toBe(false);
});

test('an exact citation carries the chunk index it matched', () => {
  const markdown = ['# One', 'a'.repeat(8000), '# Two', 'b'.repeat(8000)].join('\n\n');
  const chunks = chunkMarkdown(markdown);

  const citation = citationFor({
    type: 'post',
    slug: 'a-post',
    chunk: 1,
    score: 0.42,
    url: 'https://ryanlindsey.me/writing/a-post/',
    markdown,
    expectedChunks: chunks.length,
  });

  expect(citation.exact).toBe(true);
  expect(citation.chunk).toBe(1);
  expect(citation.excerpt).toBe(chunks[1]);
});

/**
 * The degraded citation, and the two things that must both be true of it.
 *
 * It has to SAY it is degraded (`exact: false`), and it must not keep the
 * chunk index next to an excerpt that is not that chunk -- a caller that
 * ignores `exact` would otherwise read "chunk 5 of this case study says
 * <the document's opening>", which is a claim nobody made. Dropping the
 * index leaves the worst available misreading at "this document is
 * relevant, here is its opening", which is true.
 */
test('a degraded citation says so and drops the chunk index it cannot stand behind', () => {
  const markdown = '# One\n\nshort\n';

  const citation = citationFor({
    type: 'case-study',
    slug: 'silent-failure',
    chunk: 5,
    score: 0.9,
    url: 'https://ryanlindsey.me/work/silent-failure/',
    markdown,
    expectedChunks: 7,
  });

  expect(citation.exact).toBe(false);
  // ABSENT, not null and not undefined -- the same "omit, don't null" contract
  // the document tools follow for metadata a document does not declare.
  expect(citation).not.toHaveProperty('chunk');
  // The property that holds no matter what: the excerpt is still text from the
  // cited document, under the cited document's own URL.
  expect(markdown).toContain(citation.excerpt);
  expect(citation.url).toBe('https://ryanlindsey.me/work/silent-failure/');
});

test('embeds the query query-side, with the plural schema key', async () => {
  const calls: unknown[] = [];
  const ai = {
    run: async (_model: string, input: unknown) => {
      calls.push(input);
      return { data: [Array.from({ length: 1024 }, () => 0)] };
    },
  } as unknown as Ai;

  await embedQuery(ai, 'agentic engineering');

  // The KEY, not merely that AI was called. `documents` returns a vector
  // 0.717 cosine away from the right one (measured day 3, recorded in
  // workers/mcp/wrangler.jsonc), so getting this wrong degrades every search
  // result forever and breaks nothing loudly.
  expect(Object.keys(calls[0] as object)).toEqual(['queries']);
  expect((calls[0] as { queries: string[] }).queries).toEqual(['agentic engineering']);
});

test('asks the same model the corpus was embedded with', async () => {
  const models: string[] = [];
  const ai = {
    run: async (model: string) => {
      models.push(model);
      return { data: [[]] };
    },
  } as unknown as Ai;

  await embedQuery(ai, 'x');

  // A query embedded by a different model lands in a different space and
  // retrieves noise that looks like results.
  expect(models[0]).toBe(CORPUS_EMBEDDING_MODEL);
});
