import type { Block, Inline } from './markdown';

// The answer tree as DOM (#403). Moved out of src/pages/chat.astro's script so
// jsdom can check the structure, which is the point of the spec's "semantic
// and valid HTML" requirement: a test that reads the elements rather than a
// person squinting at a transcript.
//
// `appendChild`, NEVER `append`, and text through `createTextNode`: the global
// `Element` from worker-configuration.d.ts merges with the DOM's and gives
// `append` an HTMLRewriter signature, so `node.append(otherNode)` fails `astro
// check`. The comment in src/pages/chat.astro has the full error.
//
// No `innerHTML` anywhere. Model text only ever becomes a text node, so a
// `<script>` in an answer is eleven characters and not an element.
//
// THE CLASS STRINGS ARE WHOLE LITERALS so Tailwind's scanner, which reads
// source text, finds every one of them.

export interface ChatSource {
  n: number;
  title: string;
  url: string;
  exact: boolean;
}

const LIST_CLASS = { bullets: 'list-disc space-y-2 pl-5', numbered: 'list-decimal space-y-2 pl-5' };

function appendInline(parent: HTMLElement, nodes: Inline[], sources: readonly ChatSource[]): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      parent.appendChild(document.createTextNode(node.text));
    } else if (node.kind === 'code') {
      const code = document.createElement('code');
      code.className = 'font-mono text-small';
      code.textContent = node.text;
      parent.appendChild(code);
    } else if (node.kind === 'strong' || node.kind === 'em') {
      const wrapper = document.createElement(node.kind);
      appendInline(wrapper, node.children, sources);
      parent.appendChild(wrapper);
    } else {
      // A number with no entry in the `sources` frame stays text: no href is
      // ever built from anything the model wrote.
      const source = sources.find((entry) => entry.n === node.n);
      if (source === undefined) {
        parent.appendChild(document.createTextNode(`[${node.n}]`));
        continue;
      }
      const link = document.createElement('a');
      link.className = 'text-accent';
      link.href = source.url;
      link.textContent = `[${node.n}]`;
      parent.appendChild(link);
    }
  }
}

function listItems(items: Inline[][], sources: readonly ChatSource[]): HTMLElement[] {
  return items.map((item) => {
    const li = document.createElement('li');
    appendInline(li, item, sources);
    return li;
  });
}

/**
 * Appends one block and returns what it added.
 *
 * A LIST FOLLOWING A LIST OF THE SAME KIND JOINS IT. The stream is split at
 * blank lines, and a model that puts a blank line between list items would
 * otherwise produce one list per item, which for a numbered list restarts the
 * count at every item.
 */
export function appendBlock(
  container: HTMLElement,
  block: Block,
  sources: readonly ChatSource[],
): HTMLElement[] {
  if (block.kind === 'paragraph') {
    const p = document.createElement('p');
    appendInline(p, block.children, sources);
    container.appendChild(p);
    return [p];
  }

  const tag = block.kind === 'bullets' ? 'UL' : 'OL';
  const items = listItems(block.items, sources);
  const previous = container.lastElementChild;
  if (previous instanceof HTMLElement && previous.tagName === tag) {
    for (const li of items) previous.appendChild(li);
    return items;
  }

  const list = document.createElement(tag === 'UL' ? 'ul' : 'ol');
  list.className = LIST_CLASS[block.kind];
  if (block.kind === 'numbered' && block.start !== 1)
    list.setAttribute('start', String(block.start));
  for (const li of items) list.appendChild(li);
  container.appendChild(list);
  return [list];
}
