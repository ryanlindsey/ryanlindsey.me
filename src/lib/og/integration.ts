import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import type { RenderedCard } from './cards';
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
