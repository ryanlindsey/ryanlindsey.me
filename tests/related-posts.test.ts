import { describe, expect, test } from 'vitest';
import { selectRelated, type RelatedCandidate } from '../src/lib/related-posts';

/*
 * The article's RELATED row (design 1g, issue #104). Unit-tested here as well
 * as at the HTTP level in tests/pages.test.ts, because the rule the design
 * states -- "two, drawn from the same pillar where possible, most recent
 * first, never the current article and never a draft" -- has four clauses and
 * today's content exercises only two of them: nothing published shares
 * agent-native-site's pillar, so the rendered page cannot show whether the
 * pillar preference works or merely appears to.
 */
const candidate = (over: Partial<RelatedCandidate> & { href: string }): RelatedCandidate => ({
  title: over.href,
  kicker: 'Building in the open',
  pillar: 'building-in-the-open',
  publishedAt: new Date('2026-01-01'),
  draft: false,
  ...over,
});

describe('selectRelated', () => {
  test('never returns the article the reader is already on', () => {
    const related = selectRelated(
      [candidate({ href: '/writing/a' }), candidate({ href: '/writing/b' })],
      { href: '/writing/a', pillar: 'building-in-the-open' },
    );
    expect(related.map((r) => r.href)).toEqual(['/writing/b']);
  });

  test('never returns a draft', () => {
    // Every draft has a real route by design, so "not in the index" is not
    // enough on its own -- a related row that linked one would put an
    // unpublished piece into the navigation of a published page.
    const related = selectRelated(
      [candidate({ href: '/writing/draft', draft: true }), candidate({ href: '/writing/live' })],
      { href: '/writing/current', pillar: 'building-in-the-open' },
    );
    expect(related.map((r) => r.href)).toEqual(['/writing/live']);
  });

  test('prefers the same pillar even when a newer post sits outside it', () => {
    const related = selectRelated(
      [
        candidate({
          href: '/writing/newer-other-pillar',
          pillar: 'agentic-engineering',
          publishedAt: new Date('2026-06-01'),
        }),
        candidate({
          href: '/writing/older-same-pillar',
          pillar: 'building-in-the-open',
          publishedAt: new Date('2026-02-01'),
        }),
      ],
      { href: '/writing/current', pillar: 'building-in-the-open' },
    );
    expect(related.map((r) => r.href)).toEqual([
      '/writing/older-same-pillar',
      '/writing/newer-other-pillar',
    ]);
  });

  test('orders most recent first within the same pillar', () => {
    const related = selectRelated(
      [
        candidate({ href: '/writing/older', publishedAt: new Date('2026-02-01') }),
        candidate({ href: '/writing/newer', publishedAt: new Date('2026-05-01') }),
      ],
      { href: '/writing/current', pillar: 'building-in-the-open' },
    );
    expect(related.map((r) => r.href)).toEqual(['/writing/newer', '/writing/older']);
  });

  test('returns two, and fills the second from another pillar when it has to', () => {
    // The design asks for two cards. One same-pillar neighbour plus the most
    // recent other post beats showing a single lonely card.
    const related = selectRelated(
      [
        candidate({ href: '/writing/same', publishedAt: new Date('2026-03-01') }),
        candidate({
          href: '/writing/other',
          pillar: 'agentic-engineering',
          publishedAt: new Date('2026-04-01'),
        }),
        candidate({
          href: '/writing/other-older',
          pillar: 'agentic-engineering',
          publishedAt: new Date('2026-01-15'),
        }),
      ],
      { href: '/writing/current', pillar: 'building-in-the-open' },
    );
    expect(related.map((r) => r.href)).toEqual(['/writing/same', '/writing/other']);
  });

  test('returns nothing rather than padding when there is nothing to show', () => {
    expect(selectRelated([], { href: '/writing/current', pillar: 'building-in-the-open' })).toEqual(
      [],
    );
  });
});
