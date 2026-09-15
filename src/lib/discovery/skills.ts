import readingTheCorpus from './skills/reading-the-corpus.md?raw';
import queryingMcp from './skills/querying-mcp.md?raw';

export interface PublishedSkill {
  name: string;
  description: string;
  source: string;
}

/**
 * The skills this site publishes, and the markdown each one serves.
 *
 * `?raw` rather than a filesystem read, so the bytes in `source` are the exact
 * bytes the SKILL.md route serves and the digest in the index cannot describe a
 * different document than the one a client fetches. A hand-pasted digest goes
 * stale on the first edit and nothing catches it, because the index still
 * parses -- which is why there is no second copy to paste from.
 *
 * TWO SKILLS, both about using this site: reading the published corpus, and
 * calling the MCP server. NOT the authoring skills under `.claude/skills/`,
 * which are tools for working ON this repository and mean nothing to a
 * visiting agent -- they are never imported here.
 *
 * NO fit-analysis skill, however natural it looks next to these two. `/fit`
 * is unlisted by requirement (see src/lib/discovery/surface.ts's own
 * comment), and a published skill explaining how to reach it would defeat
 * that as surely as a catalog entry would.
 * tests/discovery-skills.test.ts's "no skill mentions an unlisted route" is
 * the guard.
 */
export const PUBLISHED_SKILLS = [
  {
    name: 'reading-the-corpus',
    description:
      'Read this site as machine-readable documents. Use when you need the published writing, case studies or resume as markdown or JSON rather than HTML.',
    source: readingTheCorpus,
  },
  {
    name: 'querying-mcp',
    description:
      "Call this site's Model Context Protocol server. Use when you want structured tool access to the corpus rather than fetching pages.",
    source: queryingMcp,
  },
] as const satisfies readonly PublishedSkill[];

/** Web Crypto rather than node:crypto: this runs in the Workers runtime too. */
export async function digestFor(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export interface SkillIndexEntry {
  name: string;
  type: 'skill-md';
  description: string;
  url: string;
  digest: string;
}

export interface SkillsIndex {
  $schema: string;
  skills: SkillIndexEntry[];
}

/**
 * `/.well-known/agent-skills/index.json`, the Agent Skills Discovery RFC
 * v0.2.0 index (https://github.com/cloudflare/agent-skills-discovery-rfc).
 *
 * Each entry's `digest` is computed HERE, over the same `source` string the
 * `[skill]/SKILL.md` route serves (see that route's own comment) -- never
 * typed by hand. That is the whole reason this function exists rather than a
 * static JSON file: a static file cannot fail the day someone edits a
 * SKILL.md and forgets to re-hash it, and this function cannot succeed
 * without hashing the current bytes.
 *
 * `origin` IS ACCEPTED BUT NOT EMBEDDED IN ANY FIELD BELOW, and that is
 * deliberate rather than an oversight: every entry's `url` is site-relative,
 * because the RFC resolves it per RFC 3986 §5 against the index document's
 * own URL, and a relative path is what stays correct read from either origin
 * this site answers on -- unlike server-card.ts, api-catalog.ts and ard.ts,
 * nothing here needs to know which one served this particular copy. The
 * parameter stays in the signature anyway, for the same reason every other
 * builder in this directory takes one (see src/lib/mcp/discovery.ts's own
 * header): so this function's call sites all pass an origin the same way,
 * and none of them is tempted to read `request.url` instead, which reads as
 * a loopback address under `createTestHarness`.
 */
export async function buildSkillsIndex(origin: string): Promise<SkillsIndex> {
  const skills = await Promise.all(
    PUBLISHED_SKILLS.map(async (skill) => ({
      name: skill.name,
      type: 'skill-md' as const,
      description: skill.description,
      url: `/.well-known/agent-skills/${skill.name}/SKILL.md`,
      digest: await digestFor(skill.source),
    })),
  );
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills,
  };
}
