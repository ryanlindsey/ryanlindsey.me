import { getCollection, type CollectionEntry } from 'astro:content';
import type { APIRoute, GetStaticPaths } from 'astro';
import { toMarkdown } from '../../lib/markdown-export';

// Day 3 Task 7 (02 §3): the `.md` variant of every `/work/<slug>` page.
// getStaticPaths mirrors src/pages/work/[...slug].astro's EXACTLY -- same
// collection, same `params: { slug: study.id }`, no draft filter. See that
// file's comment and src/pages/writing/[...slug].md.ts's for why: every
// entry gets a detail route (HTML and `.md`), only published ones reach the
// index.
export const prerender = true;

interface Props {
  study: CollectionEntry<'caseStudies'>;
}

export const getStaticPaths = (async () => {
  const caseStudies = await getCollection('caseStudies');
  return caseStudies.map((study) => ({
    params: { slug: study.id },
    props: { study },
  }));
}) satisfies GetStaticPaths;

// See src/pages/writing/[...slug].md.ts: this Content-Type does not survive
// Astro's static build. public/_headers is what actually ships it.
export const GET: APIRoute<Props> = ({ props }) => {
  return new Response(toMarkdown(props.study), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
