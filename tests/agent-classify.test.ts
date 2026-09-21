import { describe, expect, test } from 'vitest';
import { classifyRequest, heroLineForReferrer, signalsFrom } from '../src/lib/agent-intel/classify';
import type { HeroIndexEntry } from '../src/lib/tier/hero-index';

const base = {
  userAgent: null,
  pathname: '/',
  accept: null,
  referer: null,
  secFetchMode: null,
};

describe('classifyRequest', () => {
  test.each([
    ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ClaudeBot'],
    ['Mozilla/5.0 ... Claude-User/1.0', 'Claude-User'],
    ['claude-code/2.1.278 (sdk-cli)', 'Claude-Code'],
    ['Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'GPTBot'],
    ['Mozilla/5.0 (compatible; OAI-SearchBot/1.0)', 'OAI-SearchBot'],
    ['Mozilla/5.0 (compatible; PerplexityBot/1.0)', 'PerplexityBot'],
    ['Mozilla/5.0 (compatible; Google-Extended)', 'Google-Extended'],
    ['Mozilla/5.0 (compatible; bingbot/2.0)', 'bingbot'],
    ['Bytespider', 'Bytespider'],
    ['curl/8.7.1', 'http-client'],
    ['python-requests/2.32.3', 'http-client'],
    ['ryanlindsey-me-fit/1', 'first-party'],
    ['SomeUnknownCrawler/1.0 (+bot)', 'other-bot'],
  ])('%s is an agent named %s', (userAgent, agent) => {
    const result = classifyRequest({ ...base, userAgent }, []);
    expect(result.agentClass).toBe('agent');
    expect(result.agent).toBe(agent);
  });

  test('a browser navigation is a browser even on an agent-signal route', () => {
    const result = classifyRequest(
      {
        ...base,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        pathname: '/llms.txt',
        secFetchMode: 'navigate',
      },
      [],
    );
    expect(result.agentClass).toBe('browser');
    expect(result.routeClass).toBe('agent-signal');
  });

  test('markdown preference with no Sec-Fetch-Mode reads as an agent', () => {
    const result = classifyRequest(
      { ...base, pathname: '/resume', accept: 'text/markdown;q=1.0, text/html;q=0.5' },
      [],
    );
    expect(result.agentClass).toBe('agent');
    expect(result.agent).toBe('unknown');
  });

  test.each([
    ['text/markdown', true],
    ['text/markdown;q=1.0, text/html;q=0.5', true],
    ['text/html;q=1.0, text/markdown;q=0.5', false],
    ['text/html,text/markdown', false],
    ['text/html', false],
    ['*/*', false],
  ])('accept %s prefers markdown: %s', (accept, prefers) => {
    // `/resume` is route class `content`, so the ONLY thing that can make this
    // an agent is the accept header -- which is what makes this a test of
    // `prefersMarkdown` rather than of the route table.
    const result = classifyRequest({ ...base, pathname: '/resume', accept }, []);
    expect(result.agentClass).toBe(prefers ? 'agent' : 'unknown');
  });

  test('an agent-signal route with no browser marker reads as an agent', () => {
    const result = classifyRequest({ ...base, pathname: '/resume.json' }, []);
    expect(result.agentClass).toBe('agent');
  });

  test.each([
    ['/llms.txt', 'agent-signal'],
    ['/llms-full.txt', 'agent-signal'],
    ['/resume.json', 'agent-signal'],
    ['/writing/some-post.md', 'agent-signal'],
    ['/work/some-study.md', 'agent-signal'],
    ['/.well-known/mcp.json', 'agent-signal'],
    ['/mcp', 'agent-signal'],
    ['/rss.xml', 'agent-signal'],
    ['/feed.json', 'agent-signal'],
    ['/robots.txt', 'agent-signal'],
    ['/writing/some-post', 'content'],
    ['/work/some-study/', 'content'],
    ['/resume', 'content'],
    ['/', 'other'],
    ['/ops', 'other'],
  ])('%s is route class %s', (pathname, routeClass) => {
    expect(classifyRequest({ ...base, pathname }, []).routeClass).toBe(routeClass);
  });

  test.each([
    [null, 'none'],
    ['https://www.linkedin.com/feed/', 'social'],
    ['https://news.ycombinator.com/', 'social'],
    ['https://www.google.com/search?q=x', 'search'],
    ['https://example.org/blog', 'other'],
  ])('referer %s is class %s', (referer, referrerClass) => {
    expect(classifyRequest({ ...base, referer }, []).referrerClass).toBe(referrerClass);
  });

  test('a configured campaign domain outranks every other referrer class', () => {
    const result = classifyRequest({ ...base, referer: 'https://careers.example.com/postings/1' }, [
      'careers.example.com',
    ]);
    expect(result.referrerClass).toBe('campaign');
  });

  test('a campaign domain matches its subdomains but not a lookalike suffix', () => {
    expect(
      classifyRequest({ ...base, referer: 'https://jobs.example.com/x' }, ['example.com'])
        .referrerClass,
    ).toBe('campaign');
    expect(
      classifyRequest({ ...base, referer: 'https://notexample.com/x' }, ['example.com'])
        .referrerClass,
    ).toBe('other');
  });

  test('an unparseable referer is "other", never a throw', () => {
    expect(classifyRequest({ ...base, referer: 'not a url' }, []).referrerClass).toBe('other');
  });

  test('signalsFrom reads exactly the five headers it documents', () => {
    const request = new Request('https://ryanlindsey.me/llms.txt', {
      headers: {
        'user-agent': 'curl/8.7.1',
        accept: 'text/plain',
        referer: 'https://example.org/',
        'sec-fetch-mode': 'cors',
      },
    });
    expect(signalsFrom(request)).toEqual({
      userAgent: 'curl/8.7.1',
      pathname: '/llms.txt',
      accept: 'text/plain',
      referer: 'https://example.org/',
      secFetchMode: 'cors',
    });
  });
});

describe('heroLineForReferrer', () => {
  const entry = (over: Partial<HeroIndexEntry> = {}): HeroIndexEntry => ({
    domain: 'example.test',
    heroLine: 'Hello from a campaign.',
    ...over,
  });

  test("an exact hostname match returns that entry's hero line", () => {
    const index = [entry({ domain: 'example.test', heroLine: 'Exact match line.' })];
    expect(heroLineForReferrer('https://example.test/postings/1', index)).toBe('Exact match line.');
  });

  test('a subdomain of a listed domain matches -- the property a direct key lookup would lose', () => {
    const index = [entry({ domain: 'example.test', heroLine: 'Subdomain line.' })];
    expect(heroLineForReferrer('https://jobs.example.test/x', index)).toBe('Subdomain line.');
  });

  test('a lookalike suffix does not match', () => {
    const index = [entry({ domain: 'example.test', heroLine: 'Should not appear.' })];
    expect(heroLineForReferrer('https://notexample.test/x', index)).toBeNull();
  });

  test('first match wins when two entries claim the same domain', () => {
    const index = [
      entry({ domain: 'shared.test', heroLine: 'First.' }),
      entry({ domain: 'shared.test', heroLine: 'Second.' }),
    ];
    expect(heroLineForReferrer('https://shared.test/x', index)).toBe('First.');
  });

  test('an entry with heroLine "" reports "" rather than null -- distinct from no match', () => {
    // The caller (`withCampaignHero` in src/lib/tier/hero-band.ts) treats both
    // "" and `null` as "no band", but this function must not collapse them
    // itself:
    // "" means a campaign matched and its authored line is empty, while
    // `null` means nothing matched at all. Collapsing the two here would
    // hide that distinction from any future caller that wants it.
    const index = [entry({ domain: 'example.test', heroLine: '' })];
    expect(heroLineForReferrer('https://example.test/x', index)).toBe('');
  });

  test.each([
    [null, 'a null referrer'],
    ['', 'an empty referrer'],
    ['not a url', 'an unparseable referrer'],
  ])('%s (%s) returns null', (referer, _label) => {
    const index = [entry()];
    expect(heroLineForReferrer(referer, index)).toBeNull();
  });

  test('an empty index returns null for any referrer', () => {
    expect(heroLineForReferrer('https://example.test/x', [])).toBeNull();
  });
});
