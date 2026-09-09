/**
 * `prompts/fit.md?raw` is imported as a string by src/lib/fit/engine.ts. This
 * declaration is what makes that import typecheck; the bundler on each side is
 * what makes it resolve.
 *
 * THE `?raw` IS LOAD-BEARING AND IS NOT DECORATION, and the reason is a
 * collision this repo cannot win any other way. Astro ships its own ambient
 * `declare module '*.md'` (node_modules/astro/client.d.ts, in scope because
 * tsconfig.json lists `astro/client` in `types`), and it resolves the default
 * export to an `AstroComponentFactory` -- a rendered page component, which is
 * the right answer for every OTHER markdown file in an Astro project.
 * MEASURED: with a plain `.md` specifier, `astro check` fails with
 * `ts(2322): Type 'AstroComponentFactory' is not assignable to type 'string'`
 * on the `system:` field of the model call. Redeclaring `'*.md'` here would
 * not fix it either -- TypeScript picks between two wildcard patterns by
 * longest PREFIX, both prefixes are empty, so which one wins is an ordering
 * accident -- and overriding it would be wrong anyway, because Astro's meaning
 * is the correct one for the content collections.
 *
 * `*.md?raw` collides with nothing: Astro's pattern requires the specifier to
 * END in `.md`, and this one does not, so exactly one declaration matches.
 * `?raw` is also Vite's own spelling for "give me this file as a string", so
 * vitest and `astro build` both honour it natively with no plugin, and
 * wrangler strips the query before applying its `Text` rule (see the `rules`
 * entry in workers/mcp/wrangler.jsonc, which documents the matching).
 */
declare module '*.md?raw' {
  const contents: string;
  export default contents;
}
