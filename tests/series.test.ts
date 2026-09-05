import { describe, expect, test } from 'vitest';
import type { CollectionEntry } from 'astro:content';
import { seriesNavFor } from '../src/lib/series';

const post = (
  id: string,
  overrides: { series?: { name: string; order: number }; draft?: boolean } = {},
): CollectionEntry<'posts'> =>
  ({
    id,
    data: { series: overrides.series, draft: overrides.draft ?? false },
  }) as unknown as CollectionEntry<'posts'>;

const series = (order: number) => ({ name: 'Building in the open', order });

describe('seriesNavFor', () => {
  test('returns null when the post has no series field', () => {
    const current = post('solo');
    expect(seriesNavFor(current, [current])).toBeNull();
  });

  test('returns null for a single-item series', () => {
    const current = post('a', { series: series(1) });
    expect(seriesNavFor(current, [current])).toBeNull();
  });

  test('returns null when the current post is a draft inside an otherwise published series', () => {
    // The bug this guards against: the draft is filtered out of `ordered`
    // along with every other draft, leaving index at -1. Checking only
    // ordered.length would still render a broken "Part 0 of N" block with no
    // links for the very post the guard was meant to hide.
    const current = post('draft-post', { series: series(2), draft: true });
    const a = post('a', { series: series(1) });
    const b = post('b', { series: series(3) });
    expect(seriesNavFor(current, [current, a, b])).toBeNull();
  });

  test('returns both neighbours for a middle item', () => {
    const a = post('a', { series: series(1) });
    const b = post('b', { series: series(2) });
    const c = post('c', { series: series(3) });
    const result = seriesNavFor(b, [a, b, c]);
    expect(result).toMatchObject({ position: 2, total: 3 });
    expect(result?.previous?.id).toBe('a');
    expect(result?.next?.id).toBe('c');
  });

  test('gives the first item only a next link', () => {
    const a = post('a', { series: series(1) });
    const b = post('b', { series: series(2) });
    const result = seriesNavFor(a, [a, b]);
    expect(result?.previous).toBeUndefined();
    expect(result?.next?.id).toBe('b');
  });

  test('gives the last item only a previous link', () => {
    const a = post('a', { series: series(1) });
    const b = post('b', { series: series(2) });
    const result = seriesNavFor(b, [a, b]);
    expect(result?.previous?.id).toBe('a');
    expect(result?.next).toBeUndefined();
  });

  test('orders neighbours by declared series.order, not by array position', () => {
    // Siblings arrive out of order here (c, a, b with orders 3, 1, 2) so that
    // a passing suite actually exercises the .sort() call rather than relying
    // on the input already being sorted, as every other test in this file
    // does incidentally.
    const c = post('c', { series: series(3) });
    const a = post('a', { series: series(1) });
    const b = post('b', { series: series(2) });
    const result = seriesNavFor(b, [c, a, b]);
    expect(result).toMatchObject({ position: 2, total: 3 });
    expect(result?.previous?.id).toBe('a');
    expect(result?.next?.id).toBe('c');
  });
});
