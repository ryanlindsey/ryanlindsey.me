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
  /** Case studies only (03 §2), and only when the entry declares it. */
  orgScale?: string;
  /** Case studies only, and only when the entry declares it. */
  domain?: string;
  /** Case studies only, and only when the entry declares it. */
  outcomes?: string[];
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
 *
 * `orgScale`, `domain` and `outcomes` (case studies only, Task 7, 03 §2) are
 * the one addition to that smallness since this comment was written, and they
 * earn their place by the same test the rest of the set already passes: a
 * machine consumer (`list_case_studies`) asked for them BY NAME. They stay
 * optional and are emitted only when the entry declares them -- see
 * `content.config.ts`'s schema comment for why a required field would have
 * been the wrong call, and `summarize` in `src/lib/mcp/documents.ts` for the
 * matching rule on the read side (an omitted field is absent, never `null`).
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
  } else {
    // caseStudies: the mirror image of the branch above. Posts have no
    // `orgScale`/`domain`/`outcomes` (02 §2 asks nothing of posts either), and
    // each of these three is copied ONLY when the entry declares it -- an
    // `undefined` here must not become a key on `frontmatter`, the same
    // reason `summarize`'s `OPTIONAL_KEYS` loop checks presence explicitly
    // rather than assigning unconditionally.
    if (entry.data.orgScale !== undefined) frontmatter.orgScale = entry.data.orgScale;
    if (entry.data.domain !== undefined) frontmatter.domain = entry.data.domain;
    if (entry.data.outcomes !== undefined) frontmatter.outcomes = entry.data.outcomes;
  }

  return frontmatter;
}

/**
 * Double-quoted YAML scalar. Every string field is quoted, unconditionally --
 * simpler and just as correct as detecting which values would need it, and it
 * means a title containing `: ` or a leading `#` can never turn into a YAML
 * parse error or a mis-parsed key.
 *
 * Backslashes and double quotes are escaped so they cannot break out of the
 * quoted scalar. `\r`/`\n` are ALSO escaped, to the two-character `\r`/`\n`
 * sequences, and not left as raw control characters -- a raw newline inside a
 * double-quoted flow scalar is line-folded to a space by every real YAML
 * parser (that is the flow-scalar folding rule the spec defines, not a bug in
 * any particular parser), so an unescaped `"Line one\nLine two"` would
 * silently and irreversibly become `"Line one Line two"` on the very next
 * parse. Escaping it as the literal two-character sequence is what makes it
 * round-trip back to an actual embedded newline.
 */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Serializes `ExportedFrontmatter` to the YAML body of the frontmatter block
 * (no `---` fences -- `toMarkdown` adds those). Key order is fixed and matches
 * the brief exactly: `title, description, publishedAt, updatedAt?, pillar?,
 * series?, orgScale?, domain?, outcomes?, canonical`. Fixed order is what
 * "small, stable" means here -- a document a model re-reads on every request
 * should not reshuffle its own frontmatter from one build to the next.
 *
 * `outcomes` is the one array in this shape, and it is written as a YAML
 * block list (`- "item"` per line, two-space indented), the same nested-value
 * idiom `series` already uses below -- not a flow-style `[...]`, which
 * `src/lib/mcp/documents.ts`'s hand-rolled `parseFrontmatter` explicitly does
 * not attempt to parse either way (its own doc comment: "an unquoted list --
 * is skipped rather than guessed at"). A case study that eventually declares
 * `outcomes` is therefore visible in this export and in the rendered page, but
 * -- like a bare `series:` block -- not yet something `list_case_studies`
 * reads back out of the frontmatter; that is `parseFrontmatter`'s scope, not
 * this module's, and no case study in this repo declares one yet.
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
  if (frontmatter.orgScale) {
    lines.push(`orgScale: ${yamlString(frontmatter.orgScale)}`);
  }
  if (frontmatter.domain) {
    lines.push(`domain: ${yamlString(frontmatter.domain)}`);
  }
  if (frontmatter.outcomes) {
    lines.push('outcomes:');
    for (const outcome of frontmatter.outcomes) {
      lines.push(`  - ${yamlString(outcome)}`);
    }
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
//
// FIX ROUND 1 (post-review): the regexes below are pattern-matching, not a
// JSX parser, and round 1 shipped three ways for that to corrupt content
// SILENTLY rather than loudly -- same-tag nesting, an attribute value
// containing a bare `>`, and inline (single-backtick) code spans that were
// not exempted the way triple-backtick fences already were. All three are
// now handled, by two different mechanisms:
//
// 1. Inline code spans are exempted from stripping, same as fenced blocks
//    (see splitCodeRegions below) -- this is a real fix, not a mitigation:
//    the corruption stops happening.
// 2. Everything else is backstopped by assertNoLeftoverComponentTags, a
//    post-strip guard that THROWS if anything that still looks like a
//    component tag survives outside of code. This module cannot parse every
//    JSX shape a future component might take, and round 1's mistake was
//    guessing anyway and shipping the wrong guess silently. The guard turns
//    a wrong guess into a build failure instead -- at build time, on the
//    commit that introduced the content, not months later inside an
//    embedding nobody reads.

/**
 * Paired component tags whose children are ordinary prose worth keeping in a
 * portable document -- the tag itself is site-specific presentation, but what
 * it wraps is not. Deliberately small, per the brief, and easy to grow: this
 * site's content does not use any component in its body text yet (both
 * specimens are `draft: true` proofs of the article template), so this list
 * reflects a plan for the day real posts start using one, not an inventory.
 */
const PORTABLE_COMPONENTS = new Set(['Aside']);

/** Fenced code blocks, capturing the fences themselves. */
const FENCE = /(```[\s\S]*?```)/g;

/**
 * Inline code spans: a single backtick, no backtick or newline until the
 * next one. Real MDX prose on this site already uses these (see
 * type-specimen.mdx's `` `inline code` ``) for exactly the case that matters
 * most here -- a build-log post about this repository mentioning a component
 * name inside backticks, e.g. `` `<Aside />` ``, which must survive verbatim
 * and not be parsed as a real usage.
 */
const INLINE_CODE = /(`[^`\n]*`)/g;

/**
 * Matches one ES module import statement, single- or multi-line, including
 * bare side-effect imports (`import '...';`). Anchored on `import` at the
 * start of a line and closed by a quoted module specifier -- not just "starts
 * with import and ends with a semicolon" -- so an ordinary sentence that
 * happens to start with the word "import" is not mistaken for one and does
 * not swallow everything up to its next unrelated semicolon.
 */
const IMPORT_STATEMENT = /^[ \t]*import\s+(?:[^;]*?\bfrom\s+)?['"][^'"]*['"]\s*;?[ \t]*\n?/gm;

// The attribute-scanning portion of both tag regexes excludes `{` as well as
// `>` (`[^>{]*`, not `[^>]*`). Round 1 used `[^>]*`, which happily matched
// past a `{` and then stopped at the FIRST bare `>` it found -- including one
// inside a JS expression attribute like `level={x > 5}` -- misparsing the
// tag boundary and shipping a garbage fragment (verified: round 1 turned
// `<Aside level={x > 5}>Important note.</Aside>` into `" 5}>Important
// note."`). This module does not attempt to parse JS expressions, and
// excluding `{` means it does not pretend to: a component tag whose
// attributes contain a `{...}` expression simply fails to match at all here,
// leaving the raw tag in place, which assertNoLeftoverComponentTags below
// then catches and turns into a build failure. Refusing to guess is the fix;
// the guard is what makes refusing safe.

/** `<Foo ... />`. Matched and removed before paired tags -- see stripComponentTags. */
const SELF_CLOSING_COMPONENT = /<([A-Z][A-Za-z0-9]*)\b[^>{]*?\/>/g;

/**
 * `<Foo ...>...</Foo>`, non-greedy so nested *different*-named components
 * (e.g. `<Card><Aside>...</Aside></Card>`) resolve at the right boundary.
 * Same-named nesting (`<Aside>outer <Aside>inner</Aside> end</Aside>`) is not
 * something this site's content does, is not handled correctly by a regex
 * this simple, and is not silently shipped either: it leaves a literal
 * `<Aside>` fragment in the output (verified), which
 * assertNoLeftoverComponentTags below catches.
 */
const PAIRED_COMPONENT = /<([A-Z][A-Za-z0-9]*)\b[^>{]*>([\s\S]*?)<\/\1>/g;

/**
 * A leftover, unstripped-looking component tag: an opening tag (`<Foo`,
 * optionally followed by attributes or a self-closing `/`, then a space, `/`,
 * or `>`) or the start of a closing tag (`</Foo`). Exactly the two forms
 * task-6-report.md's fix-round-1 entry specifies.
 */
const LEFTOVER_COMPONENT_TAG = /<[A-Z]\w*[ />]|<\/[A-Z]/;

interface CodeAwareSegment {
  text: string;
  /** True for a fenced or inline code span -- passed through verbatim, never stripped or scanned. */
  code: boolean;
}

/**
 * Splits `text` into code and non-code (prose) segments: fenced blocks first
 * (outermost, since a fence can itself contain single backticks that must
 * not be mistaken for inline code spans), then inline code spans within what
 * is left. Shared by the stripper and the post-strip guard below, so the two
 * agree, by construction, on what counts as code -- a gap in this list is
 * only one gap to close, not two definitions that can drift apart.
 */
function splitCodeRegions(text: string): CodeAwareSegment[] {
  const segments: CodeAwareSegment[] = [];
  text.split(FENCE).forEach((fencePart, fenceIndex) => {
    if (fenceIndex % 2 === 1) {
      segments.push({ text: fencePart, code: true });
      return;
    }
    fencePart.split(INLINE_CODE).forEach((inlinePart, inlineIndex) => {
      if (inlinePart === '') return;
      segments.push({ text: inlinePart, code: inlineIndex % 2 === 1 });
    });
  });
  return segments;
}

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
 * Throws if anything that still looks like a component tag survives outside
 * of fenced or inline code. See the FIX ROUND 1 note above: this is the
 * backstop for every way the regex stripping above can misparse a tag rather
 * than an exhaustive fix for each one, because there isn't one -- a real JSX
 * parser is not a trade this module makes for five re-implementations'
 * worth of "clean markdown for one entry". Re-splits the ALREADY-stripped
 * body with the same splitCodeRegions used above: fences and inline-code
 * delimiters are never touched by stripping, so they are still exactly where
 * they were, and re-splitting is what lets a genuine `<Foo>` inside a code
 * sample keep being legal while the same text sitting in prose is not.
 */
function assertNoLeftoverComponentTags(strippedBody: string): void {
  for (const segment of splitCodeRegions(strippedBody)) {
    if (!segment.code && LEFTOVER_COMPONENT_TAG.test(segment.text)) {
      throw new Error(
        'markdown-export: a component tag survived MDX stripping outside of code ' +
          `(check for same-tag nesting or an unsupported attribute expression): ` +
          JSON.stringify(
            segment.text.length > 160 ? `${segment.text.slice(0, 160)}…` : segment.text,
          ),
      );
    }
  }
}

/**
 * Drops whatever an MDX body carries that does not travel outside this site:
 * import statements and component tags, everywhere except inside fenced or
 * inline code. An unrecognized component tag is replaced with nothing --
 * tag and children both -- rather than left as raw JSX source text, which
 * would read as broken markdown to anything downstream. A recognized
 * (`PORTABLE_COMPONENTS`) tag is unwrapped instead: the wrapper is
 * site-specific, but its children are prose the author actually wrote.
 *
 * Throws (via assertNoLeftoverComponentTags) rather than returning if the
 * result still looks like it contains an unstripped tag -- see FIX ROUND 1
 * above.
 */
export function stripNonPortableMdx(body: string): string {
  const cleaned = splitCodeRegions(body)
    .map((segment) =>
      segment.code ? segment.text : stripComponentTags(stripImportStatements(segment.text)),
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  assertNoLeftoverComponentTags(cleaned);
  return cleaned;
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
