// @ts-check
import { defineConfig } from 'astro/config';
import { readFileSync, writeFileSync } from 'node:fs';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import expressiveCode from 'astro-expressive-code';
import sitemap from '@astrojs/sitemap';
import { satteri } from '@astrojs/markdown-satteri';
import { headingAnchors } from './src/lib/heading-anchors.mjs';
import { figures } from './src/lib/figures.mjs';
import { literalDirectives } from './src/lib/literal-directives.mjs';
import { isUnindexed } from './src/lib/unindexed-routes.mjs';
import { sitemapLastmods } from './src/lib/sitemap-lastmod.mjs';

// Read once at config-eval time -- src/lib/sitemap-lastmod.mjs's own header
// says why this reads the filesystem directly rather than through
// `getCollection`, and why it never falls back to `new Date()` for a path with
// no date of its own.
const lastmods = sitemapLastmods();

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
    {
      name: 'spike-resvg',
      hooks: {
        'astro:build:done': async ({ logger }) => {
          const started = Date.now();
          const font = readFileSync(
            'node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff',
          );
          const svg = await satori(
            {
              type: 'div',
              props: {
                style: { display: 'flex', width: 1200, height: 630, padding: 64, background: '#0a0a0b', color: '#fafaf9', fontSize: 84, fontFamily: 'Space Grotesk' },
                children: 'resvg on Workers Builds',
              },
            },
            { width: 1200, height: 630, fonts: [{ name: 'Space Grotesk', data: font, weight: 600, style: 'normal' }] },
          );
          const png = new Resvg(svg).render().asPng();
          writeFileSync('dist/client/og-spike.png', png);
          logger.info(
            `spike: ${png.length} bytes in ${Date.now() - started} ms, node ${process.version}, ${process.platform}-${process.arch}`,
          );
        },
      },
    },
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
      //
      // The 2026-09 redesign (design 1g, issue #104) set the code figure's own
      // values here rather than by overriding Expressive Code's output in
      // global.css, which is what this block exists for: 13px/1.7 on a
      // --rl-surface ground inside a 1px rule, with the frame caption at the
      // same mono micro every other label in the design uses. `borderWidth`
      // is spelled out because EC's default is 1.5px and the design's rules
      // are 1px to divide and 2px to open -- there is no 1.5px anywhere else
      // on the site. The box shadow is off for the same reason: the epic
      // allows no shadows, and EC draws one by default.
      styleOverrides: {
        borderRadius: '0',
        borderWidth: '1px',
        borderColor: 'var(--rl-rule)',
        codeBackground: 'var(--rl-surface)',
        codeFontFamily: 'var(--font-mono)',
        codeFontSize: '0.8125rem',
        codeLineHeight: '1.7',
        uiFontFamily: 'var(--font-mono)',
        uiFontSize: 'var(--text-micro)',
        frames: {
          frameBoxShadowCssValue: 'none',
          editorTabBarBackground: 'var(--rl-surface)',
          editorActiveTabBackground: 'var(--rl-surface)',
          editorActiveTabForeground: 'var(--rl-ink-muted)',
          terminalTitlebarBackground: 'var(--rl-surface)',
          terminalTitlebarForeground: 'var(--rl-ink-muted)',
          terminalTitlebarBorderBottomColor: 'var(--rl-rule)',
          terminalBackground: 'var(--rl-surface)',
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
    sitemap({
      filter: (page) => !isUnindexed(page),
      // No `changefreq`/`priority` here (issue #154): Google ignores both --
      // its own documentation says so in the section that also documents
      // `lastmod` -- and shipping a field a crawler ignores is noise a future
      // reader has to evaluate before dismissing.
      serialize(item) {
        const lastmod = lastmods.get(new URL(item.url).pathname);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
  ],
  markdown: {
    // Astro 7's default processor. `markdown.remarkPlugins` / `rehypePlugins`
    // belong to the legacy unified processor and hard-error without
    // @astrojs/markdown-remark installed -- see the plan's verified findings.
    //
    // `features.directive` defaults to false (satteri 0.10.5,
    // node_modules/satteri/dist/compile.d.ts) -- this is the line that makes
    // any directive parse at all, for `.mdx` content too: @astrojs/mdx
    // inherits this `markdown` config rather than running its own, unverified
    // until issue #102's Task 3 built this repo's `.mdx` content and grepped
    // the output for the rendered grid. An unclaimed directive renders as the
    // empty string with no warning and no trace in the output (measured
    // 2026-09-13, the plan's preflight finding 4 -- the exact failure mode
    // `figures()` below exists to avoid).
    //
    // THE PARAGRAPH THAT USED TO FOLLOW THAT ONE WAS WRONG, and it is worth
    // more here as a correction than as a deletion. It read: "Measured the
    // same day that this is forward-looking risk only: `grep -rn '^:::'
    // src/content/` returned nothing, so no existing page was parsed
    // differently the moment this line landed." The grep was real; the
    // conclusion drawn from it was not. It covered ONE of the three directive
    // kinds this single switch enables -- container (`:::name`) -- and missed
    // leaf (`::name`) and, the expensive one, text (`:name`, inline, anywhere
    // in any paragraph). The real blast radius was every colon in every
    // sentence: with directives on and nothing claiming the name, "At 05:17
    // UTC" rendered as "At 05 UTC", "3:2" as "3", "astro:content" as "astro".
    // It had already rewritten a published post in this branch's own build
    // output before anyone noticed, and five reviews passed over it because
    // no test in the suite rendered prose next to a colon.
    //
    // `literalDirectives()` is the fix and is listed FIRST: it restores an
    // unclaimed text or leaf directive to the text it was authored as, so
    // this switch changes nothing but the `:::figures` container -- with one
    // exception no visitor can close. THIS LINE USED TO CLAIM "changes
    // nothing but the `:::figures` container," full stop, and controller
    // Ruling 9 (2026-09-13) found that false in the same overclaiming shape
    // as the zero-blast-radius grep corrected above: an image's alt text is
    // also changed, because Sätteri flattens `![alt](url)` to a plain string
    // before any visitor runs, so an unclaimed colon inside alt text is
    // rewritten exactly like unclaimed prose is, and nothing can intervene
    // before that flattening happens. Recorded with the other exceptions in
    // `src/lib/literal-directives.mjs`; zero images exist in `src/content` or
    // `governance` today, so this is recorded risk rather than an active
    // corruption. The same 2026-09-13 review measured a second gap, a
    // directive nested inside another directive's label
    // (`:ref[astro:content]`) losing the inner name silently -- controller
    // Ruling 8 closed that one, so it is not an exception here.
    // `tests/literal-directives.test.ts` pins the rest as a byte-identity
    // invariant against the same content rendered with directives off.
    processor: satteri({
      features: { directive: true },
      mdastPlugins: [literalDirectives(), figures()],
      hastPlugins: [headingAnchors],
    }),
  },
  // The comments in this repository are written for whoever edits it next:
  // they record what was measured, on what date, and where an earlier version
  // of the comment was wrong. Several describe the tier boundary, grant
  // handling and the rate-limit buckets in detail. None of it is written for
  // the deployment, and the deployment was carrying it.
  //
  // Measured 2026-09-20, before this block existed. `dist/client` carried no
  // comments at all, because Vite minifies client assets and minification
  // drops them. `dist/server/entry.mjs` carried 787 comment lines on its own,
  // with hundreds more across the chunks, including the reasoning about grants
  // and the private tier. The Worker bundle was the whole of the leak.
  //
  // THE OBVIOUS FIX DOES NOT WORK HERE, and the reason is worth keeping. The
  // usual recipe is `build.minify` plus `esbuild.legalComments`, and neither
  // reaches this bundle. Astro hardcodes `minify: false` for the SSR build in
  // core/build/vite-build-config.js, commented "improve build performance",
  // and reads no user value there; the client environment on the same page
  // does read one. A `vite.environments.ssr.build.minify` does not survive
  // either, because that block spreads the user's ssr config and then replaces
  // `build` wholesale. Setting either one looks correct, changes nothing, and
  // reports no error, which is the failure mode worth naming.
  //
  // `rolldownOptions.output` is the one key of the user's ssr config that
  // block does keep, and Astro 7 builds with Rolldown, whose output options
  // carry `comments` and `legalComments` of their own. Measured after: 787 to
  // zero in entry.mjs, and no authored comment left anywhere in dist/server.
  //
  // `comments: false` drops third-party license banners along with the authored
  // ones, and Rolldown offers no setting between the two. Measured 2026-09-20:
  // `comments: { legal: true }` keeps all 3909 authored comment lines and three
  // files carrying a copyright notice; `comments: false` takes both. `legal` is
  // the only key the object accepts, `normal` is rejected as an invalid key,
  // and an invalid key voids the whole option so every comment comes back.
  //
  // Taking both is the right trade HERE and would not be everywhere. This
  // bundle runs on the server and is never served to anyone, so no copy of it
  // leaves Cloudflare. dist/client, which IS served, is untouched by this and
  // already carried neither authored comments nor a notice. The MCP Worker
  // keeps its `content-type` MIT banner, because wrangler builds it with
  // esbuild, whose `legalComments` does have the middle setting this lacks.
  //
  // What remains is Rolldown's own `//#region` markers, which are generated
  // rather than authored and name source paths. They would go under full
  // minification. That is deliberately not enabled: this Worker's stack traces
  // are read in production logs, and minified frames cost more there than the
  // markers do.
  //
  // `build.minify` below is for the client half, which is the one place Astro
  // does read it. Terser would work there too and is not a dependency here,
  // its minifier is several times slower, and esbuild's already drops every
  // comment, so adding one to strip what is already stripped buys nothing.
  //
  // This reaches the site Worker and its client assets. It does not reach
  // `ryanlindsey-me-mcp`, which wrangler builds from workers/mcp/ without
  // consulting this file, so that Worker still ships its comments.
  vite: {
    plugins: [tailwindcss()],
    build: {
      minify: 'esbuild',
    },
    environments: {
      ssr: {
        build: {
          rolldownOptions: {
            output: {
              comments: false,
            },
          },
        },
      },
    },
  },
});
