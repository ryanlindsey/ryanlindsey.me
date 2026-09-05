import GithubSlugger from 'github-slugger';

/**
 * Sätteri hast plugin: give every h2-h4 a stable id and an empty anchor.
 *
 * Two non-obvious constraints, both measured rather than assumed:
 *
 * 1. User hast plugins run BEFORE Astro's own heading-ids plugin, so
 *    `node.properties.id` is still undefined here. This computes the slug with
 *    the same slugger Astro uses. Astro's plugin then finds an existing id,
 *    keeps it, and reports it in `render().headings` -- so TOC slugs and DOM
 *    ids stay identical by construction.
 *
 * 2. The anchor is deliberately EMPTY. Astro reads heading text after this
 *    plugin runs, so any text inside the anchor would leak into the TOC label
 *    ("First Heading#"). The visible glyph is drawn by CSS ::after instead.
 *    Passing `{ rawHtml }` to appendChild throws; a hast element works.
 */
export function headingAnchors() {
  return {
    name: 'heading-anchors',
    element: {
      filter: ['h2', 'h3', 'h4'],
      visit(node, ctx) {
        // One slugger per document keeps duplicate headings unique (-1, -2, ...).
        const slugger = (ctx.data.__rlSlugger ??= new GithubSlugger());
        const existing = node.properties?.id;
        const slug = typeof existing === 'string' ? existing : slugger.slug(ctx.textContent(node));
        if (typeof existing !== 'string') ctx.setProperty(node, 'id', slug);

        ctx.appendChild(node, {
          type: 'element',
          tagName: 'a',
          properties: {
            className: ['heading-anchor'],
            href: `#${slug}`,
            'aria-hidden': 'true',
            tabindex: '-1',
          },
          children: [],
        });
      },
    },
  };
}
