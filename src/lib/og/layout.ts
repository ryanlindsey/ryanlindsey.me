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
 * rendered PNGs. The longest POST title today is 43 characters
 * (writing/agent-native-site, "An agent-native personal site on
 * Cloudflare"), which lands on the article variant's first step and renders
 * at 84px. The longest CASE STUDY title is 74 characters
 * (work/silent-failure), which exceeds every case-study step, floors at
 * TITLE_FLOOR (64px), and fills all three of lineClamp: 3's lines with no
 * room to spare -- one more real word would have clipped it. The
 * second-longest case study (58 characters, work/delivery-forecasting)
 * lands on the second step at 72px, also on three lines, with margin to
 * spare. No threshold moved: the starting values above already held for
 * every title this content has, though silent-failure's render is now known
 * to sit at the exact edge rather than comfortably inside it, which is what
 * TITLE_MAX_CHARS below exists to police against a future, longer title.
 *
 * AN EARLIER VERSION OF THIS COMMENT WAS WRONG, and it is worth keeping the
 * correction rather than the mistake: it named "writing/agent-native-site"
 * as a 90-character title floored at 64px. That entry's real title is 43
 * characters and renders at 84px; the 90-character, floored figure belonged
 * to no title in this repository. It went uncaught because the comment was
 * written from a recollection rather than from reading the rendered PNGs
 * against the frontmatter, which is what every figure above this paragraph
 * was redone against.
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

/**
 * The longest a post's or case study's title may be before its floored
 * render (TITLE_FLOOR, 64px) risks Satori's `lineClamp: 3` truncating it
 * with an ellipsis rather than failing loudly. `tests/og-cards.test.ts`
 * enforces this against every real title under `src/content/posts` and
 * `src/content/caseStudies`, drafts included, so a title that would clip
 * fails the build instead of shipping quietly.
 *
 * Character count only approximates rendered width, so this was bracketed
 * empirically on 2026-09-22 by rendering realistic sentences (real words,
 * not a repeated character) at the floor size and reading the PNGs:
 *
 * - A typical sentence-case title (mixed short and long words, mostly
 *   lowercase) filled three lines cleanly up to 96 characters and clipped
 *   with an ellipsis at 104.
 * - An all-lowercase, short-word title used only two of the three lines at
 *   78 characters, well under capacity.
 * - A worst-case title, every word capitalized and built from wide letters
 *   (M, W, O), filled three lines cleanly at 82 characters and clipped at
 *   84. This repository's own Title Case titles ("Choosing a Workflow over
 *   a Queue") capitalize nearly as many words, so this is a realistic worst
 *   case rather than a contrived one.
 *
 * 78 sits a few characters under the worst case's own safe edge (82), and
 * above the longest real title in the corpus today (74, work/silent-failure,
 * which the comment above `TITLE_STEPS` records as already at its own
 * three-line edge with no room to spare).
 */
export const TITLE_MAX_CHARS = 78;

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
