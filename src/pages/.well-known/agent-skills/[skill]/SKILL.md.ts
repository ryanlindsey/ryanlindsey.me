import type { APIRoute, GetStaticPaths } from 'astro';
import { PUBLISHED_SKILLS } from '../../../../lib/discovery/skills';

// Prerendered, same reasoning as every other endpoint in this directory: a
// pure function of PUBLISHED_SKILLS, known entirely at build time.
export const prerender = true;

interface Props {
  source: string;
}

// One route per PUBLISHED_SKILLS entry, matched to it by `params.skill`
// rather than to a filesystem walk -- so a third skill needs only an entry in
// that array (and its own markdown file) to get a route, the same discipline
// src/pages/work/[...slug].md.ts applies to case studies.
export const getStaticPaths = (() => {
  return PUBLISHED_SKILLS.map((skill) => ({
    params: { skill: skill.name },
    props: { source: skill.source },
  }));
}) satisfies GetStaticPaths;

// The Content-Type set here does not survive `astro build` -- public/_headers
// is what actually ships it. Kept for fidelity under `astro dev`, matching
// every other prerendered endpoint in this repository.
export const GET: APIRoute<Props> = ({ props }) =>
  new Response(props.source, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
