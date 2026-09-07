import { describe, expect, test } from 'vitest';
import { RESUME_SOURCE } from '../src/lib/corpus';
import {
  fetchDocument,
  fetchDocumentIndex,
  fetchResumeJson,
  pageUrlFor,
  parseFrontmatter,
  summarize,
  type DocumentsEnv,
} from '../src/lib/mcp/documents';

const ORIGIN = 'https://ryanlindsey.me';

function stubSite(routes: Record<string, string>): DocumentsEnv {
  return {
    SITE_ORIGIN: ORIGIN,
    SITE: {
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
        const body = routes[path];
        return body === undefined
          ? new Response('not found', { status: 404 })
          : new Response(body, { status: 200 });
      },
    },
  } as DocumentsEnv;
}

const POST_MD = `---
title: A Post
description: One line about it.
publishedAt: '2026-09-01'
canonical: https://ryanlindsey.me/writing/a-post/
---

# A Post

Body text.
`;

describe('pageUrlFor', () => {
  test('maps each type to the route the site serves it under', () => {
    expect(pageUrlFor(RESUME_SOURCE, ORIGIN)).toBe(`${ORIGIN}/resume`);
    expect(pageUrlFor({ type: 'post', slug: 'a-post', path: '/writing/a-post.md' }, ORIGIN)).toBe(
      `${ORIGIN}/writing/a-post/`,
    );
    expect(pageUrlFor({ type: 'case-study', slug: 'a-cs', path: '/work/a-cs.md' }, ORIGIN)).toBe(
      `${ORIGIN}/work/a-cs/`,
    );
  });
});

describe('parseFrontmatter', () => {
  test('splits the block from the body and leaves the body byte-exact', () => {
    const { data, body } = parseFrontmatter(POST_MD);
    expect(data.title).toBe('A Post');
    expect(data.description).toBe('One line about it.');
    expect(body.startsWith('# A Post')).toBe(true);
  });

  test('returns the whole input as body when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('# Bare\n\ntext\n');
    expect(data).toEqual({});
    expect(body).toBe('# Bare\n\ntext\n');
  });

  // The chunker that produced the corpus vectors ran over the WHOLE asset,
  // frontmatter included. A body-only excerpt would not line up with the
  // embedded chunk, so search must never route through this function.
  test('does not mutate the document it was given', () => {
    const before = POST_MD;
    parseFrontmatter(POST_MD);
    expect(POST_MD).toBe(before);
  });

  // `yamlString` (src/lib/markdown-export.ts) escapes `\` FIRST, then `"`,
  // `\r`, `\n` -- so a plaintext value containing a literal backslash
  // immediately followed by `n` (exactly what a post about JS string escapes
  // would write) encodes its backslash as a doubled `\\` ahead of that `n`.
  // Undoing the four escapes as independent, sequential passes is unsound
  // for input like this: a pass that matches `\n` fires on the SECOND half
  // of the doubled backslash plus the following `n`, producing a real
  // newline and leaving the first backslash stranded, rather than the
  // literal two-character `\n` the author wrote. The decoder must be one
  // coordinated pass, not four independent ones.
  test('decodes a double-quoted value through the escaping yamlString actually produces', () => {
    const plaintext = 'Escaping \\n in JS strings'; // a literal backslash then `n`, not a newline
    const encoded = plaintext.replace(/\\/g, '\\\\'); // yamlString's own first escaping pass
    const markdown = ['---', `title: "${encoded}"`, '---', '', 'Body.', ''].join('\n');

    expect(parseFrontmatter(markdown).data.title).toBe(plaintext);
  });
});

describe('fetchDocumentIndex', () => {
  test('returns the resume plus every document /llms.txt links', async () => {
    const env = stubSite({
      '/llms.txt': [
        '# Ryan Lindsey',
        '',
        '## Writing',
        '',
        `- [A Post](${ORIGIN}/writing/a-post.md): One line about it.`,
        '',
        '## Case studies',
        '',
        `- [A Case](${ORIGIN}/work/a-cs.md): Another line.`,
        '',
      ].join('\n'),
    });

    const index = await fetchDocumentIndex(env);
    expect(index.map((s) => `${s.type}:${s.slug}`)).toEqual([
      'resume:resume',
      'post:a-post',
      'case-study:a-cs',
    ]);
  });

  test('throws rather than reporting an empty site when /llms.txt is missing', async () => {
    await expect(fetchDocumentIndex(stubSite({}))).rejects.toThrow(/llms\.txt/);
  });
});

describe('fetchDocument', () => {
  test('returns null on 404 rather than throwing', async () => {
    const env = stubSite({});
    expect(
      await fetchDocument(env, { type: 'post', slug: 'nope', path: '/writing/nope.md' }),
    ).toBeNull();
  });
});

describe('fetchResumeJson', () => {
  test('returns the parsed JSON when published, and null when it is not', async () => {
    const resume = { basics: { name: 'Ryan Lindsey' } };
    const env = stubSite({ '/resume.json': JSON.stringify(resume) });
    expect(await fetchResumeJson(env)).toEqual(resume);
    expect(await fetchResumeJson(stubSite({}))).toBeNull();
  });
});

describe('summarize', () => {
  test('carries title, description and both URLs', () => {
    const summary = summarize(
      { type: 'post', slug: 'a-post', path: '/writing/a-post.md' },
      POST_MD,
      ORIGIN,
    );
    expect(summary).toMatchObject({
      type: 'post',
      slug: 'a-post',
      title: 'A Post',
      description: 'One line about it.',
      url: `${ORIGIN}/writing/a-post/`,
      markdownUrl: `${ORIGIN}/writing/a-post.md`,
    });
  });
});
