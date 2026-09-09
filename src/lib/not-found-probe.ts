/**
 * The path src/worker.ts asks Astro for when it needs the site's own 404.
 *
 * A module of its own, for one constant, because the property that matters
 * about this string is not testable where it is used: src/worker.ts imports
 * `@astrojs/cloudflare/handler`, whose virtual modules only exist inside
 * Astro's build, so a test cannot import that file to find out what the probe
 * path is. Declared here, both sides read the SAME value -- and
 * `tests/fit-pages.test.ts` asserts that fetching it returns the site 404
 * rather than a page.
 *
 * THE REQUIREMENT IS THAT IT KEEPS NOT MATCHING A ROUTE. `/fit`'s refusal is
 * whatever this path returns, so a route added here later would serve its own
 * page to every un-granted caller of `/fit` -- an unlisted page's refusal
 * quietly becoming someone else's content. The double underscores are a
 * convention and not a guarantee; the test is the guarantee.
 */
export const NOT_FOUND_PROBE = '/__unrouted__';
