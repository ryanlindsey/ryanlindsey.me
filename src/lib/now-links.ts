// The Now strip's one piece of inline markup. An item in
// src/content/now/now.yaml may carry markdown links, `[text](href)`, and
// nothing else: the home page splits the item here and renders each link as an
// anchor, while /index.md prints the item as it stands, where the same syntax
// is already a link. One spelling, read correctly by both.
//
// Pure, and outside now-collection.ts, because that module imports
// `astro:content` and cannot be loaded by a plain vitest run.

export type NowSegment = { text: string; href?: string };

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Splits one Now item into text and link segments, in order. */
export function splitNowItem(item: string): NowSegment[] {
  const segments: NowSegment[] = [];
  let from = 0;
  for (const match of item.matchAll(LINK)) {
    if (match.index > from) segments.push({ text: item.slice(from, match.index) });
    segments.push({ text: match[1], href: match[2] });
    from = match.index + match[0].length;
  }
  if (from < item.length) segments.push({ text: item.slice(from) });
  return segments;
}
