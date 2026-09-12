import { readFileSync } from 'node:fs';
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
import { ARCHITECTURE_DESCRIPTION, ARCHITECTURE_TITLE } from '../src/lib/architecture';

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
  orgScale?: string;
  domain?: string;
  outcomes?: string[];
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
      orgScale: overrides.orgScale,
      domain: overrides.domain,
      outcomes: overrides.outcomes,
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

  // Task 7 (03 §2): org scale, domain and outcomes, case studies only.
  test('carries orgScale, domain and outcomes for a case study that declares all three', () => {
    const entry = caseStudy({
      id: 'c',
      orgScale: '~200-engineer department',
      domain: 'cannabis-tech marketplace',
      outcomes: ['Replaced guessed delivery dates with calibrated forecasts', 'Adopted org-wide'],
    });
    expect(frontmatterFor(entry)).toEqual({
      title: 'A Case Study',
      description: 'A case study about something.',
      publishedAt: '2026-09-06',
      orgScale: '~200-engineer department',
      domain: 'cannabis-tech marketplace',
      outcomes: ['Replaced guessed delivery dates with calibrated forecasts', 'Adopted org-wide'],
      canonical: `${SITE_ORIGIN}/work/c/`,
    });
  });

  test('omits orgScale, domain and outcomes for a case study that declares none, rather than nulling them', () => {
    // Assert absence, not `undefined` -- a "declares none" entry produces
    // frontmatter with no trace of the key at all (see content.config.ts's
    // schema comment and summarize's matching read-side rule).
    const frontmatter = frontmatterFor(caseStudy({ id: 'c' }));
    expect(frontmatter).not.toHaveProperty('orgScale');
    expect(frontmatter).not.toHaveProperty('domain');
    expect(frontmatter).not.toHaveProperty('outcomes');
  });

  test('a post frontmatter has no orgScale, domain or outcomes keys at all', () => {
    // The mirror of the case-study assertion above: posts never carry these
    // three, and this module must not invent them for a collection 03 §2
    // asks nothing of.
    const frontmatter = frontmatterFor(post({ id: 'p' }));
    expect(frontmatter).not.toHaveProperty('orgScale');
    expect(frontmatter).not.toHaveProperty('domain');
    expect(frontmatter).not.toHaveProperty('outcomes');
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

  test('escapes an embedded double quote', () => {
    const entry = post({ id: 'p', title: 'A "Quoted" Title' });
    expect(toMarkdown(entry)).toContain('title: "A \\"Quoted\\" Title"');
  });

  test('quotes a title starting with # so it cannot read as a YAML comment', () => {
    const entry = post({ id: 'p', title: '#1 in the series' });
    expect(toMarkdown(entry)).toContain('title: "#1 in the series"');
  });

  test('escapes an embedded newline instead of leaving a raw one for a parser to fold to a space', () => {
    // A real YAML parser line-folds a raw newline inside a double-quoted flow
    // scalar to a space -- that is the spec's behaviour, not a parser bug --
    // so a raw newline here would silently and irreversibly merge two lines
    // the next time this frontmatter is read back.
    const entry = post({ id: 'p', title: 'Line one\nLine two' });
    const rendered = toMarkdown(entry);
    expect(rendered).toContain('title: "Line one\\nLine two"');
    const [frontmatterBlock] = rendered.split('\n---\n');
    expect(frontmatterBlock).not.toMatch(/title: "[^"]*\n[^"]*"/);
  });

  test('emits orgScale, domain and outcomes for a case study that declares them, as a YAML block list', () => {
    const entry = caseStudy({
      id: 'c',
      orgScale: 'Team of 12',
      domain: 'B2B fintech',
      outcomes: ['Shipped in six weeks', 'Zero incidents since launch'],
    });
    expect(toMarkdown(entry)).toBe(
      [
        '---',
        'title: "A Case Study"',
        'description: "A case study about something."',
        'publishedAt: "2026-09-06"',
        'orgScale: "Team of 12"',
        'domain: "B2B fintech"',
        'outcomes:',
        '  - "Shipped in six weeks"',
        '  - "Zero incidents since launch"',
        `canonical: "${SITE_ORIGIN}/work/c/"`,
        '---',
        '',
        'Body text.',
        '',
      ].join('\n'),
    );
  });

  test('a case study declaring none of the three has no trace of them in the rendered frontmatter', () => {
    const rendered = toMarkdown(caseStudy({ id: 'c' }));
    expect(rendered).not.toContain('orgScale');
    expect(rendered).not.toContain('domain');
    expect(rendered).not.toContain('outcomes');
  });

  // Fix round 2 (post-review): frontmatterFor deliberately treats a
  // declared-but-falsy value as still declared (`!== undefined`, not a
  // truthy check) -- but frontmatterYaml used to use a truthy check one layer
  // down, silently dropping it again at serialization. These two tests cover
  // the two falsy shapes the schema allows: an empty string (orgScale,
  // domain) and an empty array (outcomes), which get DIFFERENT, deliberate
  // treatment -- see frontmatterYaml's FIX ROUND 2 comment for why.
  test('emits orgScale and domain as empty strings when declared falsy, rather than dropping them', () => {
    const entry = caseStudy({ id: 'c', orgScale: '', domain: '' });
    expect(frontmatterFor(entry)).toMatchObject({ orgScale: '', domain: '' });
    const rendered = toMarkdown(entry);
    expect(rendered).toContain('orgScale: ""');
    expect(rendered).toContain('domain: ""');
  });

  test('omits outcomes when declared as an empty array -- a documented exception, not a silent drop', () => {
    // frontmatterFor still treats `outcomes: []` as declared, matching
    // orgScale/domain above. frontmatterYaml omits it anyway: an empty block
    // list has no shape parseFrontmatter can tell apart from "key absent" (its
    // reader needs at least one `- ` item to recognise a list at all), so a
    // bare `outcomes:` stub would buy no round-trip fidelity over omitting it
    // -- this is the one place the two layers disagree on purpose.
    const entry = caseStudy({ id: 'c', outcomes: [] });
    expect(frontmatterFor(entry)).toHaveProperty('outcomes', []);
    expect(toMarkdown(entry)).not.toContain('outcomes');
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

<RelatedPosts slugs="a,b" />

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

// Fix round 1 (post-review): three adversarial inputs reproduced against the
// round-1 regexes produced silent corruption rather than a build failure --
// same-tag nesting, an attribute value containing a bare `>`, and an inline
// (single-backtick) code span that was not exempted the way triple-backtick
// fences already were. All three are exercised here against the actual
// exported functions, not a standalone copy of the regexes.
describe('fix round 1: the stripper fails loudly instead of shipping corruption', () => {
  test('same-tag nesting throws instead of leaving a literal unstripped tag in the output', () => {
    // Round 1 produced "outer <Aside>inner end</Aside>" here -- a literal,
    // unstripped `<Aside>` fragment shipped as if it were clean markdown.
    const input = '<Aside>outer <Aside>inner</Aside> end</Aside>';
    expect(() => stripNonPortableMdx(input)).toThrow(/component tag survived/);
  });

  test('an attribute expression containing a bare > throws instead of shipping a garbage fragment', () => {
    // Round 1 produced `" 5}>Important note."` here: the `<Aside level={x`
    // prefix was silently swallowed as if it were the tag's own opening
    // bracket, against this module's OWN allowlisted component. Excluding
    // `{` from the attribute scan means the tag now fails to match at all --
    // it survives untouched in the input to the guard, which then throws.
    const input = '<Aside level={x > 5}>Important note.</Aside>';
    expect(() => stripNonPortableMdx(input)).toThrow(/component tag survived/);
  });

  test('a leftover tag anywhere in an otherwise-clean document still throws, not just in isolation', () => {
    const input =
      'Clean prose before.\n\n<Broken prop={a > b}>never stripped</Broken>\n\nClean prose after.';
    expect(() => stripNonPortableMdx(input)).toThrow(/component tag survived/);
  });

  test('an inline single-backtick code span mentioning a component is exempted, not corrupted', () => {
    // The undisclosed round-1 bug: only triple-backtick fences were exempt.
    // Round 1 turned this into "For example, `` renders a callout." --
    // deleting the entire code span's content. Post 1 on this site's plan is
    // a build log about this repository, which will very naturally use
    // inline backticks around a component name -- this is not hypothetical.
    const input = 'For example, `<Aside type="note" />` renders a callout.';
    expect(stripNonPortableMdx(input)).toBe(input);
  });

  test('toMarkdown propagates the throw rather than swallowing it', () => {
    const entry = post({ id: 'p', body: '<Aside level={x > 5}>Important note.</Aside>' });
    expect(() => toMarkdown(entry)).toThrow(/component tag survived/);
  });
});

describe('ExportableEntry', () => {
  test('accepts both posts and case studies at the type level', () => {
    const entries: ExportableEntry[] = [post({ id: 'p' }), caseStudy({ id: 'c' })];
    expect(entries).toHaveLength(2);
  });
});

// --- The architecture diagram's text fallback -------------------------------
//
// `<ArchitectureDiagram />` renders an inline SVG, which is nothing at all in
// the markdown an agent reads. Stripping it silently is what the exporter did
// until now, and it left agent-native-site.mdx's own prose pointing at a
// drawing that was not there in the `.md` variant -- the exact class of defect
// the post containing that tag is about.
//
// THE FALLBACK IS NOT A SECOND DESCRIPTION. It is the same `<desc>` string the
// SVG already carries for screen readers, lifted into src/lib/architecture.ts
// so the drawing and the markdown cannot drift apart. ArchitectureDiagram.astro
// documents two claims in its own first draft that came from a stale copy of
// the architecture and were false; a hand-written second description here would
// be that same mistake with a longer fuse. The last test in this block is what
// makes the extraction safe, and it is the reason this is one module and not
// two strings.
describe('the architecture diagram exports a text fallback', () => {
  test('substitutes the shared description for the component tag', () => {
    const stripped = stripNonPortableMdx('Before.\n\n<ArchitectureDiagram />\n\nAfter.');
    expect(stripped).toContain(ARCHITECTURE_TITLE);
    expect(stripped).toContain(ARCHITECTURE_DESCRIPTION);
    expect(stripped).not.toContain('<ArchitectureDiagram');
    expect(stripped).toContain('Before.');
    expect(stripped).toContain('After.');
  });

  test('leaves the tag verbatim inside inline code, which the build-log post does', () => {
    const input = 'The post names `<ArchitectureDiagram />` in prose.';
    expect(stripNonPortableMdx(input)).toBe(input);
  });

  test('leaves the tag verbatim inside a fence', () => {
    const input = 'Prose.\n\n```mdx\n<ArchitectureDiagram />\n```\n\nMore prose.';
    expect(stripNonPortableMdx(input)).toContain('```mdx\n<ArchitectureDiagram />\n```');
  });

  test('a component with no fallback is still dropped rather than substituted', () => {
    const stripped = stripNonPortableMdx('<RelatedPosts slugs="a,b" />\n\nProse.');
    expect(stripped).not.toContain('RelatedPosts');
    expect(stripped).toContain('Prose.');
  });

  test('the drawing and the markdown read one string, not two copies', () => {
    const astro = readFileSync(
      new URL('../src/components/ArchitectureDiagram.astro', import.meta.url),
      'utf8',
    );
    expect(astro).toContain("from '../lib/architecture'");
    // If someone re-inlines the prose here, the SVG a visitor sees and the
    // markdown an agent reads can disagree with no test noticing. That is the
    // whole failure this block exists to prevent, so it is asserted directly
    // rather than trusted to review.
    //
    // WHITESPACE IS COLLAPSED ON BOTH SIDES, and the first version of this
    // assertion was wrong for want of it. It picked one phrase, "independent
    // sinks", and asserted its absence -- but that phrase also appears in this
    // component's own header comment, where it describes why Analytics Engine
    // does not feed the queue, so the assertion was already true before the
    // extraction and would have passed against a fully inlined copy. Comparing
    // the whole string is what makes it discriminating; collapsing whitespace
    // is what survives Prettier wrapping an inlined copy across lines.
    const collapse = (text: string) => text.replace(/\s+/g, ' ');
    expect(collapse(astro)).not.toContain(collapse(ARCHITECTURE_DESCRIPTION));
  });

  test('the shared description carries no em dash, because it ships as published prose', () => {
    // house-style targets zero in published prose, and check-prose.mjs cannot
    // see this string: it classifies any line indented four spaces or more as
    // indented code, and every continuation line in an Astro template is
    // indented, so the `<desc>` block passed the checker vacuously for as long
    // as it lived there. Now that the same string is emitted into `.md`,
    // `/llms-full.txt`, the feeds and the corpus, the rule plainly applies.
    expect(ARCHITECTURE_DESCRIPTION).not.toMatch(/[—–]/);
  });
});
