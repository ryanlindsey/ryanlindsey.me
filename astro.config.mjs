// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import expressiveCode from 'astro-expressive-code';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';
import { headingAnchors } from './src/lib/heading-anchors.mjs';
import { figures } from './src/lib/figures.mjs';
import { isUnindexed } from './src/lib/unindexed-routes.mjs';

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
    // Launch (was "day 7"): the sitemap and robots.txt's `Sitemap:` line ship
    // together, which is what public/robots.txt's own closing comment said
    // they would -- a Sitemap line pointing at a 404 is worse than none.
    //
    // `filter` is not a nicety. Every draft has a real route by design, so
    // without it the sitemap would advertise exactly the unpublished documents
    // the draft convention exists to keep out of navigation, and would publish
    // the scoped token in a `/fit/r/<id>` URL. See src/lib/unindexed-routes.mjs
    // for both reasons in full.
    sitemap({ filter: (page) => !isUnindexed(page) }),
  ],
  markdown: {
    // Astro 7's default processor. `markdown.remarkPlugins` / `rehypePlugins`
    // belong to the legacy unified processor and hard-error without
    // @astrojs/markdown-remark installed -- see the plan's verified findings.
    //
    // `features.directive` defaults to false (satteri 0.10.5,
    // node_modules/satteri/dist/compile.d.ts) -- this is the line that makes
    // any `:::name` block parse at all, for `.mdx` content too: @astrojs/mdx
    // inherits this `markdown` config rather than running its own, unverified
    // until issue #102's Task 3 built this repo's `.mdx` content and grepped
    // the output for the rendered grid. Turning it on is a global switch, not
    // a per-directive one: every `:::name` block in every content file is now
    // parsed as a directive, and one with no plugin claiming it renders as
    // the empty string with no warning and no trace in the output (measured
    // 2026-09-13, the plan's preflight finding 4 -- the exact failure mode
    // `figures()` below exists to avoid). Measured the same day that this is
    // forward-looking risk only: `grep -rn '^:::' src/content/` returned
    // nothing, so no existing page was parsed differently the moment this
    // line landed.
    processor: satteri({
      features: { directive: true },
      mdastPlugins: [figures()],
      hastPlugins: [headingAnchors],
    }),
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
