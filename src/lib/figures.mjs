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
 */

const SEPARATOR = ' — ';
const UNREADABLE_VALUE = '—';

export function figures() {
  return {
    name: 'figures',
    // Sätteri skips source-position tracking by default (~15% faster parse)
    // unless some plugin in the pipeline opts in. Error messages below need
    // to name the offending line, so this plugin turns tracking on.
    options: { position: true },
    containerDirective(node, ctx) {
      if (node.name !== 'figures') return;

      const list = node.children.find((child) => child.type === 'list');
      if (!list) {
        throw new Error(
          `figures directive${errorLocation(ctx, node)}: expected a list of items, found none`,
        );
      }

      const items = list.children.map((listItem) =>
        splitItem(ctx.textContent(listItem), ctx, listItem),
      );

      // A fifth item means the author wanted a table, not a figure row; one
      // item is a sentence, not a row. Both are build errors rather than a
      // silent best-effort render (see constraint 2 above).
      if (items.length < 2 || items.length > 4) {
        throw new Error(
          `figures directive${errorLocation(ctx, node)}: expected 2 to 4 items, got ${items.length}`,
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
        children: [{ type: 'text', value: readable ? value : 'unavailable' }],
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
