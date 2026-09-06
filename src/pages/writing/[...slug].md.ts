import { getCollection, type CollectionEntry } from 'astro:content';
import type { APIRoute, GetStaticPaths } from 'astro';
import { toMarkdown } from '../../lib/markdown-export';

// Day 3 Task 7 (02 §3): the `.md` variant of every `/writing/<slug>` page.
// getStaticPaths mirrors src/pages/writing/[...slug].astro's EXACTLY --
// same collection, same `params: { slug: post.id }`, no draft filter. That
// file's own comment states the convention this route must not violate:
// "Drafts get a route but never an index entry, so work in progress is
// shareable by URL without entering the site's navigation." A `.md` variant
// that hid a draft its HTML route serves would break the format parity this
// plan exists to guarantee -- see task-7-brief.md.
export const prerender = true;

interface Props {
  post: CollectionEntry<'posts'>;
}

export const getStaticPaths = (async () => {
  const posts = await getCollection('posts');
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { post },
  }));
}) satisfies GetStaticPaths;

// The Content-Type set here does not survive Astro's static build -- it
// discards a prerendered endpoint's Response headers and writes only the
// body (see public/_headers and task-7-brief.md). public/_headers is what
// actually makes the deployed response serve `text/markdown`. This header is
// still set for fidelity under `astro dev` and any consumer reading the
// Response object directly, same as src/pages/resume.md.ts.
export const GET: APIRoute<Props> = ({ props }) => {
  return new Response(toMarkdown(props.post), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
