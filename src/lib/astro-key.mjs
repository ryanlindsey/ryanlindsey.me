/**
 * Refuses a Workers Builds build that has no fixed `ASTRO_KEY`.
 *
 * WITHOUT ONE, EVERY DEPLOY STRANDS EVERY COPY OF `/` ALREADY OUT THERE. Astro
 * encrypts a server island's component name into its URL with a key it reads
 * from `ASTRO_KEY` at build time, or generates at random when that is unset
 * (node_modules/astro/dist/core/build/index.js), and the island endpoint
 * answers 400 to a name it cannot decrypt. Astro's loader swaps in a 200 and
 * nothing else, so the system band's five tiles stay blank under their labels,
 * with no error on the page and the dot still muted.
 *
 * src/components/SystemBandFigures.astro called that window short, on the
 * grounds that `/` is served `max-age=0, must-revalidate`. Measured on
 * 2026-09-27 it was not: the owner saw blank tiles on a phone and on a desktop
 * after a cold start, and a refresh filled them. The mechanism is inferred
 * rather than caught in a log. A browser restoring a tab can render the HTML
 * it already holds without revalidating, and three deploys went out that day,
 * while the live endpoint answered the current key in under a second, cold
 * cache included, and a foreign key with 400.
 *
 * `WORKERS_CI` IS THE SWITCH, because Workers Builds sets it to `1` and nothing
 * else here does. GitHub Actions and a local build have no deploy to survive,
 * so they keep Astro's random key and need no secret.
 *
 * @param {Record<string, string | undefined>} env
 */
export function assertAstroKey(env) {
  if (env.WORKERS_CI === undefined || env.WORKERS_CI === '') return;
  if (env.ASTRO_KEY !== undefined && env.ASTRO_KEY !== '') return;
  throw new Error(
    'ASTRO_KEY is not set for this Workers Builds build. Without a key fixed ' +
      'across builds, every copy of / built before this deploy asks for a ' +
      'server island the new build refuses. Generate one with ' +
      '`npx astro create-key` and add it under Settings > Build > Build ' +
      'Variables and Secrets.',
  );
}
