export interface Heading {
  depth: number;
  slug: string;
  text: string;
}

export interface TocNode {
  slug: string;
  text: string;
  children: TocNode[];
}

/**
 * Turn Astro's flat `headings` array into a nested tree.
 *
 * h1 is skipped: it is the article title, which already sits above the TOC.
 * A heading deeper than the one before it with no valid parent is promoted to
 * the top level rather than dropped -- malformed input should degrade, not
 * disappear.
 */
export function buildToc(headings: Heading[], maxDepth = 3): TocNode[] {
  const root: TocNode[] = [];
  const stack: { depth: number; node: TocNode }[] = [];

  for (const heading of headings) {
    if (heading.depth < 2 || heading.depth > maxDepth) continue;

    const node: TocNode = { slug: heading.slug, text: heading.text, children: [] };

    while (stack.length > 0 && stack[stack.length - 1].depth >= heading.depth) {
      stack.pop();
    }

    if (stack.length === 0) root.push(node);
    else stack[stack.length - 1].node.children.push(node);

    stack.push({ depth: heading.depth, node });
  }

  return root;
}
