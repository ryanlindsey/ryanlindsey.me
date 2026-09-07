// Schema.org JSON-LD builders (day 3 Task 10, 02 §3). Pure functions only --
// no `astro:content` import, not even type-only -- so this file is
// unit-testable the same way src/lib/resume.ts and src/lib/llms-index.ts
// are: a plain `vitest run` process can import it directly with nothing
// Astro-flavoured loaded. The impure half (reading the résumé collection,
// knowing which page is a post vs. a case study) stays in the .astro files
// that call these builders -- src/layouts/Base.astro (Person, sitewide) and
// the two article routes (BlogPosting/TechArticle, BreadcrumbList).
//
// Scope is deliberately narrow. The day-3 research appendix (B3) surveys a
// much larger schema.org vocabulary for a personal site -- WebSite,
// ProfilePage, CollectionPage, one `@graph` of `@id`-linked nodes -- and
// finds most of it earns nothing from Google today and nothing measurable
// from AI answer engines either: B3.3 cites a 2026 Ahrefs study of 1,885
// pages finding schema.org additions produced "no major uplift in citations
// on any platform", and a related experiment found AI systems that fetch
// pages live "extracted only visible HTML content" and ignored JSON-LD
// entirely. This file ships exactly the four types task-10-brief.md asks
// for -- Person, BlogPosting, BreadcrumbList, TechArticle -- because 02 §3
// makes JSON-LD a launch gate and this is cheap and correct, not because it
// is expected to move anything. Nothing in this file should be read as an
// SEO or AI-visibility argument.

/** Every node this file emits carries this, verbatim, per schema.org convention. */
export const SCHEMA_CONTEXT = 'https://schema.org';

// No `email` field, by construction (`basics.email` exists and is used
// elsewhere -- resume.json, resume.md -- but publishing it in a document
// meant to be crawled and reused verbatim is a different, and worse,
// exposure than putting it on the résumé pages a human reads directly).
export interface PersonNode {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': 'Person';
  name: string;
  url: string;
  jobTitle?: string;
  /**
   * The entity-disambiguation payload (research appendix B3.1): links to the
   * same person's other profiles (GitHub, LinkedIn, ...). Omitted, not an
   * empty array, when there is nothing to list -- this repo's "no empty
   * scaffolding" rule (src/pages/resume.astro's Education/Skills sections
   * apply the same rule to HTML).
   */
  sameAs?: string[];
}

export interface PersonInput {
  name: string;
  url: string;
  jobTitle?: string;
  /** Pass whatever `resume.basics.profiles` has today -- empty is valid data, not a build error. */
  sameAs?: string[];
}

/**
 * The one entity node every page on the site carries (task-10-brief.md:
 * "Person sitewide"). Built from primitives rather than a `Resume` value so
 * this module stays free of the `astro:content`-adjacent type import
 * src/lib/resume.ts needs -- the caller (src/layouts/Base.astro) is the one
 * `.astro` file that reads the résumé collection and already has to unpack
 * `resume.basics` for other reasons.
 */
export function buildPerson(input: PersonInput): PersonNode {
  const person: PersonNode = {
    '@context': SCHEMA_CONTEXT,
    '@type': 'Person',
    name: input.name,
    url: input.url,
  };
  if (input.jobTitle) person.jobTitle = input.jobTitle;
  if (input.sameAs && input.sameAs.length > 0) person.sameAs = input.sameAs;
  return person;
}

export interface ArticleAuthor {
  '@type': 'Person';
  name: string;
  url: string;
}

export interface ArticleInput {
  headline: string;
  description: string;
  /** This article's own canonical URL -- markdown-export.ts's `canonicalUrlFor`, not `Astro.url`. */
  url: string;
  datePublished: Date;
  dateModified?: Date;
  author: { name: string; url: string };
}

interface ArticleFields {
  headline: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified?: string;
  author: ArticleAuthor;
}

/** ISO 8601 date-time, same format `Date#toISOString` always produces -- schema.org accepts it directly. */
function articleFields(input: ArticleInput): ArticleFields {
  const fields: ArticleFields = {
    headline: input.headline,
    description: input.description,
    url: input.url,
    datePublished: input.datePublished.toISOString(),
    author: { '@type': 'Person', name: input.author.name, url: input.author.url },
  };
  if (input.dateModified) fields.dateModified = input.dateModified.toISOString();
  return fields;
}

export interface BlogPostingNode extends ArticleFields {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': 'BlogPosting';
}

/** `/writing/<slug>` (task-10-brief.md: "BlogPosting ... on posts"). */
export function buildBlogPosting(input: ArticleInput): BlogPostingNode {
  return { '@context': SCHEMA_CONTEXT, '@type': 'BlogPosting', ...articleFields(input) };
}

export interface TechArticleNode extends ArticleFields {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': 'TechArticle';
}

/**
 * `/work/<slug>` (task-10-brief.md: "TechArticle on case studies"). Same
 * fields as `BlogPosting` -- the research appendix (B3.1/B3.2) notes
 * `TechArticle` is semantically the better fit for an engineering case study
 * but that Google understands both only as generic `Article`, with no
 * separate rich result for either -- so the two builders share
 * `articleFields` rather than duplicating it.
 */
export function buildTechArticle(input: ArticleInput): TechArticleNode {
  return { '@context': SCHEMA_CONTEXT, '@type': 'TechArticle', ...articleFields(input) };
}

export interface BreadcrumbItemInput {
  name: string;
  url: string;
}

export interface BreadcrumbListItem {
  '@type': 'ListItem';
  position: number;
  name: string;
  item: string;
}

export interface BreadcrumbListNode {
  '@context': typeof SCHEMA_CONTEXT;
  '@type': 'BreadcrumbList';
  itemListElement: BreadcrumbListItem[];
}

/**
 * `/writing/<slug>` only (task-10-brief.md: "BreadcrumbList on posts" -- case
 * studies get `TechArticle` alone, not this too; that asymmetry is the
 * brief's own scope, not an oversight). `position` is 1-based per the
 * `ListItem` spec, derived from array order rather than taken as input, so a
 * caller cannot pass a trail with a gap or a duplicate position.
 */
export function buildBreadcrumbList(items: BreadcrumbItemInput[]): BreadcrumbListNode {
  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Serializes one JSON-LD node for embedding in an inline
 * `<script type="application/ld+json">` (src/layouts/Base.astro). Every
 * literal less-than character is replaced with its six-character JSON
 * unicode escape so a field value containing a literal closing
 * `</script>` tag (an article headline, say) cannot prematurely end the
 * `<script>` element -- still valid JSON either way, since a unicode
 * escape decodes back to the original character on parse. This is the
 * standard mitigation for embedding arbitrary JSON inside HTML.
 */
export function stringifyJsonLd(node: object): string {
  return JSON.stringify(node).replace(/</g, '\\u003c');
}
