import { describe, expect, test } from 'vitest';
import type { CollectionEntry } from 'astro:content';
import {
  SITE_ORIGIN,
  canonicalUrlFor,
  frontmatterFor,
  stripNonPortableMdx,
  toMarkdown,
  type ExportableEntry,
} from '../src/lib/markdown-export';

const post = (overrides: {
  id?: string;
  title?: string;
  body?: string;
  updatedAt?: Date;
  series?: { name: string; order: number };
}): CollectionEntry<'posts'> =>
  ({
    id: overrides.id ?? 'a-post',
    collection: 'posts',
    body: overrides.body ?? 'Body text.',
    data: {
      title: overrides.title ?? 'A Post',
      description: 'A post about something.',
      publishedAt: new Date('2026-09-04T00:00:00Z'),
      updatedAt: overrides.updatedAt,
      pillar: 'agentic-engineering',
      series: overrides.series,
      draft: false,
    },
  }) as unknown as CollectionEntry<'posts'>;

const caseStudy = (overrides: {
  id?: string;
  body?: string;
  updatedAt?: Date;
}): CollectionEntry<'caseStudies'> =>
  ({
    id: overrides.id ?? 'a-case-study',
    collection: 'caseStudies',
    body: overrides.body ?? 'Body text.',
    data: {
      title: 'A Case Study',
      description: 'A case study about something.',
      publishedAt: new Date('2026-09-06T00:00:00Z'),
      updatedAt: overrides.updatedAt,
      draft: false,
    },
  }) as unknown as CollectionEntry<'caseStudies'>;

describe('canonicalUrlFor', () => {
  test('builds a /writing/<id>/ URL for posts', () => {
    expect(canonicalUrlFor(post({ id: 'type-specimen' }))).toBe(
      `${SITE_ORIGIN}/writing/type-specimen/`,
    );
  });

  test('builds a /work/<id>/ URL for case studies', () => {
    expect(canonicalUrlFor(caseStudy({ id: 'shape-specimen' }))).toBe(
      `${SITE_ORIGIN}/work/shape-specimen/`,
    );
  });
});

describe('frontmatterFor', () => {
  test('carries pillar and series for a post that declares both', () => {
    const entry = post({ id: 'p', series: { name: 'Building in the open', order: 2 } });
    expect(frontmatterFor(entry)).toEqual({
      title: 'A Post',
      description: 'A post about something.',
      publishedAt: '2026-09-04',
      pillar: 'agentic-engineering',
      series: { name: 'Building in the open', order: 2 },
      canonical: `${SITE_ORIGIN}/writing/p/`,
    });
  });

  test('omits updatedAt and series when the post has neither', () => {
    const frontmatter = frontmatterFor(post({ id: 'p' }));
    expect(frontmatter).not.toHaveProperty('updatedAt');
    expect(frontmatter).not.toHaveProperty('series');
  });

  test('includes updatedAt, formatted YYYY-MM-DD, when the post has one', () => {
    const frontmatter = frontmatterFor(post({ id: 'p', updatedAt: new Date('2026-09-05') }));
    expect(frontmatter.updatedAt).toBe('2026-09-05');
  });

  test('a case study frontmatter has no pillar or series keys at all', () => {
    // Not "pillar: undefined" -- content.config.ts gives caseStudies no
    // pillar field, and this module must not invent one (see the comment in
    // frontmatterFor).
    const frontmatter = frontmatterFor(caseStudy({ id: 'c' }));
    expect(frontmatter).not.toHaveProperty('pillar');
    expect(frontmatter).not.toHaveProperty('series');
    expect(frontmatter).toMatchObject({
      title: 'A Case Study',
      description: 'A case study about something.',
      publishedAt: '2026-09-06',
      canonical: `${SITE_ORIGIN}/work/c/`,
    });
  });
});

describe('toMarkdown', () => {
  test('emits a stable frontmatter block, in field order, then the body', () => {
    const entry = post({
      id: 'p',
      body: 'Real prose, unchanged.',
      updatedAt: new Date('2026-09-05'),
      series: { name: 'Building in the open', order: 2 },
    });
    expect(toMarkdown(entry)).toBe(
      [
        '---',
        'title: "A Post"',
        'description: "A post about something."',
        'publishedAt: "2026-09-04"',
        'updatedAt: "2026-09-05"',
        'pillar: agentic-engineering',
        'series:',
        '  name: "Building in the open"',
        '  order: 2',
        `canonical: "${SITE_ORIGIN}/writing/p/"`,
        '---',
        '',
        'Real prose, unchanged.',
        '',
      ].join('\n'),
    );
  });

  test('uses entry.body verbatim for ordinary prose, not a rendered/derived form', () => {
    const body = 'Body with **bold**, `code`, and a [link](https://example.com).';
    expect(toMarkdown(post({ body }))).toContain(body);
  });

  test('quotes a title containing a colon so it cannot corrupt the YAML block', () => {
    const entry = post({ id: 'p', title: 'Title: With a Colon' });
    expect(toMarkdown(entry)).toContain('title: "Title: With a Colon"');
  });
});

// The component-stripping fixture. Neither src/content specimen uses a
// component beyond a code fence (the brief calls this out by name), so this
// fixture is written to actually exercise every branch of
// stripNonPortableMdx rather than adding a fourth vacuous test to a codebase
// that has already shipped three: a deleted `.sort()` left six tests green, a
// `stripXKeys` test passed with nothing to strip, and a stale-serve test
// passed with the behaviour it claimed to test removed.
const MDX_FIXTURE = `import Aside from '../../components/Aside.astro';
import {
  Foo,
  Bar,
} from '../../lib/foo';
import '../../styles/one-off.css';

# Real heading

Ordinary prose survives untouched, including \`inline code\`.

<Aside>An allowlisted note that should survive, unwrapped.</Aside>

<RelatedPosts slugs={['a', 'b']} />

<Callout type="warning">This entire block, including this sentence, should disappear.</Callout>

A code sample that must NOT be touched, because it is inside a fence:

\`\`\`jsx
import Aside from '../../components/Aside.astro';
<Aside>literal example text, inside a fence, must not be stripped</Aside>
\`\`\`

Prose after the fence survives too.
`;

describe('stripNonPortableMdx (component and import stripping)', () => {
  const stripped = stripNonPortableMdx(MDX_FIXTURE);

  test('removes every real import statement, single- and multi-line', () => {
    // The one `import ` left standing is inside the fenced code sample --
    // asserted separately below -- so this counts occurrences rather than
    // asserting absence outright.
    expect(stripped.split('import ').length - 1).toBe(1);
    expect(stripped).not.toContain("from '../../lib/foo'");
    expect(stripped).not.toContain('../../styles/one-off.css');
    expect(stripped).not.toContain('Foo,');
    expect(stripped).not.toContain('Bar,');
  });

  test('unwraps an allowlisted component, keeping its children', () => {
    expect(stripped).toContain('An allowlisted note that should survive, unwrapped.');
    // The one `<Aside>`/`</Aside>` pair left standing is inside the fenced
    // code sample -- asserted separately below -- so this counts occurrences
    // of the real (prose) usage rather than asserting absence outright.
    expect(stripped.split('<Aside>').length - 1).toBe(1);
    expect(stripped.split('</Aside>').length - 1).toBe(1);
  });

  test('drops a self-closing non-allowlisted component entirely', () => {
    expect(stripped).not.toContain('RelatedPosts');
    expect(stripped).not.toContain('slugs=');
  });

  test('drops a paired non-allowlisted component and its children, not just its tags', () => {
    expect(stripped).not.toContain('Callout');
    expect(stripped).not.toContain('This entire block, including this sentence, should disappear.');
  });

  test('leaves a fenced code block byte-for-byte untouched, even one containing an import and JSX', () => {
    expect(stripped).toContain(
      "import Aside from '../../components/Aside.astro';\n<Aside>literal example text, inside a fence, must not be stripped</Aside>",
    );
  });

  test('keeps ordinary prose before and after the stripped material', () => {
    expect(stripped).toContain('# Real heading');
    expect(stripped).toContain('Ordinary prose survives untouched, including `inline code`.');
    expect(stripped).toContain('Prose after the fence survives too.');
  });

  test('end to end: toMarkdown on a real post applies the same stripping to entry.body', () => {
    const rendered = toMarkdown(post({ id: 'p', body: MDX_FIXTURE }));
    expect(rendered).toContain('An allowlisted note that should survive, unwrapped.');
    expect(rendered).not.toContain('RelatedPosts');
    expect(rendered).not.toContain('Callout');
    // The real (prose) import of Aside is gone; the one inside the fenced
    // code sample survives -- exactly one occurrence left, inside the fence.
    const occurrences =
      rendered.split("import Aside from '../../components/Aside.astro';").length - 1;
    expect(occurrences).toBe(1);
    expect(rendered).toContain("```jsx\nimport Aside from '../../components/Aside.astro';");
  });
});

describe('ExportableEntry', () => {
  test('accepts both posts and case studies at the type level', () => {
    const entries: ExportableEntry[] = [post({ id: 'p' }), caseStudy({ id: 'c' })];
    expect(entries).toHaveLength(2);
  });
});
