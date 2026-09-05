// Single source of truth for pillar display labels (02 §2's three fixed
// pillars, declared as the `pillar` enum in content.config.ts). Deliberately
// its own module rather than living in content.config.ts: that file's
// `defineCollection()` calls run its `glob()` loader eagerly at import time,
// which is fine inside Astro's content layer but crashes the Cloudflare
// prerender sandbox when anything imports content.config.ts from ordinary
// component code just to reach a plain object export.
export const PILLAR_LABELS: Record<string, string> = {
  'agentic-engineering': 'Agentic engineering',
  'org-scaling': 'Org scaling',
  'building-in-the-open': 'Building in the open',
};
