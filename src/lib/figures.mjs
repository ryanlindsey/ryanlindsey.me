import { fileURLToPath } from 'node:url';

/**
 * Sätteri mdast plugin: turn `:::figures{source="..."}` into the hairline
 * grid of key numbers used on case-study design `1j` (issue #102), so the
 * figure row can be authored in markdown that also survives the `.md` and
 * `llms.txt` exports, instead of hand-styled JSX that only those exports
 * would have to strip back out.
 *
 * Four non-obvious constraints, each measured against the installed
 * `satteri` 0.10.5 rather than assumed (dated 2026-09-13, see the plan's
 * preflight for the full probe):
 *
 * 1. There is no remark/unified pipeline here for a `remark-directive`
 *    plugin to attach to. `astro.config.mjs` sets `markdown.processor:
 *    satteri(...)` -- Astro 7's own processor -- and `markdown.remarkPlugins`
 *    belongs to the legacy `@astrojs/markdown-remark`, which this repo does
 *    not install. Sätteri implements directives natively, so this plugin
 *    subscribes to its `containerDirective` mdast visitor directly.
 *
 * 2. An unclaimed directive renders as the empty string: with
 *    `features.directive` on and no plugin replacing the node, the authored
 *    content disappears with no warning and no trace. Verified. So did
 *    `ctx.report({ severity: 'error' })` as the failure path -- it returns
 *    normally, `html` is still `""`, and nothing throws or fails the
 *    compile. A thrown `Error`, by contrast, verifiably propagates out of
 *    `markdownToHtml` with its message intact. That is the only mechanism
 *    that actually stops a bad build, so every malformed-input path below
 *    throws rather than reports.
 *
 * 3. Split each item on the FIRST ` — ` (space, em dash, space), not on
 *    every em dash in the line. The contract uses the em dash both as the
 *    value/label separator and as the authored spelling of an unreadable
 *    value, so `— — Alerts fired` is legal: an unavailable figure labeled
 *    "Alerts fired". Splitting on every occurrence would break that line,
 *    and would also break a label that legitimately contains one of its own
 *    (`Runs — all green`).
 *
 * 4. The em dash here is a data separator, not prose -- the `house-style`
 *    skill's near-zero-em-dash rule does not reach it. Nobody should "fix"
 *    it out of an authored figure line.
 *
 * This is also the ONLY subscriber to `containerDirective` in the pipeline,
 * which is why it throws on a container whose name it does not claim rather
 * than returning (controller Ruling 7, 2026-09-13): `features.directive` is a
 * single switch for three directive kinds, and an unclaimed one of any kind
 * renders as the empty string. Text and leaf directives take the opposite
 * treatment, restored to their authored source by
 * `src/lib/literal-directives.mjs` -- read its header for why the two halves
 * of one ruling point in opposite directions. In short: `:::note` is
 * unambiguous directive intent nobody types by accident, while `:name` is
 * indistinguishable from a clock time or a `key:value` pair.
 *
 * Three smaller decisions, recorded because each looked like an oversight to
 * a reader and is not:
 *
 * - `splitItem`'s per-item separator check runs BEFORE the 2 to 4 count
 *   check, so a five-item block whose first item also lacks a separator
 *   reports the separator, not the count. Deliberate: the separator error
 *   quotes the offending line, which is the more actionable of the two, and
 *   an author who fixes it sees the count error on the next build.
 * - An explicit `source=""` is treated as no source at all, so the source
 *   line is omitted rather than rendered as a bare `READ FROM `.
 *   `stripFiguresDirective` in `src/lib/markdown-export.ts` makes the
 *   identical choice (`Figures:`, not `Figures, read from :`), and the two
 *   halves of the feature agreeing matters more here than either default.
 * - Inline markup inside a value or a label is flattened to text, because
 *   `ctx.textContent` is what reads the item. `- **0** — Alerts fired`
 *   renders the value as `0`, not as `<strong>0</strong>`. A figure is a
 *   number and a name for it; emphasis inside one has nowhere to land in the
 *   design (4a), and the stylesheet already sets the weight of both lines.
 */

const SEPARATOR = ' — ';

/**
 * THE FOUR CONSTANTS BELOW ARE EXPORTED BECAUSE A SECOND SURFACE NOW RENDERS
 * FIGURES: the /work index row's 2x2 block (design 1i, issue #106), which
 * takes its pairs from case-study frontmatter rather than from an authored
 * `:::figures` fence. Same idea, two authoring routes, and the parts that must
 * not drift are the vocabulary (what an unreadable value looks like and what
 * it is called) and the range (what counts as a figure row at all).
 *
 * They stay here rather than moving to a neutral module because this file is
 * where the contract is DEFINED and reasoned about -- constraints 3 and 4
 * above are about exactly these values. `src/lib/case-study-figures.ts` reads
 * them from here and adds only what frontmatter needs on top.
 */

/** The authored spelling of a value that could not be read. See constraint 3. */
export const UNREADABLE_VALUE = '—';

/**
 * What an unreadable value renders as. A word, not a dash and never a zero --
 * the rule src/components/OpsMetric.astro states at length ("absent is a
 * state, not a zero") and the one /ops has lived by since it shipped.
 */
export const UNREADABLE_LABEL = 'unavailable';

/** One item is a sentence, not a row. */
export const FIGURE_MIN = 2;

/** A fifth item means the author wanted a table. */
export const FIGURE_MAX = 4;

export function figures() {
  return {
    name: 'figures',
    // Sätteri skips source-position tracking by default (~15% faster parse)
    // unless some plugin in the pipeline opts in. Error messages below need
    // to name the offending line, so this plugin turns tracking on.
    options: { position: true },
    containerDirective(node, ctx) {
      if (node.name !== 'figures') {
        throw new Error(
          `unknown container directive ":::${node.name}"${errorLocation(ctx, node)}: this site ` +
            'renders only :::figures, and an unclaimed container renders as nothing at all',
        );
      }

      // Exactly one child, and it is the list. Taking the first `list` child
      // and ignoring the rest quietly dropped anything else the author wrote
      // inside the fence -- `:::figures` / `Lead in.` / the list rendered the
      // grid with "Lead in." gone from the page while the `.md` export kept
      // it verbatim (measured 2026-09-13), so one input produced a quiet
      // degradation AND a page/export disagreement. A directive label
      // (`:::figures[Label]`) arrives as an extra paragraph child too, and is
      // refused here for the same reason: the contract has nowhere to put it.
      const [list] = node.children;
      if (node.children.length !== 1 || list?.type !== 'list') {
        const found = node.children.map((child) => child.type).join(', ') || 'nothing';
        throw new Error(
          `figures directive${errorLocation(ctx, node)}: expected one list of items and nothing ` +
            `else, found: ${found}`,
        );
      }

      const items = list.children.map((listItem) =>
        splitItem(ctx.textContent(listItem), ctx, listItem),
      );

      // A fifth item means the author wanted a table, not a figure row; one
      // item is a sentence, not a row. Both are build errors rather than a
      // silent best-effort render (see constraint 2 above). The bounds are the
      // exported constants so the frontmatter schema enforces the same range
      // on the same reasoning rather than a copy of the numbers.
      if (items.length < FIGURE_MIN || items.length > FIGURE_MAX) {
        throw new Error(
          `figures directive${errorLocation(ctx, node)}: expected ${FIGURE_MIN} to ${FIGURE_MAX} ` +
            `items, got ${items.length}`,
        );
      }

      const wrapper = {
        type: 'blockquote',
        data: {
          hName: 'div',
          hProperties: {
            className: ['rl-figures', 'hairline-grid'],
            'data-figures': String(items.length),
          },
        },
        children: items.map(buildCell),
      };

      const source = node.attributes?.source;
      if (!source) {
        ctx.replaceNode(node, [wrapper]);
        return;
      }

      const sourceLine = {
        type: 'paragraph',
        data: { hName: 'p', hProperties: { className: 'rl-figure-source' } },
        // Exactly as authored (the issue's Ruling 4): the plugin decides
        // structure, the stylesheet decides appearance, so no upper-casing
        // happens here even though the rendered page shows it upper-case.
        children: [{ type: 'text', value: `READ FROM ${source}` }],
      };
      ctx.replaceNode(node, [wrapper, sourceLine]);
    },
  };
}

/** Split one item's text on the first value/label separator (constraint 3 above). */
function splitItem(text, ctx, listItem) {
  const index = text.indexOf(SEPARATOR);
  if (index === -1) {
    throw new Error(
      `figures directive${errorLocation(ctx, listItem)}: item has no " — " separator: "${text}"`,
    );
  }
  return { value: text.slice(0, index), label: text.slice(index + SEPARATOR.length) };
}

/**
 * One grid cell: a value over its label. `data-numeric` follows this
 * codebase's existing convention (`src/components/OpsMetric.astro`,
 * `global.css`'s `[data-numeric] { font-variant-numeric: tabular-nums }`) --
 * it marks a cell that carries an actual rendered figure. "unavailable" is a
 * word, not a number, so an unreadable value omits it, the same way
 * OpsMetric's own absent state renders without the attribute.
 */
function buildCell({ value, label }) {
  const readable = value !== UNREADABLE_VALUE;
  const valueProperties = { className: 'rl-figure-value' };
  if (readable) valueProperties['data-numeric'] = true;

  return {
    type: 'blockquote',
    data: { hName: 'div', hProperties: { className: 'rl-figure' } },
    children: [
      {
        type: 'paragraph',
        data: { hName: 'p', hProperties: valueProperties },
        children: [{ type: 'text', value: readable ? value : UNREADABLE_LABEL }],
      },
      {
        type: 'paragraph',
        data: { hName: 'p', hProperties: { className: 'rl-figure-label' } },
        children: [{ type: 'text', value: label }],
      },
    ],
  };
}

/** `${file}:${line}`, degrading gracefully: `ctx.fileURL` is `undefined` in the unit tests. */
function errorLocation(ctx, node) {
  const file = ctx.fileURL ? fileURLToPath(ctx.fileURL) : undefined;
  const line = node.position?.start?.line;
  if (file && line) return ` (${file}:${line})`;
  if (file) return ` (${file})`;
  if (line) return ` (line ${line})`;
  return '';
}
