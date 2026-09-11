import { describe, expect, test } from 'vitest';
import type { DocumentsEnv } from '../src/lib/mcp/documents';
import {
  buildCorpusContext,
  CONTEXT_CHAR_BUDGET,
  renderContext,
} from '../src/lib/fit/corpus-context';

const block = (n: number, size = 20) => ({
  url: `https://ryanlindsey.me/writing/post-${n}/`,
  title: `Post ${n}`,
  markdown: 'x'.repeat(size),
});

test('each block is fenced and labelled with the URL that may cite it', () => {
  const { text } = renderContext([block(1)]);
  expect(text).toContain('https://ryanlindsey.me/writing/post-1/');
  expect(text).toContain('Post 1');
  // Fenced, so pasted content cannot be read as instructions -- the same
  // defence 04 §1 asks for on the chat path, applied here because a target
  // description is also text a stranger supplies.
  expect(text).toMatch(/```/);
});

test('a document carrying its own fence is wrapped in a longer one', () => {
  // THE DEFECT THIS PINS. This render used to carry a literal ``` fence, so a
  // corpus document containing its own ``` run closed the wrapper early and put
  // everything after it OUTSIDE the boundary -- in the position where
  // instructions live, in a prompt whose system text says fenced content is
  // data. The published post terminal-setup.mdx has 14 such blocks, so this was
  // live rather than theoretical.
  //
  // The assertion above (`toMatch(/```/)`) cannot catch it: a longer fence
  // contains ``` too, so it passed either way.
  const hostile = 'before\n```js\nalert(1)\n```\nafter';
  const { text } = renderContext([{ ...block(1), markdown: hostile }]);

  const open = text.indexOf('````markdown');
  expect(open, 'the wrapper must be longer than the longest run inside it').toBeGreaterThan(-1);
  const close = text.indexOf('````', open + '````markdown'.length);
  expect(close).toBeGreaterThan(open);

  // The load-bearing one: every byte of the document sits between the two
  // wrapper fences. Under the old literal fence `after` fell outside.
  expect(text.slice(open, close)).toContain('after');
});

test('the budget is respected and the shortfall is reported', () => {
  const { text, truncated } = renderContext([block(1, 500), block(2, 500)], 600);
  expect(text.length).toBeLessThanOrEqual(900); // body plus per-block framing
  expect(truncated).toBe(true);
});

test('nothing is truncated when everything fits', () => {
  expect(renderContext([block(1), block(2)], CONTEXT_CHAR_BUDGET).truncated).toBe(false);
});

test('a truncated context still contains whole documents, never half of one', () => {
  // A half-document is worse than a missing one: the model would cite a URL
  // for a passage it never saw the end of, and the citation would validate.
  const { text } = renderContext([block(1, 400), block(2, 400)], 500);
  const bodies = text.match(/x+/g) ?? [];
  // Fix round 1, finding 2: `.every()` on an empty array is vacuously true,
  // so a regression that dropped BOTH blocks (not just the one that should
  // be dropped) would have passed the length check below undetected. This
  // pins the count too: exactly one body survived, and it is whole.
  expect(bodies).toHaveLength(1);
  expect(bodies.every((body) => body.length === 400)).toBe(true);
});

test('an empty corpus renders an explicit statement rather than an empty string', () => {
  // The prompt's honesty rule leans on the context saying something. An empty
  // string would leave the model to invent what it could not see.
  const { text } = renderContext([]);
  expect(text.trim().length).toBeGreaterThan(0);
  expect(text).toMatch(/no documents/i);
});

// buildCorpusContext has no coverage in the brief -- only renderContext, the
// pure formatter it wraps, is tested above. buildCorpusContext is the part
// that talks to the corpus (index, fetch, and the allowedUrls recomputation
// enforceCitations trusts completely), so it is the part that matters most
// to get right. tests/fit-engine.test.ts (a later task) stubs DocumentsEnv
// the same way; this is where that shape is established.
describe('buildCorpusContext', () => {
  const ORIGIN = 'https://ryanlindsey.me';

  /** Same stub shape as tests/mcp-documents.test.ts: a routes map over paths. */
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

  const LLMS_TXT = [
    `- [Post One](${ORIGIN}/writing/post-one.md): One line.`,
    `- [Post Two](${ORIGIN}/writing/post-two.md): Another line.`,
  ].join('\n');

  test('a /llms.txt listing two documents produces a context holding both', async () => {
    // /resume.md is deliberately unserved. fetchDocumentIndex always
    // prepends RESUME_SOURCE (src/lib/corpus.ts), so leaving it a 404 here
    // exercises the ordinary skip path and keeps this test's count at
    // exactly the two documents /llms.txt lists, per the brief addition.
    const env = stubSite({
      '/llms.txt': LLMS_TXT,
      '/writing/post-one.md': 'Body of post one.',
      '/writing/post-two.md': 'Body of post two.',
    });

    const context = await buildCorpusContext(env);

    expect(context.text).toContain(`${ORIGIN}/writing/post-one/`);
    expect(context.text).toContain(`${ORIGIN}/writing/post-two/`);
    expect(context.documents).toBe(2);
    expect(context.allowedUrls).toEqual(
      new Set([`${ORIGIN}/writing/post-one/`, `${ORIGIN}/writing/post-two/`]),
    );
  });

  test('a document the index lists but that will not fetch is skipped, not fatal', async () => {
    // post-two.md 404s, standing in for a broken deploy or a doc pulled
    // after /llms.txt was generated. The other document must still make it
    // through -- a broken deploy should narrow the evidence, not refuse to
    // produce a report.
    const env = stubSite({
      '/llms.txt': LLMS_TXT,
      '/writing/post-one.md': 'Body of post one.',
    });

    const context = await buildCorpusContext(env);

    expect(context.text).toContain(`${ORIGIN}/writing/post-one/`);
    expect(context.text).not.toContain(`${ORIGIN}/writing/post-two/`);
    expect(context.documents).toBe(1);
    expect(context.allowedUrls).toEqual(new Set([`${ORIGIN}/writing/post-one/`]));
  });

  test('a document dropped by the budget loses its citation licence', async () => {
    // The load-bearing case: allowedUrls is recomputed from what was
    // actually rendered, not from what was fetched. If that recomputation
    // regressed, the model could cite a URL for a document it was never
    // shown, and enforceCitations (src/lib/fit/schema.ts) would validate the
    // citation anyway, because the URL is real. Sizes and budget match the
    // renderContext truncation test above, which already establishes that a
    // 400-char body under a 500-char budget fits one block and not two.
    const env = stubSite({
      '/llms.txt': LLMS_TXT,
      '/writing/post-one.md': 'x'.repeat(400),
      '/writing/post-two.md': 'y'.repeat(400),
    });

    // buildCorpusContext's second parameter exists only so this test can
    // force a shortfall -- see the comment on its signature in
    // corpus-context.ts. Production code never passes it.
    const context = await buildCorpusContext(env, 500);

    expect(context.text).toContain(`${ORIGIN}/writing/post-one/`);
    expect(context.text).not.toContain(`${ORIGIN}/writing/post-two/`);
    expect(context.allowedUrls.has(`${ORIGIN}/writing/post-one/`)).toBe(true);
    expect(context.allowedUrls.has(`${ORIGIN}/writing/post-two/`)).toBe(false);
    // Fix round 1, finding 3: tests 1 and 2 above never distinguish
    // `documents` from `blocks.length`/the fetched count, because nothing
    // was dropped in either of them. This is the one case that can tell
    // "what survived truncation" apart from "what was fetched".
    expect(context.documents).toBe(1);
    expect(context.truncated).toBe(true);
  });

  // Fix round 1, finding 1. The previous recomputation searched the whole
  // rendered `text` for each fetched URL (`text.includes(url)`), which a
  // KEPT document's own markdown can defeat: a résumé or case study linking
  // to a related post is ordinary content on this site. post-one's body
  // below links to post-two's canonical URL; post-two is dropped by the
  // budget, but its URL still appears in `text` as a substring of
  // post-one's link -- so a text search wrongly re-admits it, while the
  // model was never shown post-two at all.
  test('a rendered document linking to a dropped document does not re-admit its URL', async () => {
    const env = stubSite({
      '/llms.txt': LLMS_TXT,
      '/writing/post-one.md': `See also [Post Two](${ORIGIN}/writing/post-two/).`,
      '/writing/post-two.md': 'y'.repeat(400),
    });

    const context = await buildCorpusContext(env, 300);

    // The URL genuinely is present in `text` -- inside post-one's own link
    // -- which is exactly what makes a substring search unsound here.
    expect(context.text).toContain(`${ORIGIN}/writing/post-two/`);
    expect(context.allowedUrls.has(`${ORIGIN}/writing/post-one/`)).toBe(true);
    expect(context.allowedUrls.has(`${ORIGIN}/writing/post-two/`)).toBe(false);
    expect(context.truncated).toBe(true);
  });
});
