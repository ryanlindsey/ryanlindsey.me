import { handle } from '@astrojs/cloudflare/handler';
import { regenerateResumePdf } from './lib/resume-pdf';

/**
 * The site's Worker entry.
 *
 * `workerEntryPoint` was removed in @astrojs/cloudflare v13 / Astro 6. The
 * supported mechanism is `main` in wrangler.jsonc plus `handle` from
 * @astrojs/cloudflare/handler, which is exactly what Astro's own stock entry
 * is (`{ fetch: handle }`) -- this file REPLACES that entry rather than
 * wrapping it, so `handle` is called directly and undecorated.
 *
 * This file only exists once a route opts out of prerendering. With
 * `output: 'static'` and no such route, the adapter passes `main: undefined`
 * to its Vite plugin and the build is assets-only, which would leave
 * `scheduled()` below working under `astro dev` and silently absent from the
 * deployed Worker. src/pages/resume.pdf.ts is the route that keeps that from
 * happening; it is on-demand by nature rather than a contrivance.
 *
 * Tasks 8 and 12 add their handlers here.
 */
export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),

  /**
   * Daily résumé-PDF refresh (see `triggers.crons` in wrangler.jsonc).
   *
   * `force: false` is the whole point: regenerateResumePdf returns without
   * touching a browser unless the résumé source hash has moved, so the steady
   * state of this cron is one KV read.
   *
   * NOT YET PROVEN: Astro's docs show `fetch`, `queue` and Durable Object
   * exports from this entry but carry no `scheduled()` example. It should
   * survive the adapter's build by the same `ExportedHandler` rule the others
   * do, but that is inference. Task 16 confirms the deployed Worker actually
   * lists the cron trigger.
   */
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(regenerateResumePdf(env, { force: false }));
  },
} satisfies ExportedHandler<Env>;
