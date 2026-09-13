import { fileURLToPath } from 'node:url';

/**
 * Sätteri mdast plugin: put an unclaimed text (`:name`) or leaf (`::name`)
 * directive back the way it was authored, so turning directives on for the
 * `:::figures` container (issue #102) changes nothing else about how this
 * site's prose renders.
 *
 * WHY THIS EXISTS, and the correction it records. `astro.config.mjs`'s
 * `features: { directive: true }` was turned on for exactly one purpose, and
 * the plan's preflight declared it had zero blast radius on the strength of
 * `grep -rn '^:::' src/content/` returning nothing. That grep was one
 * directive kind too narrow and the claim was FALSE. The switch enables three
 * kinds -- container (`:::name`), leaf (`::name`) and text (`:name`, inline,
 * anywhere in any paragraph) -- and an unclaimed directive of ANY kind renders
 * as the empty string. Measured against the installed satteri 0.10.5
 * (2026-09-13), same input, `directive` off versus on, with nothing claiming
 * the name:
 *
 *   "At 05:17 UTC the cron runs."   ->  <p>At 05 UTC the cron runs.</p>
 *   "A ratio of 3:2 applies."       ->  <p>A ratio of 3 applies.</p>
 *   "The key is foo:bar here."      ->  <p>The key is foo here.</p>
 *   "Namespace astro:content ..."   ->  <p>Namespace astro ...</p>
 *
 * That is ordinary prose losing text, and it was not hypothetical: it had
 * already rewritten a published post in this branch's own build output, where
 * `dist/client/writing/agent-native-site/index.html` said "resume PDF at 05
 * UTC" while the source and the `.md` export both said "05:17 UTC" -- the page
 * and the agent-facing export of one live post disagreeing about its content,
 * which is the exact failure class the figures directive was designed against.
 *
 * The policy this implements (controller Ruling 7), and the split between this
 * file and `src/lib/figures.mjs`:
 *
 * - A `:::` CONTAINER whose name no plugin claims THROWS, and that throw lives
 *   in figures.mjs, which is the only subscriber to `containerDirective`.
 *   Nobody writes `:::note` by accident; it is unambiguous directive intent,
 *   so rendering it as nothing is the silent-disappearance failure again.
 * - A TEXT or LEAF directive is RESTORED here instead. `:name` collides with
 *   ordinary punctuation constantly -- clock times, ratios, `key:value`
 *   pairs, namespaces -- and throwing on those would make the repo unwritable.
 *
 * The principle under both: every directive kind other than `:::figures` must
 * behave precisely as it did before the switch was flipped.
 * `tests/literal-directives.test.ts` pins that as a byte-identity invariant.
 *
 * Three non-obvious implementation constraints, each measured the same day:
 *
 * 1. The restore keeps the node's PARSED CHILDREN and rebuilds only the
 *    directive syntax around them, rather than flattening the whole span to
 *    one text node of the raw source. Flattening renders `:name[**bold**]` as
 *    a literal `**bold**` where directives-off renders `<strong>bold</strong>`;
 *    slicing the source either side of the children instead is byte-identical
 *    to directives-off in every shape measured.
 *
 * 2. A leaf directive is block level, so its replacement is wrapped back in a
 *    paragraph. Replacing it with bare text instead puts that text at the root
 *    and renders it with no `<p>` at all (measured), which is a different
 *    document, not a restored one.
 *
 * 3. Three shapes this deliberately does not restore, because no visitor can.
 *    A leaf directive on a line that CONTINUES a paragraph (`Some text\n::x`)
 *    or a list item ends that block during parsing, before any plugin runs, so
 *    directives-on yields two paragraphs where directives-off yields one. The
 *    authored text survives in both; only the block boundary differs. Closing
 *    that would mean re-parsing, not restoring.
 *
 *    The third is an image's alt text, and no restore is possible at all: an
 *    image's `![alt](url)` flattens to a plain string before any visitor
 *    runs, so there is no node left in the tree for a visitor to claim, let
 *    alone restore. An unclaimed colon inside alt text is corrupted exactly
 *    like unclaimed prose is. Measured 2026-09-13:
 *    `![the cron at 05:17 UTC](x.png)` renders `alt="the cron at 05 UTC"`
 *    with directives on, while the page's own `.md` export keeps `05:17` --
 *    the same page/export divergence this whole plugin exists to close, and
 *    this one instance of it cannot be, because the flattening happens
 *    upstream of every visitor, including this one. There are zero images in
 *    `src/content` or `governance` today, so this is recorded risk rather
 *    than an active corruption; `tests/literal-directives.test.ts` pins the
 *    current behaviour so the next reader finds it measured rather than
 *    discovering it in an alt attribute.
 *
 * 4. A directive nested inside another directive's label, e.g.
 *    `:ref[astro:content]`, where the label `astro:content` itself parses as
 *    text plus a nested `:content` text directive (satteri parses labels
 *    inline). Passing the outer node's children through -- constraint 1's
 *    ordinary path -- leaves that inner directive unclaimed, and by the time
 *    its own `textDirective` visitor would run, satteri has already queued
 *    the OUTER node's replacement; it drops the inner node's queued
 *    transform and warns to the console instead of calling it. Measured
 *    2026-09-13, controller Ruling 8:
 *
 *      src : See :ref[astro:content] here.
 *      off : <p>See :ref[astro:content] here.</p>
 *      on  : <p>See :ref[astro] here.</p>          <- "content" silently gone
 *
 *    `restore` below falls back to slicing the WHOLE node's source span as
 *    one literal text node -- what constraint 1 avoids for the ordinary case
 *    -- whenever any descendant is itself a directive. That fallback is
 *    byte-identical to directives-off here too: constraint 1's markup-fidelity
 *    argument for keeping children only has force when there is no unclaimed
 *    directive underneath to lose.
 */
export function literalDirectives() {
  return {
    name: 'literal-directives',
    // Sätteri skips source-position tracking unless a plugin opts in, and
    // restoring the authored text is nothing but a read of `node.position`.
    options: { position: true },
    textDirective(node, ctx) {
      ctx.replaceNode(node, restore(node, ctx));
    },
    leafDirective(node, ctx) {
      // Constraint 2 above: back into a paragraph, where a block-level
      // directive's text lived before the switch.
      ctx.replaceNode(node, { type: 'paragraph', children: restore(node, ctx) });
    },
  };
}

/**
 * The authored source of one directive, as mdast: the syntax either side of
 * its children restored verbatim from `ctx.source`, the children themselves
 * kept as parsed (constraint 1 above).
 */
function restore(node, ctx) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start == null || end == null) {
    // Unreachable while `options.position` above is honoured, and a throw
    // rather than a quiet `return` on purpose: returning leaves the node
    // unclaimed, which is how the authored text disappears in the first place.
    // A build error naming the file is the one outcome that is never worse
    // than the bug this plugin exists to fix.
    throw new Error(
      `literal-directives${locate(ctx)}: a ${node.type} named "${node.name}" arrived with no ` +
        'source position, so the text it was authored as cannot be restored',
    );
  }

  const children = node.children ?? [];
  const firstChild = children[0]?.position?.start?.offset;
  const lastChild = children[children.length - 1]?.position?.end?.offset;
  // No children (`:17`, `::name`) or no positions on them, OR (constraint 4
  // above) a directive nested somewhere beneath this one: in every case the
  // whole span goes back as its own literal text rather than trying to
  // splice the parsed children back in.
  if (firstChild == null || lastChild == null || hasNestedDirective(node)) {
    return [{ type: 'text', value: ctx.source.slice(start, end) }];
  }

  return [
    { type: 'text', value: ctx.source.slice(start, firstChild) },
    ...children,
    { type: 'text', value: ctx.source.slice(lastChild, end) },
  ];
}

const DIRECTIVE_TYPES = new Set(['textDirective', 'leafDirective', 'containerDirective']);

/** True when a directive of any kind sits anywhere beneath `node` (constraint 4 above). */
function hasNestedDirective(node) {
  return (node.children ?? []).some(
    (child) => DIRECTIVE_TYPES.has(child.type) || hasNestedDirective(child),
  );
}

/** ` (path)`, or nothing: `ctx.fileURL` is `undefined` in the unit tests. */
function locate(ctx) {
  return ctx.fileURL ? ` (${fileURLToPath(ctx.fileURL)})` : '';
}
