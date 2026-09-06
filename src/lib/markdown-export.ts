import type { CollectionEntry } from 'astro:content';

// Shared markdown exporter (day 3 Task 6). `.md` variant routes (Task 7), the
// `Accept:`-negotiated responses (Task 8), `/llms-full.txt` (Task 9), the
// feeds' full content (Task 11) and the corpus chunker (Task 15) all need the
// same thing: clean markdown for one collection entry. Building it once here
// is the point -- five re-implementations would drift, the same lesson day 2's
// inline `SeriesNav` bug taught this repo (src/lib/series.ts) and Task 3
// re-learned for résumé rendering (`groupWorkByCompany` in src/lib/resume.ts).
//
// Draft handling is deliberately NOT this module's job. `toMarkdown` and
// `frontmatterFor` render whatever entry they are given, published or not --
// the consuming routes (Task 7's `.md` routes, Task 9's `/llms.txt`, etc.) are
// the ones with the "never serve a draft" invariant, and each of them already
// has its own `!entry.data.draft` filter for the HTML route it mirrors. Baking
// a draft check in here would be a second, easy-to-forget place that
// invariant has to hold.

/**
 * The two collections this exporter renders. `resume` is excluded on purpose:
 * it already has its own dedicated Markdown renderer (Task 3's
 * `src/lib/resume.ts` + `/resume.md`), and `resumeSchema` doesn't carry the
 * `title`/`description`/`publishedAt` shape this module assumes.
 */
export type ExportableEntry = CollectionEntry<'posts'> | CollectionEntry<'caseStudies'>;

/**
 * Mirrors astro.config.mjs's `site`. Not imported from there: astro.config.mjs
 * pulls in the Cloudflare adapter and the Tailwind Vite plugin just to build
 * the config object, and this is a pure lib module meant to run under a plain
 * `vitest run` process with nothing Astro-flavoured loaded -- the same reason
 * src/lib/resume.ts gives for keeping `astro:content` a type-only import. A
 * hardcoded copy is the cost of that; it is also the one constant in this
 * file, so a drift from astro.config.mjs is a one-line diff to catch.
 */
export const SITE_ORIGIN = 'https://ryanlindsey.me';

/**
 * Route section per collection -- `/writing/<id>` for posts, `/work/<id>` for
 * case studies (src/pages/writing/[...slug].astro, src/pages/work/[...slug].astro).
 */
const COLLECTION_SECTION: Record<ExportableEntry['collection'], string> = {
  posts: 'writing',
  caseStudies: 'work',
};

export interface ExportedFrontmatter {
  title: string;
  description: string;
  /** YYYY-MM-DD, matching ArticleMeta.astro's `iso()` helper. */
  publishedAt: string;
  updatedAt?: string;
  /** Posts only -- see the `caseStudies` note in `frontmatterFor`. */
  pillar?: string;
  /** Posts only, and only when the entry declares one. */
  series?: { name: string; order: number };
  canonical: string;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `https://ryanlindsey.me/writing/<id>/` or `.../work/<id>/` -- the trailing
 * slash matches the pathname Astro's directory-format build output actually
 * serves (verified against `dist/client/writing/<slug>/index.html`), which is
 * the same shape `src/layouts/Base.astro`'s `<link rel="canonical">` produces
 * from `Astro.url.pathname`. A page and its exported markdown should agree on
 * where the page lives.
 */
export function canonicalUrlFor(entry: ExportableEntry): string {
  const section = COLLECTION_SECTION[entry.collection];
  return new URL(`/${section}/${entry.id}/`, SITE_ORIGIN).href;
}

/**
 * The small, stable set of fields every exported document's frontmatter
 * carries. Deliberately not the full collection schema -- `draft` is the
 * consuming route's concern (see the module doc above), not a fact a portable
 * document needs to assert about itself.
 */
export function frontmatterFor(entry: ExportableEntry): ExportedFrontmatter {
  const frontmatter: ExportedFrontmatter = {
    title: entry.data.title,
    description: entry.data.description,
    publishedAt: isoDate(entry.data.publishedAt),
    canonical: canonicalUrlFor(entry),
  };

  if (entry.data.updatedAt) {
    frontmatter.updatedAt = isoDate(entry.data.updatedAt);
  }

  // `caseStudies` deliberately has no `pillar`/`series` (content.config.ts's
  // own comment: 02 §2 declares the three pillars for posts and asks nothing
  // of case studies, so inventing values here would extend a taxonomy nothing
  // asked for). `entry.collection === 'posts'` narrows `entry.data` to the
  // posts schema for TypeScript too.
  if (entry.collection === 'posts') {
    frontmatter.pillar = entry.data.pillar;
    if (entry.data.series) {
      frontmatter.series = entry.data.series;
    }
  }

  return frontmatter;
}

/** Double-quoted YAML scalar. Every string field is quoted, unconditionally --
 * simpler and just as correct as detecting which values would need it, and it
 * means a title containing `: ` or a leading `#` can never turn into a YAML
 * parse error or a mis-parsed key.
 */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Serializes `ExportedFrontmatter` to the YAML body of the frontmatter block
 * (no `---` fences -- `toMarkdown` adds those). Key order is fixed and matches
 * the brief exactly: `title, description, publishedAt, updatedAt?, pillar?,
 * series?, canonical`. Fixed order is what "small, stable" means here -- a
 * document a model re-reads on every request should not reshuffle its own
 * frontmatter from one build to the next.
 */
function frontmatterYaml(frontmatter: ExportedFrontmatter): string {
  const lines = [
    `title: ${yamlString(frontmatter.title)}`,
    `description: ${yamlString(frontmatter.description)}`,
    `publishedAt: ${yamlString(frontmatter.publishedAt)}`,
  ];

  if (frontmatter.updatedAt) {
    lines.push(`updatedAt: ${yamlString(frontmatter.updatedAt)}`);
  }
  if (frontmatter.pillar) {
    // An enum value from content.config.ts's `pillar` -- always a bare
    // lowercase-and-hyphens identifier, never needs quoting.
    lines.push(`pillar: ${frontmatter.pillar}`);
  }
  if (frontmatter.series) {
    lines.push('series:');
    lines.push(`  name: ${yamlString(frontmatter.series.name)}`);
    lines.push(`  order: ${frontmatter.series.order}`);
  }
  lines.push(`canonical: ${yamlString(frontmatter.canonical)}`);

  return lines.join('\n');
}

// --- MDX -> portable markdown -------------------------------------------
//
// entry.body is raw MDX, not rendered HTML (see the module doc above and
// src/lib/reading-time.ts, which reads entry.body for the same reason). MDX
// can carry two things that mean nothing outside this site: import
// statements, and JSX component tags. Both are stripped below; neither
// specimen file in src/content uses a component beyond a code fence, so
// tests/markdown-export.test.ts carries its own fixture with real imports and
// real component usage rather than letting this path go untested by the real
// content (the task brief calls this out explicitly, and this repo has
// shipped three vacuous tests already -- a deleted `.sort()` call, a
// `stripXKeys` test with nothing to strip, and a stale-serve test that passed
// with its own behaviour removed).

/**
 * Paired component tags whose children are ordinary prose worth keeping in a
 * portable document -- the tag itself is site-specific presentation, but what
 * it wraps is not. Deliberately small, per the brief, and easy to grow: this
 * site's content does not use any component in its body text yet (both
 * specimens are `draft: true` proofs of the article template), so this list
 * reflects a plan for the day real posts start using one, not an inventory.
 */
const PORTABLE_COMPONENTS = new Set(['Aside']);

/** Splits on fenced code blocks, capturing the fences. Odd indices of the
 * result are the fences themselves (kept byte-for-byte); even indices are the
 * prose between them, which is what gets stripped. A code sample that happens
 * to contain literal `<SomeComponent>` text is prose *about* a component, not
 * a use of one -- splitting on fences first is what keeps the two from being
 * confused.
 */
const FENCE = /(```[\s\S]*?```)/g;

/**
 * Matches one ES module import statement, single- or multi-line, including
 * bare side-effect imports (`import '...';`). Anchored on `import` at the
 * start of a line and closed by a quoted module specifier -- not just "starts
 * with import and ends with a semicolon" -- so an ordinary sentence that
 * happens to start with the word "import" is not mistaken for one and does
 * not swallow everything up to its next unrelated semicolon.
 */
const IMPORT_STATEMENT = /^[ \t]*import\s+(?:[^;]*?\bfrom\s+)?['"][^'"]*['"]\s*;?[ \t]*\n?/gm;

/** `<Foo ... />`. Matched and removed before paired tags -- see stripComponentTags. */
const SELF_CLOSING_COMPONENT = /<([A-Z][A-Za-z0-9]*)\b[^>]*?\/>/g;

/** `<Foo ...>...</Foo>`, non-greedy so nested *different*-named components
 * (e.g. `<Card><Aside>...</Aside></Card>`) resolve at the right boundary.
 * Same-named nesting is not something this site's content does and is not
 * handled -- a known limitation, not a silent one.
 */
const PAIRED_COMPONENT = /<([A-Z][A-Za-z0-9]*)\b[^>]*>([\s\S]*?)<\/\1>/g;

function stripImportStatements(prose: string): string {
  return prose.replace(IMPORT_STATEMENT, '');
}

function stripComponentTags(prose: string): string {
  // Self-closing components first: with paired-tag stripping run first
  // instead, its lazy `[\s\S]*?` would treat an earlier, unrelated
  // `<Foo ... />` as the open half of a pair and swallow everything up to
  // some later, unrelated `</Foo>`.
  const withoutSelfClosing = prose.replace(SELF_CLOSING_COMPONENT, '');
  return withoutSelfClosing.replace(PAIRED_COMPONENT, (_match, tag: string, children: string) =>
    PORTABLE_COMPONENTS.has(tag) ? children : '',
  );
}

/**
 * Drops whatever an MDX body carries that does not travel outside this site:
 * import statements everywhere, and component tags everywhere except inside
 * fenced code. An unrecognized component tag is replaced with nothing --
 * tag and children both -- rather than left as raw JSX source text, which
 * would read as broken markdown to anything downstream. A recognized
 * (`PORTABLE_COMPONENTS`) tag is unwrapped instead: the wrapper is
 * site-specific, but its children are prose the author actually wrote.
 */
export function stripNonPortableMdx(body: string): string {
  const segments = body.split(FENCE);
  const cleaned = segments.map((segment, index) =>
    // Odd indices are the fenced blocks FENCE captured verbatim -- left alone.
    index % 2 === 1 ? segment : stripComponentTags(stripImportStatements(segment)),
  );
  return cleaned
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The full portable document: a small YAML frontmatter block followed by
 * `entry.body`, stripped of what doesn't travel. Higher fidelity than
 * anything derived from rendered HTML or round-tripped through a markdown
 * converter -- Astro 7's Sätteri processor has no remark pipeline to borrow,
 * and `markdown-it` would not reproduce Sätteri's rendered output anyway. See
 * the module doc above.
 */
export function toMarkdown(entry: ExportableEntry): string {
  const frontmatter = frontmatterFor(entry);
  const body = stripNonPortableMdx(entry.body ?? '');
  return `---\n${frontmatterYaml(frontmatter)}\n---\n\n${body}\n`;
}
