// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import expressiveCode from 'astro-expressive-code';
import { satteri } from '@astrojs/markdown-satteri';
import { headingAnchors } from './src/lib/heading-anchors.mjs';

export default defineConfig({
  site: 'https://ryanlindsey.me',
  // Static-first: pages prerender by default; individual routes opt into
  // on-demand rendering with `export const prerender = false`.
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
  }),
  // This project does not use Astro Sessions. Leaving this on would make the
  // adapter provision an unmanaged `SESSION` KV namespace at deploy time.
  session: false,
  integrations: [
    // Must precede mdx(). Reversing the order fails loudly rather than silently:
    // astro-expressive-code throws in its `astro:config:setup` hook (verified 2026-09-04).
    expressiveCode({
      // Muted on purpose. Pink is the site's only loud colour, and code that
      // shouts competes with it. Light is listed first so it is the fallback
      // when no data-theme is present.
      themes: ['vitesse-light', 'vitesse-black'],
      // `theme.type` yields "light"/"dark"; `theme.name` would yield
      // "vitesse-black" and never match this site's data-theme values.
      themeCssSelector: (theme) => `[data-theme="${theme.type}"]`,
      // The site's own chrome, not Expressive Code's defaults: square corners,
      // token-coloured borders, our mono.
      styleOverrides: {
        borderRadius: '0',
        borderColor: 'var(--rl-rule)',
        codeFontFamily: 'var(--font-mono)',
        codeFontSize: '0.875rem',
        uiFontFamily: 'var(--font-mono)',
        frames: {
          editorActiveTabIndicatorTopColor: 'var(--rl-accent)',
          editorActiveTabBorderColor: 'var(--rl-rule)',
          editorTabBarBorderBottomColor: 'var(--rl-rule)',
          tooltipSuccessBackground: 'var(--rl-accent-ground)',
          tooltipSuccessForeground: 'var(--rl-accent-on)',
          inlineButtonBorder: 'var(--rl-rule)',
        },
      },
    }),
    mdx(),
  ],
  markdown: {
    // Astro 7's default processor. `markdown.remarkPlugins` / `rehypePlugins`
    // belong to the legacy unified processor and hard-error without
    // @astrojs/markdown-remark installed -- see the plan's verified findings.
    processor: satteri({ hastPlugins: [headingAnchors] }),
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
