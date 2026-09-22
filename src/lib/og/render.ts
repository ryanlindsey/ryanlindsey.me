import { readFileSync } from 'node:fs';
import type satoriType from 'satori';
import type { Resvg as ResvgType } from '@resvg/resvg-js';
import { readTokens } from '../tokens-read.mjs';
import { CARD_HEIGHT, CARD_WIDTH, type OgCard } from './cards';
import { cardTree, type Palette } from './layout';

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
    // the dark palette holds up in both Slack themes.
    palette: readTokens(readFileSync(new URL('src/styles/tokens.css', root), 'utf8')).dark,
  };
}

/**
 * Loaded here, at call time inside `renderCard`, rather than as a top-level
 * import of this module: `render.ts` is reached from `astro.config.mjs`
 * through `src/lib/og/integration.ts`'s static import, so a top-level
 * `import satori from 'satori'` here would load satori and native resvg on
 * every `astro dev` and `astro check`, not only when a card is actually
 * rendered.
 *
 * A plain `await import(specifier)` is not enough on its own in every
 * caller, which is why this tries that first and falls back rather than
 * using it outright. Called from tests/og-cards.test.ts under Vitest, or
 * from any other plain Node process, the plain form is exactly right and the
 * fallback below never triggers. Called from src/lib/og/integration.ts's
 * `astro:build:done` hook, it is not: that path reaches this function only
 * after astro.config.mjs's own module graph -- which statically includes
 * this file -- was loaded through Vite's SSR loader (the mechanism that runs
 * a plain TS/ESM config file at all), and that loader rewrites every
 * `import()` literal it sees at parse time to route through its own module
 * runner. That runner is disposed once config loading finishes, long before
 * astro:build:done calls this function, so the plain form throws "Vite
 * module runner has been closed" there (measured 2026-09-22). The fallback
 * builds the specifier at runtime through the `Function` constructor, which
 * hides the `import()` call from that rewrite so it reaches Node's own
 * loader instead -- Node can resolve `satori` and `@resvg/resvg-js` because
 * they are published packages with their own `package.json`, but the same
 * trick cannot reach a second module of this repository's own: this
 * repository's relative imports carry no extension (`./cards`,
 * `../reading-time`), which Node's loader, unlike Vite's, refuses to
 * resolve.
 */
async function importHeavy<T>(specifier: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('module runner has been closed')) {
      throw error;
    }
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<T>;
    return dynamicImport(specifier);
  }
}

export async function renderCard(card: OgCard, assets: CardAssets): Promise<Buffer> {
  const { default: satori } = await importHeavy<{ default: typeof satoriType }>('satori');
  const { Resvg } = await importHeavy<{ Resvg: typeof ResvgType }>('@resvg/resvg-js');
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
