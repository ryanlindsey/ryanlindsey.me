import { describe, expect, test } from 'vitest';
import { buildToc } from '../src/lib/toc';

const h = (depth: number, slug: string) => ({ depth, slug, text: slug });

describe('buildToc', () => {
  test('nests deeper headings under the preceding shallower one', () => {
    const toc = buildToc([h(2, 'a'), h(3, 'a1'), h(3, 'a2'), h(2, 'b')]);
    expect(toc).toHaveLength(2);
    expect(toc[0].children.map((c) => c.slug)).toEqual(['a1', 'a2']);
    expect(toc[1].children).toEqual([]);
  });

  test('ignores h1 so the article title is never a TOC entry', () => {
    expect(buildToc([h(1, 'title'), h(2, 'a')]).map((n) => n.slug)).toEqual(['a']);
  });

  test('drops headings deeper than maxDepth', () => {
    const toc = buildToc([h(2, 'a'), h(3, 'a1'), h(4, 'a1a')], 3);
    expect(toc[0].children).toHaveLength(1);
    expect(toc[0].children[0].children).toEqual([]);
  });

  test('promotes an orphaned deep heading rather than dropping it', () => {
    // A post that opens with an h3 is malformed, but losing its content
    // silently is worse than showing it at the top level.
    expect(buildToc([h(3, 'orphan'), h(2, 'a')]).map((n) => n.slug)).toEqual(['orphan', 'a']);
  });

  test('returns an empty array for an article with no headings', () => {
    expect(buildToc([])).toEqual([]);
  });
});
