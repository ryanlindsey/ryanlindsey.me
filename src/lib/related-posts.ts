/**
 * The article's RELATED row (design 1g, the article issue): "two, drawn from
 * the same pillar where possible, most recent first, never the current article
 * and never a draft."
 *
 * Pure, and Astro-free on purpose -- no `astro:content` import, not even a
 * type-only one, for the reason src/lib/resume.ts states for itself: a module
 * that only takes plain objects can be exercised by a plain `vitest run`
 * process, and the selection rule above is four clauses that deserve to be
 * tested rather than eyeballed on whichever posts happen to exist this month.
 * The route (src/pages/writing/[...slug].astro) is what reads the collection
 * and flattens it into `PostSummary`s, which is also where the collection
 * knowledge already lives: it holds every post as `siblings` for SeriesNav.
 *
 * Posts only. `pillar` belongs to 02 §2's post taxonomy and case studies have
 * none, so /work renders no related row -- ArticleLayout simply gets no
 * `related` prop from that route. That keeps the template collection-agnostic,
 * which is the constraint ArticleLayout.astro's own header records as the
 * thing that blocked /work once already.
 *
 * `PostSummary` and `posts` are named that way to stay off the banned-pattern
 * list in tests/: the ordinary English word for "one of the things being
 * chosen between" is this repo's term of art for exactly what the private tier
 * exists to keep off the public surface, so it is banned in every shipped
 * source file. MEASURED (2026-09-13): the first version of this module used
 * that word as its parameter name and turned tests/tier-invisibility.test.ts
 * red in CI while the whole suite passed locally -- that scan reads
 * `git ls-files`, so a new file it has every reason to flag is invisible to it
 * until the commit that tracks it. Run that suite after `git add`, not before.
 */

/** What the RELATED cards render. */
export interface RelatedArticle {
  /** Root-relative route, e.g. `/writing/armature`. */
  href: string;
  title: string;
  /** The resolved pillar label, already looked up by the caller. */
  kicker: string;
  publishedAt: Date;
}

/** A `RelatedArticle` plus the two fields the selection rule needs and the cards do not. */
export interface PostSummary extends RelatedArticle {
  pillar: string;
  draft: boolean;
}

export function selectRelated(
  posts: PostSummary[],
  current: { href: string; pillar: string },
  limit = 2,
): RelatedArticle[] {
  const eligible = [...posts]
    .filter((entry) => !entry.draft && entry.href !== current.href)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

  // "Where possible" is a preference, not a filter: a reader on a pillar with
  // one published post still gets two cards, with the second drawn from the
  // most recent work elsewhere. Partitioning and concatenating keeps the
  // most-recent-first order inside each group rather than re-sorting across
  // them, which is what would let a newer post from another pillar jump ahead
  // of a same-pillar neighbour.
  const samePillar = eligible.filter((entry) => entry.pillar === current.pillar);
  const elsewhere = eligible.filter((entry) => entry.pillar !== current.pillar);

  return [...samePillar, ...elsewhere]
    .slice(0, limit)
    .map(({ href, title, kicker, publishedAt }) => ({ href, title, kicker, publishedAt }));
}
