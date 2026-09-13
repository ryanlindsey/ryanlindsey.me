import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { markdownToHtml } from 'satteri';
import { figures } from '../src/lib/figures.mjs';
import { literalDirectives } from '../src/lib/literal-directives.mjs';

// The invariant this file exists for (controller Ruling 7, issue #102):
// `features: { directive: true }` in astro.config.mjs was turned on for
// exactly one purpose, the `:::figures` container, so EVERY OTHER directive
// kind must behave precisely as it did before the switch was flipped. It is a
// single switch for three kinds -- container (`:::name`), leaf (`::name`) and
// text (`:name`, inline, anywhere in any paragraph) -- and an unclaimed
// directive of any kind renders as the empty string, which is ordinary prose
// losing text wherever a colon touches a word.
//
// Nothing in this suite rendered prose next to a colon before this file, which
// is how the defect survived five reviews and reached a published post's build
// output. So the assertion is deliberately not a spot check on a handful of
// strings: it is byte-identity of the rendered HTML, over a table of the
// shapes this repo's prose actually writes AND over every real content file
// that has no `:::figures` block in it.

/** Exactly the processor astro.config.mjs configures, plugins and all. */
const withDirectives = async (source: string) =>
  (
    await markdownToHtml(source, {
      features: { directive: true },
      mdastPlugins: [literalDirectives(), figures()],
    })
  ).html;

/** The same source as it rendered before the switch was flipped. */
const beforeTheSwitch = async (source: string) => (await markdownToHtml(source, {})).html;

const PROSE_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['a clock time', 'The resume PDF refresh runs at 05:17 UTC.'],
  ['two clock times in one sentence', 'Refresh at 05:47 and the corpus at 05:32.'],
  ['a ratio', 'A ratio of 3:2 applies.'],
  ['a key:value pair', 'The key is foo:bar here.'],
  ['a namespace', 'Namespace astro:content matters.'],
  ['a colon-wrapped word', 'A bare :word: here.'],
  ['a colon ending a line', 'A line ending in a colon:\n\nnext paragraph.'],
  ['a URL', 'See https://example.com/x for more.'],
  ['a colon inside emphasis', '**Bold at 05:17 inside.**'],
  ['a colon inside a link label', '[a link at 05:17](https://example.com)'],
  ['a colon in a heading', '## Deploys at 05:17 UTC'],
  ['a colon in a list', '- 05:17 — Refresh\n- 3:2 — Ratio\n'],
  ['a colon in a table cell', '| a | b |\n| --- | --- |\n| 05:17 | x |\n'],
  ['a colon in a blockquote', '> Quoted at 05:17 UTC.\n'],
  ['a colon in an inline code span', '`a code :17 span` and 05:17 outside it.\n'],
  ['a colon opening a line', ':17 leads this line.\n'],
  // The three shapes below are real directive syntax rather than punctuation,
  // and they are held to the same standard: nothing claims those names, so
  // nothing about them may change.
  ['a text directive carrying markup', ':name[**bold**] inline.'],
  ['a text directive carrying attributes', ':name[plain]{a="b"} inline.'],
  ['a leaf directive in its own paragraph', 'Before.\n\n::leafy[Label]{a="b"}\n\nAfter.'],
  ['a leaf directive with no label', 'Before.\n\n::leafy\n\nAfter.'],
];

describe('directives on changes nothing but :::figures', () => {
  test.each(PROSE_SHAPES)('renders %s byte-identically', async (_name, source) => {
    expect(await withDirectives(source)).toBe(await beforeTheSwitch(source));
  });

  test('the measured corruption is real, and it is the switch that causes it', async () => {
    // Recorded rather than merely described: with the switch on and nothing
    // restoring the unclaimed text directive, satteri 0.10.5 deletes `:17`
    // (measured 2026-09-13). If a later version stops doing this, this
    // assertion fails and whoever sees it can retire the plugin on evidence
    // rather than on a guess about what the library does now.
    const source = 'The resume PDF refresh runs at 05:17 UTC.';
    const unclaimed = (await markdownToHtml(source, { features: { directive: true } })).html;
    expect(unclaimed).toContain('at 05 UTC');
    expect(await withDirectives(source)).toContain('at 05:17 UTC');
  });

  // Two shapes byte-identity cannot cover, measured and pinned here so they
  // are a known, bounded exception rather than a gap somebody finds later. A
  // leaf directive on a line that CONTINUES a paragraph ends that block during
  // parsing, before any plugin runs, so directives-on yields two paragraphs
  // where directives-off yields one. The authored text survives either way --
  // which is the property that actually matters -- and closing the difference
  // would mean re-parsing the document, not restoring a node.
  test('a leaf directive continuing a paragraph keeps its text but not its block', async () => {
    const source = 'Some text\n::leafy\n';
    expect(await beforeTheSwitch(source)).toBe('<p>Some text\n::leafy</p>\n');
    expect(await withDirectives(source)).toBe('<p>Some text</p>\n<p>::leafy</p>\n');
  });

  test('a leaf directive continuing a list item keeps its text but not its block', async () => {
    const source = '- item\n  ::leafy\n';
    expect(await beforeTheSwitch(source)).toBe('<ul>\n<li>item\n::leafy</li>\n</ul>\n');
    expect(await withDirectives(source)).toBe('<ul>\n<li>item::leafy</li>\n</ul>\n');
  });
});

// The same invariant against the documents that actually ship, which is the
// half that would have caught this: `src/content/posts/agent-native-site.mdx`
// names three cron times, and its built page said "resume PDF at 05 UTC" while
// its own `.md` export said "05:17 UTC" -- one live post, two answers.
const CONTENT = new URL('../src/content/', import.meta.url);

const contentFiles = ['posts', 'caseStudies'].flatMap((collection) =>
  readdirSync(new URL(`${collection}/`, CONTENT))
    .filter((name) => name.endsWith('.mdx'))
    .map((name) => ({
      id: `${collection}/${name}`,
      body: readFileSync(new URL(`${collection}/${name}`, CONTENT), 'utf8'),
    })),
);

// `:::figures` is the one directive this site claims, so a file containing one
// renders differently by design and is the only fair exclusion.
const unaffected = contentFiles.filter((file) => !file.body.includes(':::figures'));

describe('every real content file with no :::figures block', () => {
  test('there are files to sweep, and at least one of them writes a colon inside a word', () => {
    // Non-vacuity, checked on the property that matters rather than on a
    // count: a sweep of documents that never put a colon next to a word would
    // pass with the plugin deleted.
    expect(unaffected.length).toBeGreaterThanOrEqual(5);
    expect(unaffected.some((file) => /\w:\w/.test(file.body))).toBe(true);
  });

  test.each(unaffected.map((file) => [file.id, file.body]))(
    '%s renders byte-identically',
    async (_id, body) => {
      expect(await withDirectives(body)).toBe(await beforeTheSwitch(body));
    },
  );
});

describe('the figures directive alongside the restore', () => {
  test('a figure value or label may contain a colon', async () => {
    // A row of key numbers is exactly where a clock time or a ratio lands, so
    // the unclaimed-text-directive defect corrupted the feature's own contract
    // as well as the prose around it: the value `05:17` rendered as `05`.
    const html = await withDirectives(
      ':::figures{source="D1"}\n- 05:17 — Refresh\n- 3:2 — Ratio\n- 1 — Runs at 05:17 UTC\n:::\n',
    );
    expect(html).toContain('>05:17</p>');
    expect(html).toContain('>3:2</p>');
    expect(html).toContain('>Runs at 05:17 UTC</p>');
  });
});
