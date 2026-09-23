import { readFileSync } from 'node:fs';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readTokens, requireTokens } from '../tokens-read.mjs';
import { CARD_HEIGHT, CARD_WIDTH, type OgCard } from './cards';
import { cardTree, type Palette } from './layout';

/** Every `--rl-*` name src/lib/og/layout.ts's cardTree() reads off the palette. */
const CARD_PALETTE_KEYS = [
  '--rl-bg',
  '--rl-ink',
  '--rl-ink-muted',
  '--rl-rule',
  '--rl-accent-ground',
  '--rl-accent-on',
] as const;

/**
 * Node only: called by src/lib/og/integration.ts after the build and by
 * tests/og-cards.test.ts, never by anything bundled into the Worker.
 *
 * The static @fontsource packages rather than the variable ones the site
 * loads, because Satori reads neither woff2 nor variable fonts. Read by path
 * from the project root: those packages' `exports` map offers only CSS.
 */
export interface CardAssets {
  fonts: { name: string; data: Buffer; weight: 400 | 600; style: 'normal' }[];
  palette: Palette;
}

export function loadCardAssets(root: URL): CardAssets {
  const font = (pkg: string, file: string) =>
    readFileSync(new URL(`node_modules/@fontsource/${pkg}/files/${file}`, root));
  return {
    fonts: [
      {
        name: 'Space Grotesk',
        data: font('space-grotesk', 'space-grotesk-latin-600-normal.woff'),
        weight: 600,
        style: 'normal',
      },
      {
        name: 'Inter',
        data: font('inter', 'inter-latin-400-normal.woff'),
        weight: 400,
        style: 'normal',
      },
      {
        name: 'IBM Plex Mono',
        data: font('ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff'),
        weight: 400,
        style: 'normal',
      },
      {
        name: 'IBM Plex Mono',
        data: font('ibm-plex-mono', 'ibm-plex-mono-latin-600-normal.woff'),
        weight: 600,
        style: 'normal',
      },
    ],
    // Dark, always: a card is not a page and inherits no visitor's theme, and
    // the dark palette holds up in both Slack themes. requireTokens throws
    // naming whichever key is missing, rather than letting cardTree read an
    // absent one as `undefined` and render a card silently missing a color.
    palette: requireTokens(
      readTokens(readFileSync(new URL('src/styles/tokens.css', root), 'utf8')).dark,
      CARD_PALETTE_KEYS,
    ),
  };
}

export async function renderCard(card: OgCard, assets: CardAssets): Promise<Buffer> {
  const svg = await satori(
    cardTree(card, assets.palette) as unknown as Parameters<typeof satori>[0],
    {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      fonts: assets.fonts,
    },
  );
  return new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } }).render().asPng();
}
