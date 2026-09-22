import { CARD_HEIGHT, CARD_WIDTH, type OgCard, type OgVariant } from './cards';

/**
 * The card as Satori draws it (#363), from the design handoff's values. Satori
 * needs `display: flex` on any element with more than one child, and takes
 * letter-spacing in pixels, so the handoff's em values are multiplied out.
 */

export type Palette = Record<string, string>;

interface Node {
  type: string;
  props: { style: Record<string, unknown>; children?: string | Node | Node[] };
}

const h = (
  type: string,
  style: Record<string, unknown>,
  children?: Node['props']['children'],
): Node => ({
  type,
  props: { style, children },
});

const TITLE_TYPE: Record<OgVariant, { lineHeight: number; tracking: number }> = {
  home: { lineHeight: 0.92, tracking: -0.035 },
  resume: { lineHeight: 0.94, tracking: -0.03 },
  article: { lineHeight: 0.95, tracking: -0.03 },
  'case-study': { lineHeight: 0.95, tracking: -0.03 },
  section: { lineHeight: 0.95, tracking: -0.03 },
};

/** The handoff's floor: a title never goes smaller than this. */
export const TITLE_FLOOR = 64;

/**
 * [longest title in characters, size] per variant, the first that fits wins,
 * and anything longer takes TITLE_FLOOR with lineClamp as the backstop.
 * Starting values, from Space Grotesk 600 averaging roughly 0.52em a
 * character in a 1000px column.
 *
 * Measured 2026-09-22 by building this repo's own content and reading the
 * rendered PNGs: the longest article title today (90 characters,
 * writing/agent-native-site) and the longest case-study title (74
 * characters, work/silent-failure) both exceed every step and land on
 * TITLE_FLOOR at 64px. Both sit on two lines with room to spare before
 * lineClamp: 3's three-line backstop, and the footer rule stays clear in
 * both. No threshold moved: the starting values above already held for
 * every title this content has.
 */
const TITLE_STEPS: Record<OgVariant, readonly (readonly [number, number])[]> = {
  home: [
    [20, 120],
    [32, 96],
  ],
  resume: [
    [24, 96],
    [48, 84],
  ],
  article: [
    [48, 84],
    [64, 72],
  ],
  'case-study': [
    [48, 84],
    [64, 72],
  ],
  section: [
    [48, 84],
    [64, 72],
  ],
};

export function titleSize(card: OgCard): number {
  for (const [longest, size] of TITLE_STEPS[card.variant]) {
    if (card.title.length <= longest) return size;
  }
  return TITLE_FLOOR;
}

export function cardTree(card: OgCard, c: Palette): Node {
  const home = card.variant === 'home';
  const size = titleSize(card);
  const { lineHeight, tracking } = TITLE_TYPE[card.variant];
  const mono = { fontFamily: 'IBM Plex Mono', lineHeight: 1 };

  // Filled on the home card only (#363): elsewhere the pink block would read
  // as a category badge, and the band above already carries the accent.
  const kicker = h(
    'div',
    {
      ...mono,
      display: 'flex',
      alignSelf: 'flex-start',
      fontWeight: 600,
      fontSize: 20,
      letterSpacing: 20 * 0.14,
      textTransform: 'uppercase',
      ...(home
        ? { padding: '11px 14px', background: c['--rl-accent-ground'], color: c['--rl-accent-on'] }
        : { color: c['--rl-ink-muted'] }),
    },
    card.kicker,
  );

  const title = h(
    'div',
    {
      display: 'block',
      maxWidth: 1000,
      fontFamily: 'Space Grotesk',
      fontWeight: 600,
      fontSize: size,
      lineHeight,
      letterSpacing: size * tracking,
      color: c['--rl-ink'],
      lineClamp: 3,
    },
    card.title,
  );

  const standfirst = card.standfirst
    ? [
        h(
          'div',
          {
            display: 'block',
            marginTop: 22,
            maxWidth: home ? 880 : 860,
            fontFamily: 'Inter',
            fontWeight: 400,
            fontSize: home ? 32 : 30,
            lineHeight: 1.4,
            color: c['--rl-ink-muted'],
            lineClamp: 3,
          },
          card.standfirst,
        ),
      ]
    : [];

  const footer = h(
    'div',
    {
      ...mono,
      display: 'flex',
      justifyContent: 'space-between',
      borderTop: `1px solid ${c['--rl-rule']}`,
      paddingTop: 24,
      fontWeight: 400,
      fontSize: 22,
      letterSpacing: 22 * 0.04,
      color: c['--rl-ink-muted'],
    },
    [
      h('div', { display: 'flex' }, card.footerLeft),
      h('div', { display: 'flex' }, card.footerRight),
    ],
  );

  return h(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      position: 'relative',
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      padding: 64,
      overflow: 'hidden',
      background: c['--rl-bg'],
    },
    [
      h('div', {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 10,
        background: c['--rl-accent-ground'],
      }),
      kicker,
      h('div', { display: 'flex', flexDirection: 'column' }, [title, ...standfirst]),
      footer,
    ],
  );
}
