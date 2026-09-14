import { readdirSync, readFileSync } from 'node:fs';

/**
 * `lastmod` values for the sitemap (issue #154, epic #150), keyed by pathname.
 *
 * Consumed by astro.config.mjs's `sitemap({ serialize })`, which is why this is
 * `.mjs` and reads the filesystem directly: the config runs before the content
 * layer exists, so `getCollection` is not available to it -- the same reason
 * src/lib/unindexed-routes.mjs is `.mjs` and reads the same way, and the same
 * `import.meta.url`-relative paths that file uses so both keep working
 * regardless of the process's own working directory.
 *
 * NEVER FALLS BACK TO `new Date()`. A build-time "now" stamped onto every URL
 * tells a crawler that every page changed on every deploy, which is false and
 * self-defeating -- a `lastmod` that always moves is one a crawler learns to
 * ignore. A path with no date of its own that would not be a guess is simply
 * absent from the returned Map, and astro.config.mjs's `serialize` leaves
 * `lastmod` off that entry entirely: the field is optional per entry in the
 * sitemap protocol, and omitting it is the honest answer.
 *
 * The frontmatter field names read below are `publishedAt` and `updatedAt`
 * (src/content.config.ts). They are NOT `datePublished`/`dateModified` --
 * those are the JSON-LD *output* names src/lib/structured-data.ts writes, one
 * layer downstream of this file, and reading them here would silently read
 * `undefined` off every entry.
 *
 * A FINDING RECORDED HERE SO IT IS NOT RE-DISCOVERED AS A BUG (measured
 * 2026-09-13, against the built `dist/client/sitemap-0.xml`): `resumeLastmod`
 * and `aiPolicyLastmod` below return their bare `YYYY-MM-DD` string
 * unwidened, on purpose, but the SERVED sitemap shows
 * `2026-09-13T00:00:00.000Z` for `/resume/` regardless. That is not this
 * module fabricating a timestamp -- the `sitemap` package `@astrojs/sitemap`
 * depends on (`normalizeURL` in `sitemap/dist/cjs/lib/utils.js`) unconditionally
 * runs every `lastmod` value, whatever this function returns, through
 * `new Date(lastmod).toISOString()` before it reaches the XML. The stream
 * option that would suppress that (`lastmodDateOnly`) exists in the `sitemap`
 * package but `@astrojs/sitemap` 3.7.4 never sets it and does not expose it
 * through `SitemapOptions`, so no combination of arguments to `sitemap()` in
 * astro.config.mjs can produce a date-only `<lastmod>` today. This module
 * still returns the unwidened string rather than widening it a second time
 * itself: that keeps its own output honest, keeps its return type uniform
 * with `articleLastmods` without duplicating that function's `.toISOString()`
 * call, and costs nothing if a future `@astrojs/sitemap` release exposes the
 * flag this file cannot reach today.
 */

/**
 * `updatedAt ?? publishedAt` for every published `.mdx` entry in `dir`, mapped
 * to `${routePrefix}/<slug>/` -- the same trailing-slash spelling Astro gives
 * every sitemap `<loc>`.
 *
 * Drafts are skipped rather than mapped to some placeholder: a draft never
 * reaches the sitemap at all (src/lib/unindexed-routes.mjs's filter), so there
 * is no entry here for `serialize` to ever look up.
 *
 * `publishedAt` and `updatedAt` are `z.coerce.date()` in the schema, so the
 * page that renders them (and structured-data.ts's JSON-LD) both call
 * `.toISOString()` on a `Date` -- reproduced here with `new Date(...)` on the
 * same bare `YYYY-MM-DD` string the frontmatter carries, so the sitemap serves
 * the exact value those coerce to rather than the shorter frontmatter spelling.
 */
function articleLastmods(dir, routePrefix) {
  const lastmods = new Map();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.mdx'))) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    const frontmatterEnd = source.indexOf('\n---', 3);
    if (frontmatterEnd === -1) {
      throw new Error(`${name}: no closing frontmatter fence found`);
    }
    // Only the frontmatter block, matching src/lib/unindexed-routes.mjs's own
    // `draftSlugs`, so a `publishedAt`/`updatedAt`-shaped string written in
    // prose in the body could never be mistaken for the field.
    const frontmatter = source.slice(0, frontmatterEnd);
    if (/\ndraft:\s*true\b/.test(frontmatter)) continue;

    // Anchored to end of line (`m` flag, whole-branch review of epic #150):
    // without the trailing `\s*$`, this pattern matches only the date prefix
    // of a `publishedAt: 2026-09-12T14:30:00Z` spelling and silently drops
    // the time, which `src/content.config.ts`'s `z.coerce.date()` accepts,
    // so nothing upstream would catch it. Anchored, that spelling falls
    // through to the `throw` below instead of being truncated.
    const publishedAt = /\npublishedAt:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m.exec(
      frontmatter,
    )?.[1];
    const updatedAt = /\nupdatedAt:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m.exec(frontmatter)?.[1];
    if (!publishedAt) {
      throw new Error(`${name}: no publishedAt found in frontmatter`);
    }

    const slug = name.replace(/\.mdx$/, '');
    lastmods.set(`${routePrefix}/${slug}/`, new Date(updatedAt ?? publishedAt).toISOString());
  }
  return lastmods;
}

/**
 * `/resume/`'s date, from `src/content/resume/*.yaml`'s `meta.lastModified` --
 * already a `YYYY-MM-DD` string (src/content.config.ts's `isoDate`), returned
 * unwidened rather than promoted to a timestamp the way `articleLastmods`
 * above deliberately does for the coerced `Date` fields. See this file's
 * header for the measured reason the served XML widens it anyway.
 */
function resumeLastmod() {
  const source = readFileSync(
    new URL('../content/resume/ryan-lindsey.yaml', import.meta.url),
    'utf8',
  );
  const lastModified = /^\s*lastModified:\s*'(\d{4}-\d{2}-\d{2})'\s*$/m.exec(source)?.[1];
  if (!lastModified) {
    throw new Error('ryan-lindsey.yaml: no meta.lastModified found');
  }
  return lastModified;
}

/**
 * `/ai-policy/`'s date, from `governance/*.md`'s `updated` frontmatter --
 * same already-a-string shape and the same reason it is returned unwidened as
 * `resumeLastmod` above.
 */
function aiPolicyLastmod() {
  const source = readFileSync(new URL('../../governance/ai-policy.md', import.meta.url), 'utf8');
  // Same anchored pattern tests/pages.test.ts's `policyUpdated` already uses
  // to read this file, so the two readers of this one field agree on its shape.
  const updated = /^updated:\s*'?(\d{4}-\d{2}-\d{2})'?\s*$/m.exec(source)?.[1];
  if (!updated) {
    throw new Error('ai-policy.md: no updated date found in frontmatter');
  }
  return updated;
}

/**
 * Every sitemap URL's `lastmod`, as a Map from pathname (trailing slash, no
 * origin -- matching `new URL(item.url).pathname` inside `serialize`) to the
 * ISO date string to serve.
 *
 * `/`, `/writing/`, `/work/`, `/chat/` and `/ops/` are deliberately absent:
 * each is assembled from other content and has no date of its own that would
 * not be a guess, so `serialize` finds no entry for them and leaves `lastmod`
 * off rather than inventing one.
 */
export function sitemapLastmods() {
  const lastmods = new Map([
    ...articleLastmods(new URL('../content/posts/', import.meta.url), '/writing'),
    ...articleLastmods(new URL('../content/caseStudies/', import.meta.url), '/work'),
  ]);
  lastmods.set('/resume/', resumeLastmod());
  lastmods.set('/ai-policy/', aiPolicyLastmod());
  return lastmods;
}
