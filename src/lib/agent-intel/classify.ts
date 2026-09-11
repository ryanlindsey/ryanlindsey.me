// Agent-traffic classification (06 §3). PURE: request signals in, a label out.
// No bindings, no clock, no network -- which is what lets the whole rule set be
// table-tested, and what keeps the one thing /ops publishes as its headline
// number ("agents served") from being decided inside a Worker handler nobody
// can exercise.
//
// WHAT IS DELIBERATELY NOT READ: cookies (there are none), IP, TLS fingerprint,
// header order, or anything else that identifies a person rather than a client.
// /ai-policy (06 §2) states the site fingerprints nothing beyond UA and route,
// and this module is where that promise is either kept or broken. Adding a
// signal here is a change to a published document.

export type AgentClass = 'agent' | 'browser' | 'unknown';
export type RouteClass = 'agent-signal' | 'content' | 'other';
export type ReferrerClass = 'campaign' | 'social' | 'search' | 'none' | 'other';

export interface RequestSignals {
  userAgent: string | null;
  pathname: string;
  accept: string | null;
  referer: string | null;
  /**
   * `Sec-Fetch-Mode`. Every current browser sends it on every navigation and
   * subresource fetch; almost nothing else does, because it is added by the
   * browser rather than by the caller. That asymmetry is the single most
   * reliable browser marker available without fingerprinting, and it is the
   * reason rule 3 below can be a positive test for "browser" rather than a
   * negative test for "not a bot".
   */
  secFetchMode: string | null;
}

export interface Classification {
  agentClass: AgentClass;
  /** A stable label for the client, or `'unknown'`. Never a raw UA string. */
  agent: string;
  routeClass: RouteClass;
  referrerClass: ReferrerClass;
}

/**
 * Known AI clients, most specific first.
 *
 * ORDER IS LOAD-BEARING in two places, and both are real UA strings rather than
 * hypotheticals: `Claude-User` and `Claude-SearchBot` must precede `ClaudeBot`
 * (the shorter is not a prefix of the longer, but a future `ClaudeBot-User`
 * would make it one), and `Applebot-Extended` must precede `Applebot`, which it
 * genuinely is a prefix of. A first-match loop over an ordered list is the
 * cheapest structure that makes that orderable at all.
 *
 * The label is what /ops renders and what the Analytics Engine row carries, so
 * it is written the way the operator of that crawler writes it.
 */
const KNOWN_AGENTS: readonly (readonly [RegExp, string])[] = [
  [/Claude-SearchBot/i, 'Claude-SearchBot'],
  [/Claude-User/i, 'Claude-User'],
  [/ClaudeBot/i, 'ClaudeBot'],
  [/anthropic-ai/i, 'anthropic-ai'],
  [/ChatGPT-User/i, 'ChatGPT-User'],
  [/OAI-SearchBot/i, 'OAI-SearchBot'],
  [/GPTBot/i, 'GPTBot'],
  [/Perplexity-User/i, 'Perplexity-User'],
  [/PerplexityBot/i, 'PerplexityBot'],
  [/Google-Extended/i, 'Google-Extended'],
  [/GoogleOther/i, 'GoogleOther'],
  [/Googlebot/i, 'Googlebot'],
  [/BingPreview/i, 'BingPreview'],
  [/bingbot/i, 'bingbot'],
  [/Bytespider/i, 'Bytespider'],
  [/Amazonbot/i, 'Amazonbot'],
  [/Applebot-Extended/i, 'Applebot-Extended'],
  [/Applebot/i, 'Applebot'],
  [/meta-externalagent/i, 'meta-externalagent'],
  [/FacebookBot/i, 'FacebookBot'],
  [/DuckAssistBot/i, 'DuckAssistBot'],
  [/MistralAI-User/i, 'MistralAI-User'],
  [/cohere-ai/i, 'cohere-ai'],
  [/CCBot/i, 'CCBot'],
];

/**
 * This site's own service-binding caller (`src/lib/fit/client.ts` sets it).
 * Labelled rather than counted as a stranger: a `/fit` run generates one of
 * these per report, and folding them into the public agent numbers would
 * inflate the one stat /ops exists to publish with our own traffic.
 */
const FIRST_PARTY = /^ryanlindsey-me-/i;

/** Ordinary HTTP clients: not AI, not a browser, and worth telling apart from both. */
const HTTP_CLIENT =
  /\b(curl|wget|python-requests|httpx|aiohttp|node-fetch|undici|axios|Go-http-client|okhttp|libwww-perl|Java)\b/i;

/** The catch-all. Last, so every named client above wins first. */
const GENERIC_BOT = /(bot|crawler|spider|scrape|slurp)/i;

const AGENT_SIGNAL_EXACT = new Set([
  '/llms.txt',
  '/llms-full.txt',
  '/resume.json',
  '/resume.md',
  '/rss.xml',
  '/feed.json',
  '/robots.txt',
  '/mcp',
]);

const MARKDOWN_VARIANT = /^\/(writing|work)\/.+\.md$/;
const CONTENT_ROUTE = /^\/(writing|work)\/.+$/;

const SOCIAL_HOSTS = [
  'linkedin.com',
  'news.ycombinator.com',
  'reddit.com',
  'x.com',
  'twitter.com',
  't.co',
  'bsky.app',
  'mastodon.social',
  'lobste.rs',
];

const SEARCH_HOSTS = ['google.', 'bing.com', 'duckduckgo.com', 'ecosia.org', 'kagi.com'];

/**
 * Whether `hostname` is `domain` or a subdomain of it.
 *
 * The dot in the suffix test is the whole of it: `endsWith(domain)` alone
 * matches `notexample.com` for `example.com`, which would let anyone claim a
 * campaign's referrer class by registering a lookalike. Cheap to get wrong and
 * silent when it is, so it is a named function with its own test.
 */
function hostMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const target = domain.toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

export function routeClassFor(pathname: string): RouteClass {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (AGENT_SIGNAL_EXACT.has(path)) return 'agent-signal';
  if (path.startsWith('/.well-known/')) return 'agent-signal';
  if (MARKDOWN_VARIANT.test(path)) return 'agent-signal';
  if (path === '/resume' || CONTENT_ROUTE.test(path)) return 'content';
  return 'other';
}

export function referrerClassFor(
  referer: string | null,
  campaignDomains: readonly string[],
): ReferrerClass {
  if (referer === null || referer === '') return 'none';
  let hostname: string;
  try {
    hostname = new URL(referer).hostname;
  } catch {
    // A `Referer` is attacker-supplied text; an unparseable one is data, not an
    // error, and must never be able to take a request down.
    return 'other';
  }
  // Campaign first, so a campaign hosted on a job board or on LinkedIn is
  // counted as the campaign rather than as social traffic -- 06 §3 wants the
  // campaign attribution, and the two overlap by design.
  if (campaignDomains.some((domain) => hostMatches(hostname, domain))) return 'campaign';
  if (SOCIAL_HOSTS.some((domain) => hostMatches(hostname, domain))) return 'social';
  if (SEARCH_HOSTS.some((prefix) => hostname.includes(prefix))) return 'search';
  return 'other';
}

/**
 * The five signals, off a real `Request`.
 *
 * Separated from `classifyRequest` so the rules can be tested without building
 * a `Request` for each of forty cases, and so the exact header list is one
 * readable line rather than something to reconstruct from the call site.
 */
export function signalsFrom(request: Request): RequestSignals {
  return {
    userAgent: request.headers.get('user-agent'),
    pathname: new URL(request.url).pathname,
    accept: request.headers.get('accept'),
    referer: request.headers.get('referer'),
    secFetchMode: request.headers.get('sec-fetch-mode'),
  };
}

/**
 * Whether `accept` asks for markdown ahead of HTML.
 *
 * A deliberately narrower reimplementation than `prefersMarkdown` in
 * src/worker.ts, and the difference is worth stating rather than deduping: that
 * one decides what to SERVE and therefore implements RFC 9110's specificity and
 * q-value rules exactly, because getting it wrong changes the site's default
 * representation for every client sending a bare wildcard. This one decides
 * what to COUNT, so it reads only the two media types it cares about and
 * compares their weights. Importing the strict version would mean exporting it
 * from the Worker entry -- a module that imports Astro's virtual modules and
 * cannot be loaded by a plain vitest process, which is exactly why every pure
 * rule in this repo lives under src/lib.
 *
 * IT COMPARES q-VALUES RATHER THAN TESTING FOR ABSENCE, and that is the whole
 * of the difference from the obvious version. `text/markdown` with no
 * `text/html` beside it is the easy case and almost nobody sends it: a polite
 * client that can read either and would rather have markdown sends
 * `text/markdown;q=1.0, text/html;q=0.5`, which is exactly the request this
 * rule exists to catch. A substring test for `text/html` would read that as a
 * browser and drop the one signal it was written for.
 *
 * Nothing here throws and nothing here is strict: an unparseable q defaults to
 * 1 the way RFC 9110 says an absent one does, because a false negative costs
 * one mislabelled row and a thrown error costs a request.
 */
function prefersMarkdown(accept: string | null): boolean {
  if (accept === null) return false;
  const markdown = qualityOf(accept, 'text/markdown');
  if (markdown === null) return false;
  const html = qualityOf(accept, 'text/html');
  return html === null || markdown > html;
}

/** The q-value `accept` gives `type`, or `null` when it does not list it at all. */
function qualityOf(accept: string, type: string): number | null {
  for (const entry of accept.toLowerCase().split(',')) {
    const [media = '', ...parameters] = entry.trim().split(';');
    if (media.trim() !== type) continue;
    const q = parameters.map((parameter) => parameter.trim()).find((p) => p.startsWith('q='));
    if (q === undefined) return 1;
    const value = Number(q.slice(2));
    return Number.isFinite(value) ? value : 1;
  }
  return null;
}

/**
 * The rules, in order, and the order is the design:
 *
 * 1. A named AI client wins outright. Its own UA is the most reliable thing
 *    about it, and every operator in `KNOWN_AGENTS` publishes theirs.
 * 2. First-party, then ordinary HTTP clients, then the generic bot catch-all.
 * 3. `Sec-Fetch-Mode` present -> browser. This runs AFTER the UA rules on
 *    purpose: a headless browser driving a crawl sends it too, and when the UA
 *    says which crawler it is, that is the more useful label.
 * 4. Markdown preferred over HTML, or an agent-signal route -> agent, unnamed.
 *    These are 06 §3's "signal routes and heuristics"; they catch the polite
 *    client that sends no distinguishing UA at all.
 * 5. Otherwise unknown. NOT "browser": an unlabelled request with no browser
 *    marker is genuinely unclassified, and /ops publishing it as human traffic
 *    would be the one number on that page that is a guess.
 */
export function classifyRequest(
  signals: RequestSignals,
  campaignDomains: readonly string[],
): Classification {
  const routeClass = routeClassFor(signals.pathname);
  const referrerClass = referrerClassFor(signals.referer, campaignDomains);
  const ua = signals.userAgent ?? '';

  const agentOf = (): string | null => {
    for (const [pattern, label] of KNOWN_AGENTS) if (pattern.test(ua)) return label;
    if (FIRST_PARTY.test(ua)) return 'first-party';
    if (HTTP_CLIENT.test(ua)) return 'http-client';
    if (GENERIC_BOT.test(ua)) return 'other-bot';
    return null;
  };

  const named = agentOf();
  if (named !== null) return { agentClass: 'agent', agent: named, routeClass, referrerClass };

  if (signals.secFetchMode !== null && signals.secFetchMode !== '') {
    return { agentClass: 'browser', agent: 'browser', routeClass, referrerClass };
  }

  if (prefersMarkdown(signals.accept) || routeClass === 'agent-signal') {
    return { agentClass: 'agent', agent: 'unknown', routeClass, referrerClass };
  }

  return { agentClass: 'unknown', agent: 'unknown', routeClass, referrerClass };
}
