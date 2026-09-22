import { readingTimeFor } from '../reading-time';

/**
 * What a share card says and where it is written (#363).
 *
 * One module for both halves on purpose. Base.astro calls `cardPath` to name
 * the image in `og:image`, and src/pages/og/cards.json.ts calls it to tell the
 * build where to write that image, so the page and the file cannot disagree.
 *
 * `cardPath` hashes with Web Crypto rather than node:crypto because it runs in
 * three places: the workerd prerender, the Worker itself for the on-demand
 * /chat and /ops, and Node under vitest. All three have `crypto.subtle`.
 */

/**
 * Bump when the rendered layout changes, so every card moves to a new URL
 * and no scraper keeps the old one. `cardPath` hashes only the strings an
 * `OgCard` carries, so a change to how a card is drawn rather than what it
 * says -- src/lib/og/layout.ts, src/styles/tokens.css (the palette
 * src/lib/og/render.ts reads), or the fonts render.ts loads -- moves no hash
 * on its own. Bump this alongside any of those, or the old image keeps
 * serving under its old URL.
 */
export const OG_CARD_CONTRACT_VERSION = 1;

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export type OgVariant = 'home' | 'article' | 'case-study' | 'resume' | 'section';

export interface OgCard {
  /** The path under /og, without the hash: `home`, `writing/<slug>`, `work/<slug>`. */
  key: string;
  variant: OgVariant;
  kicker: string;
  title: string;
  standfirst?: string;
  footerLeft: string;
  footerRight: string;
}

/** A card with the path it is rendered to, as src/pages/og/cards.json.ts hands it to the build. */
export interface RenderedCard extends OgCard {
  path: string;
}

const SITE_FOOTER = '//ryanlindsey.me';

// The home card's strings were supplied with the design and ship verbatim.
// It is also every non-content page's card except /resume, /chat and /ops.
export const HOME_CARD: OgCard = {
  key: 'home',
  variant: 'home',
  kicker: '//RYANLINDSEY.ME',
  title: 'Ryan Lindsey',
  standfirst: 'Engineering leadership and agentic engineering',
  footerLeft: SITE_FOOTER,
  footerRight: 'WRITING · CASE STUDIES · RESUME',
};

export const CHAT_CARD: OgCard = {
  key: 'chat',
  variant: 'section',
  kicker: 'CHAT',
  title: 'Ask my agent',
  standfirst:
    'Questions about the published writing, résumé and case studies, answered with a citation for every claim.',
  footerLeft: SITE_FOOTER,
  footerRight: 'CITED ANSWERS',
};

export const OPS_CARD: OgCard = {
  key: 'ops',
  variant: 'section',
  kicker: 'OPS',
  title: 'Ops',
  standfirst:
    'What this site runs, what it served in the last thirty days, which models it spends and how it degrades.',
  footerLeft: SITE_FOOTER,
  footerRight: 'LAST 30 DAYS',
};

export function resumeCard(basics: { name: string; label: string }): OgCard {
  return {
    key: 'resume',
    variant: 'resume',
    kicker: 'RESUME',
    title: basics.name,
    standfirst: basics.label,
    footerLeft: `${SITE_FOOTER}/resume`,
    footerRight: 'PDF AVAILABLE',
  };
}

export function contentCard(
  kind: 'post' | 'case-study',
  entry: { id: string; body?: string; data: { title: string; standfirst?: string } },
): OgCard {
  const post = kind === 'post';
  return {
    key: `${post ? 'writing' : 'work'}/${entry.id}`,
    variant: post ? 'article' : 'case-study',
    kicker: post ? 'ARTICLE' : 'CASE STUDY',
    title: entry.data.title,
    // Absent rather than empty: a card with no standfirst renders without one,
    // and never falls back to `description`, which runs to 500 characters.
    ...(entry.data.standfirst ? { standfirst: entry.data.standfirst } : {}),
    footerLeft: SITE_FOOTER,
    // The number the page itself displays (src/layouts/ArticleLayout.astro).
    footerRight: `${readingTimeFor(entry.body).minutes} MIN READ`,
  };
}

export async function cardPath(card: OgCard): Promise<string> {
  // An array in a fixed order rather than JSON.stringify(card), so the hash
  // cannot move because an object literal was written in a different order.
  const input = JSON.stringify([
    OG_CARD_CONTRACT_VERSION,
    card.key,
    card.variant,
    card.kicker,
    card.title,
    card.standfirst ?? null,
    card.footerLeft,
    card.footerRight,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `/og/${card.key}.${hex.slice(0, 8)}.png`;
}

/** The card's own words, because the image carries them and the alt is the only way they reach a screen reader in a share preview. */
export function cardAlt(card: OgCard): string {
  if (!card.standfirst) return card.title;
  return /[.?!]$/.test(card.title)
    ? `${card.title} ${card.standfirst}`
    : `${card.title}. ${card.standfirst}`;
}
