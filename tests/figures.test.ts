import { describe, expect, test } from 'vitest';
import { markdownToHtml } from 'satteri';
import { figures } from '../src/lib/figures.mjs';

const render = async (source: string) =>
  (await markdownToHtml(source, { features: { directive: true }, mdastPlugins: [figures()] })).html;

const THREE = `:::figures{source="D1"}
- 0 — Alerts fired
- 100% — Runs green
- 100s — Sessions lost
:::
`;

describe('the figures directive', () => {
  test('renders a hairline grid whose column count follows the item count', async () => {
    const html = await render(THREE);
    expect(html).toContain('data-figures="3"');
    expect(html).toContain('hairline-grid');
  });

  test('renders each item as a value over a label', async () => {
    const html = await render(THREE);
    expect(html).toMatch(/<p class="rl-figure-value" data-numeric>0<\/p>/);
    expect(html).toMatch(/<p class="rl-figure-label">Alerts fired<\/p>/);
  });

  test('names the system the numbers were read from, when one is given', async () => {
    expect(await render(THREE)).toContain('READ FROM D1');
  });

  test('omits the source line entirely when no source is declared', async () => {
    const html = await render(`:::figures\n- 1 — One\n- 2 — Two\n:::\n`);
    expect(html).not.toContain('READ FROM');
  });

  test('renders an unreadable value as the word, never as a zero', async () => {
    // The live site's rule, carried into authored content: a figure that
    // could not be read says so. A zero here is a claim about the system.
    const html = await render(`:::figures\n- — — Alerts fired\n- 3 — Runs green\n:::\n`);
    expect(html).toContain('unavailable');
    expect(html).not.toMatch(/<p class="rl-figure-value"[^>]*>0</);
    // Split on the FIRST separator, so the label survives an unreadable value.
    expect(html).toContain('Alerts fired');
    // `data-numeric` marks a cell carrying an actual figure, so the word
    // "unavailable" does not get it while the real number alongside does.
    // That is src/components/OpsMetric.astro's own convention (its absent
    // state renders without the attribute) and global.css's
    // `[data-numeric] { font-variant-numeric: tabular-nums }` is what makes it
    // mean something. It was a decision nothing pinned until this assertion.
    expect(html).toContain('<p class="rl-figure-value">unavailable</p>');
    expect(html).toContain('<p class="rl-figure-value" data-numeric>3</p>');
  });

  test('a label containing an em dash survives', async () => {
    const html = await render(`:::figures\n- 4 — Runs — all green\n- 5 — Two\n:::\n`);
    expect(html).toContain('Runs — all green');
  });

  test('one item is a sentence and five is a table, and both are build errors', async () => {
    await expect(render(`:::figures\n- 1 — One\n:::\n`)).rejects.toThrow(/2 to 4/);
    await expect(
      render(`:::figures\n- 1 — a\n- 2 — b\n- 3 — c\n- 4 — d\n- 5 — e\n:::\n`),
    ).rejects.toThrow(/2 to 4/);
  });

  test('an item with no separator is a build error, not a guess', async () => {
    // Sätteri renders an unclaimed directive as NOTHING -- verified against
    // the installed library. A plugin that quietly skipped a malformed item
    // would be indistinguishable from content that was never written, which
    // is the whole reason this throws.
    await expect(render(`:::figures\n- just a label\n- 2 — Two\n:::\n`)).rejects.toThrow();
  });

  // Fix round 3 (final whole-branch review, controller Ruling 7). Both of the
  // following rendered as the EMPTY STRING with the content silently gone, the
  // one failure mode this plugin was written to make impossible, and both were
  // measured that way against satteri 0.10.5 on 2026-09-13.

  test('a container directive this site does not claim is a build error, not a blank space', async () => {
    // `:::note` is unambiguous directive intent -- nobody types three colons
    // and a word by accident -- so the answer here is a build error naming it,
    // not an empty page where a note used to be. Text and leaf directives take
    // the opposite treatment (src/lib/literal-directives.mjs) because `:name`
    // IS something an author types by accident, in every clock time.
    await expect(render(`:::note\nHello.\n:::\n`)).rejects.toThrow(/unknown container directive/);
  });

  test('anything inside the fence besides the list is a build error, not dropped', async () => {
    // Measured: this rendered the grid with "Lead in." gone from the page
    // while markdown-export kept it verbatim in the `.md` variant, so one
    // input produced a quiet degradation AND a page/export disagreement.
    await expect(render(`:::figures\nLead in.\n\n- 1 — One\n- 2 — Two\n:::\n`)).rejects.toThrow(
      /nothing else/,
    );
    // A directive label arrives as an extra paragraph child by the same route.
    await expect(
      render(`:::figures[Label]{source="D1"}\n- 1 — One\n- 2 — Two\n:::\n`),
    ).rejects.toThrow(/nothing else/);
  });
});
