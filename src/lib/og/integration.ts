import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import type { RenderedCard } from './cards';
// A static import, not a dynamic one inside the astro:build:done hook below.
// Measured 2026-09-22: a dynamic import written inside that hook fails with
// "Vite module runner has been closed," because astro.config.mjs's whole
// import graph, this file included, loads through Vite's SSR module runner,
// and that runner is disposed before any build hook runs. Importing render.ts
// statically here instead means it loads whenever the config does, including
// under astro dev and astro check, which costs nothing measurable: satori is
// plain JavaScript and native resvg loads a small compiled addon, neither of
// which does real work until renderCard is actually called.
import { loadCardAssets, renderCard } from './render';

/**
 * Renders every share card after the build (#363).
 *
 * A build hook rather than a prerendered `.png.ts` endpoint, and the reason is
 * where each runs. @astrojs/cloudflare prerenders in workerd by default, where
 * native resvg cannot load; this hook runs in Node, wherever `astro build`
 * does: Workers Builds, CI and `npm test`. #363's first child measured resvg
 * loading on the Workers Builds image before anything depended on it.
 *
 * It reads the list from dist/client/og/cards.json, written by
 * src/pages/og/cards.json.ts through the content layer, and deletes that file
 * once every card is written, so the list is never served.
 */
export function ogCards(): AstroIntegration {
  let root: URL;
  let client: URL;
  return {
    name: 'rl-og-cards',
    hooks: {
      'astro:config:done': ({ config }) => {
        root = config.root;
        client = config.build.client;
      },
      'astro:build:done': async ({ logger }) => {
        const manifest = new URL('og/cards.json', client);
        if (!existsSync(manifest)) {
          // Named rather than a raw ENOENT: astro.config.mjs loads this
          // module (and, through the import below, satori and native resvg
          // with it) on every `astro build`, `astro dev` and `astro check`,
          // but only a real build writes the manifest this hook reads. A
          // bare fs error here would send whoever hits it hunting a path
          // instead of the endpoint that owns writing it.
          throw new Error(
            `${manifest}: not found. src/pages/og/cards.json.ts should have written this during the build.`,
          );
        }
        const cards: RenderedCard[] = JSON.parse(readFileSync(manifest, 'utf8'));
        const assets = loadCardAssets(root);
        for (const card of cards) {
          const out = new URL(card.path.slice(1), client);
          mkdirSync(dirname(fileURLToPath(out)), { recursive: true });
          writeFileSync(out, await renderCard(card, assets));
        }
        rmSync(manifest);
        logger.info(`rendered ${cards.length} share cards`);
      },
    },
  };
}
