/**
 * The primary navigation, in the order the 2026-09 redesign puts it.
 *
 * A module because three surfaces read it, and as of issue #101 all three do:
 * the header rule bar, the footer's SITE column (which filters /chat back out
 * -- Ask my agent stays nav-only, since the footer is where it used to live
 * and repeating it there would undo the promotion), and the mobile
 * full-screen overlay.
 *
 * Ops and AI Policy are deliberately absent. They were demoted out of the
 * primary nav in review: they are about the site rather than part of reading
 * it, and they now live in the footer's SYSTEM column -- SYSTEM_LINKS below.
 */
export const NAV_LINKS = [
  { href: '/writing', label: 'Writing' },
  { href: '/work', label: 'Work' },
  { href: '/resume', label: 'Resume' },
  { href: '/chat', label: 'Ask my agent' },
] as const;

/**
 * The footer's SYSTEM column: the two links issue #99 demoted out of the
 * primary nav, and the changelog.
 *
 * Changelog points at /ops#releases because there is no /changelog route.
 * src/pages/ops.astro renders the parsed release history under
 * `aria-labelledby="releases"`, which is the thing the design's label means; a
 * standalone route would be a separate issue, not an invention here.
 *
 * This list and AGENT_LINKS below were local consts in SiteFooter.astro until
 * issue #101, which gave the mobile overlay a footer strip of the same
 * demoted links. Two components rendering the same five destinations from two
 * hand-kept arrays is how a link gets added to the colophon and silently
 * never reaches a phone, so they moved here beside NAV_LINKS rather than
 * being copied. The reasoning moved with them; none of it is new.
 */
export const SYSTEM_LINKS = [
  { href: '/ops', label: 'Ops' },
  { href: '/ai-policy', label: 'AI Policy' },
  { href: '/ops#releases', label: 'Changelog' },
] as const;

/**
 * The footer's FOR AGENTS column.
 *
 * Day 3 Task 9 (02 §3): the agent courtesies -- /llms.txt (the curated index)
 * and the MCP endpoint. /llms-full.txt is deliberately NOT linked: it is the
 * bulk-ingestion corpus and /llms.txt already points at it (task-9-brief.md
 * Step 3), so a link to both would be redundant, and a link to the raw corpus
 * is not a courtesy to a human visitor scanning a colophon. The `.md` variant
 * routes (Task 7) have no single URL to link -- they are discoverable
 * page-by-page via each HTML page's own <link rel="alternate">.
 *
 * Fix round 1 (task-9-report.md): the MCP link is `/mcp` on that domain, not
 * the bare origin -- the custom domain is only the host,
 * `workers/mcp/src/index.ts`'s `createMcpHandler(..., { route: '/mcp' })`
 * mounts the actual JSON-RPC endpoint at that path, and the bare origin 404s.
 * Verified live: POST https://mcp.ryanlindsey.me/mcp with an `initialize` body
 * succeeds.
 *
 * 2026-09 redesign (issue #100): the one-line footer those two paragraphs were
 * written for is gone, replaced by the five-column colophon, but both reasons
 * survive the rewrite intact and are why this list carries /llms.txt and /mcp
 * and not /llms-full.txt or the bare origin. RSS joined them: the design names
 * three FOR AGENTS links and RSS is the one it names. /feed.json is the JSON
 * Feed twin, built by the same module (src/lib/feeds.ts) and still advertised
 * on every page by Base.astro's <link rel="alternate">, so it is reachable
 * without spending a fourth slot in a column the design sized at three.
 */
export const AGENT_LINKS = [
  { href: '/llms.txt', label: 'llms.txt' },
  { href: 'https://mcp.ryanlindsey.me/mcp', label: 'MCP' },
  { href: '/rss.xml', label: 'RSS' },
] as const;
