import type { CollectionEntry } from 'astro:content';
import { ARCHITECTURE_DESCRIPTION, ARCHITECTURE_TITLE } from './architecture';

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
 * block list (`- "item"` per line, two-space indented) -- not a flow-style
 * `[...]`. That specific shape is deliberate, not cosmetic:
 * `src/lib/mcp/documents.ts`'s hand-rolled `parseFrontmatter` reads exactly
 * this block-list grammar back into a real array (Task 7 fix round 1), the
 * one nested shape besides `series`'s bare-map form it understands. A case
 * study that declares `outcomes` is therefore visible in this export, in the
 * rendered page, AND in `list_case_studies`'/`get_case_study`'s tool output --
 * the three are the same document read three ways, not three chances to
 * drift.
 *
 * FIX ROUND 2 (post-review): `orgScale`/`domain`/`outcomes` are checked here
 * with `!== undefined`, matching `frontmatterFor`'s check -- NOT a truthy
 * check. This module previously used `if (frontmatter.orgScale)` etc., which
 * silently dropped a declared-but-falsy value (`orgScale: ""`) at this layer
 * even though `frontmatterFor` had correctly kept it as declared one level
 * up -- the two layers disagreed, and the disagreement was invisible: the
 * exported document simply had no trace of a field its own source data did
 * declare, reading back through `parseFrontmatter` as fully absent. That is
 * exactly the "an omitted field is absent, never null" contract turned
 * against itself -- absence is supposed to mean "never declared," not "the
 * serializer dropped it."
 *
 * `outcomes` gets ONE deliberate, commented exception: a declared EMPTY array
 * (`outcomes: []`) is still omitted here, on purpose, not by accident. Unlike
 * a falsy scalar, an empty block list has no representation `parseFrontmatter`
 * can read back as "declared" -- its reader requires at least one `  - ` line
 * to recognise the key as a list at all; zero such lines falls through to the
 * nested-map skip, identically to the key never appearing. So a bare
 * `outcomes:` line with nothing under it would buy no round-trip fidelity
 * over omitting it entirely -- both read back as absent -- while leaving a
 * stub key with no children sitting in a real exported document, which reads
 * as a broken export to a human or an agent, not a deliberate declaration.
 * Omitting is the honest rendering of "nothing further to say" here; it is
 * `frontmatterFor` and `frontmatterYaml` disagreeing on purpose about the
 * empty-array case specifically, not the silent, unconsidered gap this fix
 * closes for the falsy-scalar case.
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
  if (frontmatter.orgScale !== undefined) {
    lines.push(`orgScale: ${yamlString(frontmatter.orgScale)}`);
  }
  if (frontmatter.domain !== undefined) {
    lines.push(`domain: ${yamlString(frontmatter.domain)}`);
  }
  // Declared-but-empty is omitted here specifically -- see the FIX ROUND 2
  // note above for why that is a deliberate, documented choice rather than
  // the silent falsy-check gap this fix closes for the two scalars above.
  if (frontmatter.outcomes !== undefined && frontmatter.outcomes.length > 0) {
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
// can carry things that mean nothing outside this site: import statements,
// JSX component tags, and (issue #102, epic #96) the `:::figures` container
// directive. All three are stripped or degraded below; neither specimen file
// in src/content uses a component beyond a code fence, so
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

/**
 * Components that carry no prose children but whose CONTENT still belongs in a
 * portable document, mapped to the markdown that stands in for them.
 *
 * `PORTABLE_COMPONENTS` above cannot serve this case and the difference is not
 * a detail: it unwraps a paired tag and keeps what is between the halves, so a
 * self-closing tag has nothing for it to keep. `<ArchitectureDiagram />` is an
 * inline SVG, which is nothing at all once the tag is stripped, and the hole it
 * left was not theoretical. agent-native-site.mdx's own prose referred to "that
 * drawing" in a paragraph that, in the `.md` variant, followed no drawing.
 *
 * THE FALLBACK IS NOT WRITTEN HERE, and that is the point of the indirection.
 * It is the same `<desc>` string the SVG already carries for screen readers,
 * imported from src/lib/architecture.ts, so one edit moves both. A second
 * description typed into this file would be a copy nobody reads until it is
 * wrong -- and ArchitectureDiagram.astro's header already records two claims of
 * exactly that kind, taken from a stale copy of the architecture, that were
 * false when they shipped.
 */
const COMPONENT_FALLBACKS = new Map<string, string>([
  ['ArchitectureDiagram', `**${ARCHITECTURE_TITLE}.** ${ARCHITECTURE_DESCRIPTION}`],
]);

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

/**
 * A `:::figures{source="..."}` container directive (issue #102, epic #96),
 * matched whole -- the opening fence with its optional attributes, the list
 * body, and the closing `:::` -- so it can be replaced with plain markdown a
 * downstream reader has a chance of understanding. Group 1 is the raw
 * `{...}` attribute text (or `undefined` when the directive has none); group
 * 2 is everything between the fences, unchanged.
 *
 * Anchored at the start of a line (`^`/`m`) so an ordinary sentence that
 * happens to contain the word "figures" is never mistaken for one, same
 * reasoning as IMPORT_STATEMENT above. The closing `:::` must also start its
 * own line (`\n:::`, then `[ \t]*$`).
 *
 * This regex does not re-validate what src/lib/figures.mjs already validates
 * at render time -- item count 2-4, the ` — ` separator on every line. By
 * the time an entry's body reaches this exporter the site has already built,
 * which means figures.mjs already accepted the block; re-checking the same
 * rule here a second time is exactly the five-re-implementation drift risk
 * this module's own header comment warns about, applied to one directive
 * instead of one collection.
 *
 * FIX ROUND 1 (post-review): the paragraph above used to end "an unterminated
 * block simply does not match here and is left untouched rather than guessed
 * at" -- true as far as it went, but "left untouched" was a silent leak, not
 * a safe refusal, because nothing checked for it afterward. Two ways this
 * regex fails to match a block that still builds successfully, both measured
 * directly against the installed satteri 0.10.5 + figures.mjs (2026-09-13):
 *
 * 1. satteri's own attribute-block parser stops at the FIRST unescaped `}`
 *    wherever it falls, quoted or not -- so `source="Datadog (jobs})"`
 *    builds and renders (figures.mjs receives `attributes.source` already
 *    truncated to `"Datadog (jobs"`, a valid string as far as ITS validation
 *    is concerned). The attrs group here (`[^}\n]*`) is equally brace-naive
 *    and stops at that same `}`, leaving `)"}...` where the rest of this
 *    regex expects only trailing whitespace before the body's newline -- so
 *    the whole match fails. Making this group quote-aware would not fix
 *    this: satteri's own parser is not quote-aware for `}` either, so a
 *    smarter regex here would extract the FULL source string while the live
 *    HTML page still shows the truncated one -- a worse outcome than an
 *    error, because the two exports of the same content would disagree.
 * 2. satteri auto-closes an unterminated container directive at end of
 *    input (verified: a `:::figures` block with no closing `:::` at all
 *    still builds and renders normally), but this regex requires a literal
 *    `\n:::` to match.
 *
 * "The build already validated it" therefore does not make this regex safe
 * on its own -- it is a second, independently-written parser of the same
 * syntax, and the two can disagree about where a block ends even though
 * neither one throws. assertNoLeftoverContainerDirective below is the actual
 * fix: a backstop that throws when a container-directive opening fence
 * survives into the stripped output, the same call FIX ROUND 1 above made for
 * component tags -- refusing to guess is the fix; the guard is what makes
 * refusing safe. (It was named assertNoLeftoverFiguresDirective when this
 * note was written; FIX ROUND 3 below widened it past the `figures` name.)
 *
 * FIX ROUND 2 (post-review, post Task 3): the closing fence used to require
 * `\n:::` -- column zero, no leading whitespace at all. Task 3 hit this
 * directly: `npx prettier --parser mdx` (measured 2026-09-13) on the exact
 * tight shape this file's own fixtures and Task 1's unit tests use rewrites
 * it to insert a blank line after the opening fence AND indent the closing
 * `:::` by two spaces. Prettier has no directive awareness -- it reads the
 * fence as an ordinary paragraph and the list as an ordinary list, and once
 * it sees the closing `:::` sitting right after the list, it treats that
 * line as a lazy continuation of the list's last item and indents it to the
 * list content's own column. Rendering is unaffected (satteri + figures.mjs
 * produce byte-identical HTML for the tight and Prettier-mangled shapes,
 * verified), and CommonMark itself permits a fence indented up to three
 * spaces -- so a formatter-indented closing fence is legal markdown that this
 * regex was wrongly rejecting, not an edge case to merely tolerate. Checked
 * the opening fence under the same Prettier run before deciding: it is left
 * at column zero, untouched -- there is no preceding list for it to read as a
 * continuation of, so the same reasoning does not apply there, and it still
 * requires exact `^:::figures` with no leading whitespace.
 *
 * FIX ROUND 3 (final whole-branch review): that last sentence is no longer
 * true, and the reason it changed is the same one FIX ROUND 2 records, one
 * level up. Two shapes satteri + figures.mjs build and render correctly were
 * refused here and reached the guard below, which then named causes that were
 * not the cause (measured 2026-09-13):
 *
 * 1. An opening fence indented up to three spaces. CommonMark permits it for
 *    the closing fence, which FIX ROUND 2 already accepted, and permits it for
 *    the opening one by exactly the same rule; satteri agrees (an indented
 *    block renders its grid). `[ ]{0,3}` makes the two fences agree with each
 *    other and with the parser. The indentation is inside the match, so a
 *    degraded block's lead line starts at column zero either way.
 * 2. A CRLF body. Nothing about a line ending is an authoring error -- an
 *    editor or a `git` checkout setting decides it -- and satteri renders one
 *    identically. In a `m`-flagged regex `$` sits before the `\n` and not
 *    before the `\r`, so every line end here takes an explicit `\r?`.
 *
 * A directive LABEL (`:::figures[Label]{source="D1"}`) is deliberately still
 * refused, and that is now a refusal rather than a miss: the label arrives at
 * figures.mjs as an extra paragraph child, which it throws on (it has nowhere
 * in the contract to render a label), so the build fails at render with a
 * message about the label rather than reaching this exporter at all. The
 * guard's message names `[label]` as a requirement anyway, for whichever of
 * the two runs first.
 */
const FIGURES_DIRECTIVE =
  /^[ ]{0,3}:::figures(\{[^}\n]*\})?[ \t]*\r?\n([\s\S]*?)\r?\n[ ]{0,3}:::[ \t]*\r?$/gm;

/**
 * A container directive that survived stripping outside of code -- meaning
 * FIGURES_DIRECTIVE above failed to match it, or it was never a `:::figures`
 * block in the first place.
 *
 * FIX ROUND 3 (final whole-branch review): this used to be `/^:::figures\b/m`,
 * matching only the directive's own name and only at exactly three colons in
 * column zero. The reasoning given for the narrowness was that "a generic
 * `:::`-anywhere check would be guessing at a syntax this repo does not use
 * today (plan preflight finding 8)" -- and preflight finding 8 was wrong, in a
 * way `src/lib/literal-directives.mjs`'s header records in full. Two shapes
 * walked straight through the narrow version (measured 2026-09-13):
 * `::::figures{source="D1"}` renders a correct grid in HTML and shipped raw
 * `::::figures{...}` text into the `.md` variant and `llms.txt`, and so did a
 * fence at a non-zero column, `> :::figures` inside a blockquote. Both are the
 * page and the export disagreeing about one document, silently, which is what
 * this guard exists to make impossible.
 *
 * `[ \t>]*` covers indentation and blockquote markers; `:{3,}` covers a fence
 * of more than three colons, which satteri accepts as a container (measured:
 * `::::figures` parses with name `figures` and renders); the trailing
 * `[A-Za-z]` is what keeps it off a bare closing `:::` and off a row of
 * colons used as a rule. It no longer names `figures`, which means it also
 * catches an unclaimed `:::note` on the way out -- the export half of the same
 * ruling figures.mjs implements on the render half by throwing.
 */
const LEFTOVER_CONTAINER_DIRECTIVE = /^[ \t>]*:{3,}[A-Za-z]/m;

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

/**
 * Degrades a `:::figures` block to the plain list it wraps, plus a lead line
 * naming where the numbers came from -- `Figures, read from D1:` when the
 * directive carries a `source`, `Figures:` when it doesn't (Ruling 4: the
 * source is used exactly as authored, never upper-cased -- that is a
 * stylesheet's job on the rendered page, not this exporter's). The list
 * itself is copied through unchanged, unreadable-value spelling (`—`) and
 * all: this is the text export, not the HTML render, and figures.mjs is the
 * one place that turns an authored `—` into the word "unavailable".
 *
 * FIX ROUND 1 (post-review): the source-value group used to be `([^"]*)`,
 * which stops at the FIRST embedded `"` -- wrong specifically when that
 * quote is backslash-escaped (`\"`) rather than the real closing quote, so
 * `source="Team \"Alpha\""` extracted the truncated `Team \` instead of the
 * full value. `(?:[^"\\]|\\.)*` is the standard "quoted string contents"
 * shape: any run of characters that are neither a quote nor a backslash, OR
 * a backslash followed by any one character (an escaped pair), repeated --
 * so it only stops at a `"` that isn't preceded by an unconsumed `\`.
 * Measured against figures.mjs directly: satteri does not strip the
 * backslash from the value it exposes either -- the same input renders as
 * `READ FROM Team \"Alpha\"` on the live page -- so keeping the backslash
 * here, rather than trying to unescape it, is what keeps this export and
 * the rendered HTML agreeing on the same source string. (This group is not
 * the brace-matching problem FIGURES_DIRECTIVE's FIX ROUND 1 note
 * describes: an unescaped `}` inside the attrs text is caught upstream, by
 * FIGURES_DIRECTIVE failing to match at all, before this function ever
 * runs.)
 */
function stripFiguresDirective(prose: string): string {
  return prose.replace(FIGURES_DIRECTIVE, (_match, attrs: string | undefined, body: string) => {
    const source = attrs?.match(/source="((?:[^"\\]|\\.)*)"/)?.[1];
    const lead = source ? `Figures, read from ${source}:` : 'Figures:';
    return `${lead}\n\n${body}`;
  });
}

/**
 * Throws if a `:::figures` opening fence survives outside of fenced or
 * inline code -- the backstop FIGURES_DIRECTIVE's FIX ROUND 1 note promises,
 * mirroring assertNoLeftoverComponentTags below in shape and in the same
 * "refuse rather than guess" reasoning: this module cannot fully replicate
 * satteri's own (measurably not fully quote-aware) directive-attribute
 * grammar, and building a smarter regex here that DOES fully parse it would
 * risk producing a different, non-truncated result than the live HTML page
 * shows for the same content -- agreement with what actually got built and
 * rendered matters more than recovering the "intended" source string. Reuses
 * splitCodeRegions, the same shared code/prose split assertNoLeftoverComponentTags
 * uses, so a `:::figures` block mentioned inside a code sample is exempt here too.
 *
 * FIX ROUND 2 (post-review, post Task 3): the error message used to name "a
 * missing closing :::" as a cause. FIGURES_DIRECTIVE's own FIX ROUND 2 note
 * now tolerates a closing fence indented up to three spaces (what Prettier
 * produces), so an indented-but-present closing fence is no longer a way to
 * reach this guard at all -- naming it as a cause here would send the next
 * reader looking for something that is not their bug, the exact complaint
 * this guard existed to fix in the first place, aimed at itself. Genuinely
 * missing (or over-indented past three spaces) is still a real cause, so it
 * stays, worded to say so.
 *
 * FIX ROUND 3 (final whole-branch review): the message is rewritten again, and
 * this time it stops guessing at causes altogether. FIX ROUND 2 traded one
 * wrong cause for a shorter list of causes, and the shorter list was still
 * wrong for three inputs that render correctly -- an opening fence indented
 * two spaces, a CRLF body, and `:::figures[Label]{...}` -- each of which got
 * sent hunting for an unescaped `}` or a missing closing fence it did not
 * have. Two of those three are now accepted outright (see FIGURES_DIRECTIVE's
 * own FIX ROUND 3 note), and the message below states the REQUIREMENTS a
 * degradable block meets rather than diagnosing which one was missed. A
 * requirement list cannot misdiagnose: the author compares their block against
 * it and finds the difference themselves, which is what Ruling 6 asked for and
 * what naming a cause kept failing to deliver.
 */
function assertNoLeftoverContainerDirective(strippedBody: string): void {
  for (const segment of splitCodeRegions(strippedBody)) {
    if (!segment.code && LEFTOVER_CONTAINER_DIRECTIVE.test(segment.text)) {
      throw new Error(
        'markdown-export: a container directive survived MDX stripping outside of code. ' +
          'This exporter degrades only :::figures, and only a block that opens with exactly ' +
          'three colons at the start of a line (indented no more than three spaces, and not ' +
          'inside a blockquote), carries no [label], has no unescaped } inside its {attributes}, ' +
          'and closes with a ::: line indented no more than three spaces: ' +
          JSON.stringify(
            segment.text.length > 160 ? `${segment.text.slice(0, 160)}…` : segment.text,
          ),
      );
    }
  }
}

function stripComponentTags(prose: string): string {
  // Fallbacks BEFORE any stripping, because both regexes below delete the tag
  // outright and a substitution after that has nothing left to match. This
  // runs on prose segments only -- splitCodeRegions has already set aside
  // fences and inline code -- so `` `<ArchitectureDiagram />` `` written in a
  // sentence survives verbatim, the same exemption `<Aside />` relies on and
  // the case a build-log post about this repository actually produces.
  const withFallbacks = [...COMPONENT_FALLBACKS].reduce(
    (text, [tag, markdown]) => text.replace(new RegExp(`<${tag}\\b[^>{]*?/>`, 'g'), markdown),
    prose,
  );

  // Self-closing components first: with paired-tag stripping run first
  // instead, its lazy `[\s\S]*?` would treat an earlier, unrelated
  // `<Foo ... />` as the open half of a pair and swallow everything up to
  // some later, unrelated `</Foo>`.
  const withoutSelfClosing = withFallbacks.replace(SELF_CLOSING_COMPONENT, '');
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
 * import statements, component tags, and (issue #102) the `:::figures`
 * directive, everywhere except inside fenced or inline code. An unrecognized
 * component tag is replaced with nothing -- tag and children both -- rather
 * than left as raw JSX source text, which would read as broken markdown to
 * anything downstream. A recognized (`PORTABLE_COMPONENTS`) tag is unwrapped
 * instead: the wrapper is site-specific, but its children are prose the
 * author actually wrote. A `:::figures` block is degraded rather than
 * dropped -- see stripFiguresDirective -- because unlike a component tag it
 * has no site-specific meaning to discard: it is already plain data (a list
 * of values and labels), just wrapped in syntax this exporter's readers
 * cannot parse.
 *
 * Throws rather than returning if the result still looks like it contains an
 * unstripped tag (assertNoLeftoverComponentTags -- see FIX ROUND 1 above) or
 * a container-directive opening fence that never got degraded
 * (assertNoLeftoverContainerDirective -- see FIGURES_DIRECTIVE's own FIX ROUND
 * 1 note). A directive that DOES degrade produces a plain markdown list and
 * lead line, neither of which can ever look like `<Foo>` or a `:::` fence, so
 * the two guards cannot fire on each other's output -- they are independent
 * checks for independent ways this function's regexes can fail to match.
 */
export function stripNonPortableMdx(body: string): string {
  const cleaned = splitCodeRegions(body)
    .map((segment) =>
      segment.code
        ? segment.text
        : stripComponentTags(stripImportStatements(stripFiguresDirective(segment.text))),
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  assertNoLeftoverComponentTags(cleaned);
  assertNoLeftoverContainerDirective(cleaned);
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
