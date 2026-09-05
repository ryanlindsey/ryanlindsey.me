import type { CollectionEntry } from 'astro:content';

export interface SeriesNavInfo {
  name: string;
  position: number;
  total: number;
  previous?: CollectionEntry<'posts'>;
  next?: CollectionEntry<'posts'>;
}

/**
 * Compute series navigation for a post, or null when nothing should render.
 *
 * Ordered by the author-declared `series.order`, not by date: a series is a
 * reading sequence, and the order it should be read in is not always the
 * order it was written in.
 *
 * Returns null when: the post has no `series` field; fewer than two published
 * entries remain in the series; or the post itself is not among the ordered
 * (published) entries. That last case matters when viewing a draft that
 * belongs to an otherwise-published series -- the draft is filtered out of
 * `ordered` along with every other draft, so it must not fall through to a
 * "Part 0 of N" block with neither a previous nor a next link.
 */
export function seriesNavFor(
  current: CollectionEntry<'posts'>,
  siblings: CollectionEntry<'posts'>[],
): SeriesNavInfo | null {
  const series = current.data.series;
  if (!series) return null;

  const ordered = siblings
    .filter((post) => post.data.series?.name === series.name && !post.data.draft)
    .sort((a, b) => (a.data.series?.order ?? 0) - (b.data.series?.order ?? 0));

  if (ordered.length < 2) return null;

  const index = ordered.findIndex((post) => post.id === current.id);
  if (index === -1) return null;

  return {
    name: series.name,
    position: index + 1,
    total: ordered.length,
    previous: index > 0 ? ordered[index - 1] : undefined,
    next: index < ordered.length - 1 ? ordered[index + 1] : undefined,
  };
}
