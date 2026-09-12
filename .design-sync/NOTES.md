# design-sync notes

## This repo is not a component library, and the stock converter cannot run on it

`ryanlindsey.me` is an Astro content site: 10 `.astro` components, no React, no Storybook, no `*.stories.*`, `private: true` with no `exports`, and a `dist/` that is a built website (`dist/client` assets plus a `dist/server` Worker) rather than a compiled library.

The centerpiece of the upload format is `_ds_bundle.js`, a browser bundle exposing real compiled React components at `window.<globalName>.*`. Astro components compile to a server-side render function that needs Astro's runtime, so esbuild cannot bundle them into standalone browser components, and the claude.ai/design agent renders React. Both converter shapes dead-end at the same place. No config key rescues this; do not spend time looking for one.

**What is synced instead**: the style layer only, decided with Ryan on 2026-09-12. Tokens, type scale, families, the utility vocabulary, and two foundation specimen cards. This is the skill's "off-script generation" path. The layout is produced by `.design-sync/build-styles.mjs` rather than by `package-build.mjs`, and `package-validate.mjs` is not applicable because there are no components to validate.

## The bug that matters, and why the render check is not optional

`@theme` is not a native CSS at-rule. A browser skips the entire block, so `var(--font-mono)`, `var(--font-sans)` and `var(--text-body)` resolve to nothing and every card renders in Times. The first render check caught exactly this; reading the CSS did not.

On the real site those variables resolve because Tailwind emits them to `:root` at build time. Verified against `dist/client/_astro/Shell.DyeC17h2.css`: Tailwind emits `--font-*` and `--text-*`, and does **not** emit the `--color-*` aliases, because `inline` resolves color utilities to `var(--rl-*)` directly.

`tokens/scale.css` exists to close that gap and is a deliberate superset of the built site: Tailwind tree-shakes the theme down to the variables the site actually references (today only `--text-body` and `--text-micro` survive), and a design system cannot tree-shake, because the agent may reference any of them.

**If you change anything about the style pipeline, re-run the render check before uploading.** Serve the bundle and screenshot both foundation cards. A font regression here is invisible in the CSS and obvious in the picture.

## Running it

```sh
node .design-sync/build-styles.mjs          # rebuild ds-bundle/ from src/styles/
cd ds-bundle && python3 -m http.server 8891 # then screenshot the two Foundations cards
```

Everything is derived by parsing `src/styles/global.css` and copying `src/styles/tokens.css` verbatim. A token added to the `@theme inline` block reaches the design system on the next run with no edit to the script. Nothing in the script hardcodes a color, a size or a family.

## Re-sync risks

- **No `_ds_sync.json` is uploaded.** The anchor's key recipe is component-centric and there are no components, so a hand-made sidecar would vouch for a shape that does not exist. The cost is that every re-sync re-verifies from scratch, which for a style-only bundle is one build and two screenshots. This is the documented honest choice, not an oversight.
- **Chrome extension was not connected** on 2026-09-12, so render checks ran through local headless Microsoft Edge. Edge is slow to exit: run it detached and poll for the PNG rather than waiting on the process, or the screenshot looks like a failure when it is about to succeed.
- **`components/Foundations/` holds cards, not components.** They carry the `@dsCard` marker so the pane indexes them, and they have no `.jsx` or `.d.ts` on purpose. If the app's self-check ever complains about a component directory without an API contract, these are why.
- **`_ds_bundle.js` is deliberately an empty namespace** (`window.RLME = {}`) with a well-formed `@ds-bundle` header. It exists because the self-check expects the file at the project root. Do not fill it with invented components.
- **Fonts are latin and latin-ext only**, matching the site's own subset reasoning. Six woff2 faces, about 280 KB.

## If this repo ever grows a React component library

Delete `shape: "style-only"` from the config, drop `build-styles.mjs`, and run the stock skill from the top. The conventions header is worth keeping and updating rather than rewriting: its house rules came from `src/styles/` and the private docs repo, not from the build.
