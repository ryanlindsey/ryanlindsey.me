import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { getResume } from '../../lib/resume-collection';
import {
  CHAT_CARD,
  HOME_CARD,
  OPS_CARD,
  cardPath,
  contentCard,
  resumeCard,
  type RenderedCard,
} from '../../lib/og/cards';

/**
 * Every card the site names, with the path it is rendered to (#363). Read by
 * src/lib/og/integration.ts after the build, which then deletes this file, so
 * it is never served. It exists so the content layer is the only frontmatter
 * reader: the build hook runs in Node, outside it.
 *
 * Drafts included: a draft's route is public by URL on purpose, and its card
 * can then be checked on a preview before `draft: false`.
 */
export const GET: APIRoute = async () => {
  const resume = await getResume();
  const cards = [
    HOME_CARD,
    CHAT_CARD,
    OPS_CARD,
    resumeCard(resume.basics),
    ...(await getCollection('posts')).map((entry) => contentCard('post', entry)),
    ...(await getCollection('caseStudies')).map((entry) => contentCard('case-study', entry)),
  ];
  const rendered: RenderedCard[] = await Promise.all(
    cards.map(async (card) => ({ ...card, path: await cardPath(card) })),
  );
  return new Response(JSON.stringify(rendered), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
