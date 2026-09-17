/**
 * The non-collection routes `/search` can return a row for (issue #147, epic
 * #143).
 *
 * A PAGE ABSENT FROM THIS LIST IS UNFINDABLE BY DESIGN RATHER THAN BY
 * OMISSION, and that is the whole reason the list is hand-written instead of
 * derived from the route tree. `src/pages/` holds routes a search result must
 * never be: `/fit` and `/fit/r/<id>` carry a scoped token, `/resume.print` is
 * a render source with no audience, `/writing/pillar/<pillar>` is a thin
 * duplicate of `/writing`, and `404` is not a destination. Every one of those
 * is excluded from the sitemap for its own stated reason
 * (src/lib/unindexed-routes.mjs), so none of them should reach the index in
 * the first place -- but the epic's third gate is the render-time join, and a
 * gate that enumerates what may render is a gate. A gate that enumerates what
 * may not is a filter somebody can forget to extend.
 *
 * ORDERED THE WAY THE SITE ORDERS ITSELF -- src/lib/nav.ts's four primary
 * links, then the two SYSTEM_LINKS pages issue #99 demoted into the footer.
 * The order is not what a visitor sees, since results come back ranked by
 * score, but a list a reader can check against the navigation is a list whose
 * gaps are visible.
 *
 * BESIDE nav.ts RATHER THAN INSIDE IT, because these are different facts about
 * the same routes. `NAV_LINKS` answers where a reader is invited to go and its
 * comment records that Ops and AI Policy are deliberately not in it; this
 * answers what a query may surface, and both of those pages belong here. One
 * array serving both questions would have to carry a flag, and the flag would
 * be the place the two meanings quietly merged.
 *
 * THE TITLES ARE THE PAGES' OWN, copied from the `title` each route hands
 * Shell, for the reason src/lib/search/engine.ts refuses to return a crawled
 * one: a title taken from crawled text can drift from the document. These can
 * drift too -- nothing binds this string to `src/pages/ops.astro` -- but they
 * drift in a file a reader can diff against six routes rather than in an index
 * nobody can read.
 */
export interface SearchablePage {
  /** Site-relative, no trailing slash, the shape `pathOf` normalises a result URL to. */
  path: string;
  /** What this route passes Shell as its `title`. */
  title: string;
}

export const SEARCHABLE_PAGES: readonly SearchablePage[] = [
  { path: '/writing', title: 'Writing' },
  { path: '/work', title: 'Work' },
  { path: '/resume', title: 'Resume' },
  { path: '/chat', title: 'Ask my agent' },
  { path: '/ops', title: 'Ops' },
  { path: '/ai-policy', title: 'AI policy and risk register' },
];
