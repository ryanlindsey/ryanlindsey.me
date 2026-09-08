import { corpusSources, type CorpusSource, type CorpusType } from '../corpus';

// Task 3 (Day 4 §3): the published-document access layer every content tool
// reads through. The MCP Worker has no copy of the site's assets and must not
// grow one -- it fetches the same live published documents over
// `SITE_ORIGIN` that the day-3 corpus job already reads (src/lib/corpus.ts),
// so the corpus and the tools can never disagree about what is published.
// `astro:content` is an Astro-only virtual module and does not resolve inside
// a Worker bundle, which is also why this reads over HTTP rather than through
// `getCollection` -- the same wall src/lib/corpus.ts hit first.

/**
 * The bindings this module needs, narrower than `McpEnv`
 * (workers/mcp/src/env.ts).
 *
 * `Pick<Fetcher, 'fetch'>`, not `Fetcher`, for the same reason
 * `CorpusEnv.SITE` is typed that way: this module only ever calls `.fetch`,
 * so the narrower type is satisfied by an asset binding, a service binding,
 * or a thin wrapper over global `fetch` alike.
 *
 * WHAT THE DEPLOYED WORKER PASSES IS A SERVICE BINDING to `ryanlindsey-me`, and
 * this doc used to prescribe the other thing -- as a line a caller was invited
 * to copy:
 *
 *   SITE: { fetch: (input, init) => fetch(input, init) }   // DO NOT REVIVE
 *
 * That wrapper is what issue #28 was: a global `fetch` at `SITE_ORIGIN` returns
 * 522 when the request being served arrived on that same hostname, which is
 * exactly what `ryanlindsey.me/mcp` does. It is quoted rather than deleted so
 * the next reader recognises it on sight, but it is no longer the instruction:
 * `documentsEnv` (workers/mcp/src/tools.ts) is the one shape to copy. The narrow
 * type is still deliberate and still correct -- it is what let the transport
 * change three times without a line of this module moving.
 *
 * NOTE WHAT `SITE_ORIGIN` MEANS HERE NOW. It is no longer where the bytes come
 * from; a service binding ignores the hostname and reads only the path. It is
 * the address documents are CITED at (`pageUrlFor`, `summarize` below), so a
 * wrong value produces correct content under wrong URLs rather than a failure.
 */
export interface DocumentsEnv {
  SITE: Pick<Fetcher, 'fetch'>;
  SITE_ORIGIN: string;
}

/** A document's shape as a content tool answers it: enough to identify, link to and preview it. */
export interface DocumentSummary {
  type: CorpusType;
  slug: string;
  title: string;
  description: string;
  url: string;
  markdownUrl: string;
}

/**
 * The page a document is published at -- the URL a tool should hand back to
 * a caller, as opposed to `markdownUrl`, the `.md` asset the text is read
 * from.
 *
 * Posts and case studies get the trailing-slash form (`/writing/<slug>/`),
 * matching `canonicalUrlFor` in src/lib/markdown-export.ts and the pathname
 * Astro's directory-format build actually serves. `/resume` has no trailing
 * slash: that is what `/llms.txt` publishes, and `canonicalUrlFor` has no
 * résumé case to match against -- the résumé is not in that collection.
 */
const SECTION_FOR_TYPE: Record<Exclude<CorpusType, 'resume'>, string> = {
  post: 'writing',
  'case-study': 'work',
};

export function pageUrlFor(source: CorpusSource, origin: string): string {
  if (source.type === 'resume') return `${origin}/resume`;
  const section = SECTION_FOR_TYPE[source.type];
  return new URL(`/${section}/${source.slug}/`, origin).href;
}

/** A line matching the closing (or opening) `---` fence, and nothing else on the line. */
const FRONTMATTER_FENCE = /^---\s*$/;

/**
 * One item of the block list `frontmatterYaml` emits for `outcomes`: exactly
 * two spaces, a `- `, then the (quoted, per `yamlString`) item text. Nothing
 * looser -- a different indent or a bare `-` with no following space is not
 * this shape and falls through to the nested-map skip below, same as before.
 */
const BLOCK_LIST_ITEM = /^ {2}- (.*)$/;

/**
 * A small hand-rolled splitter for the frontmatter `frontmatterFor`
 * (src/lib/markdown-export.ts) emits -- not a YAML parser. This plan adds no
 * new dependencies, and the frontmatter this reads is written by code in
 * this same repo, so its grammar is known and closed: a leading `---`
 * fence, scalar `key: value` pairs (optionally double-quoted, per
 * `yamlString`), a closing `---` fence, and the two nested shapes a bare
 * `key:` can introduce, because `frontmatterYaml` emits exactly two of them:
 *
 * - A BLOCK LIST (Task 7's `outcomes:`, one `  - "item"` line per array
 *   entry, per `BLOCK_LIST_ITEM` above). Read into a real string array, each
 *   item unquoted through the same `unquote` path a scalar value uses.
 * - A NESTED MAP (`series:` with `  name: ...` / `  order: ...` children).
 *   There is no reader for this shape here -- it is skipped, key and every
 *   more-indented line under it, exactly like anything else this function
 *   does not recognise.
 *
 * A document with no frontmatter block at all is returned whole as `body`
 * with an empty `data`.
 *
 * The chunker that produced the corpus vectors ran over the WHOLE asset,
 * frontmatter included, so `body` is exactly the input with the frontmatter
 * lines removed -- never re-trimmed, re-joined, or otherwise reconstructed
 * -- or a body-only excerpt would stop lining up with the embedded chunk.
 */
export function parseFrontmatter(markdown: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const lines = markdown.split('\n');

  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0] ?? '')) {
    return { data: {}, body: markdown };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_FENCE.test(lines[i] ?? '')) {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    return { data: {}, body: markdown };
  }

  const data: Record<string, unknown> = {};
  let i = 1;
  while (i < closingIndex) {
    const line = lines[i] ?? '';
    i++;
    const match = /^([A-Za-z0-9_]+):(?:\s(.*))?$/.exec(line);
    if (!match) continue; // Not a scalar `key: value` line -- ignored, not guessed at.
    const [, key = '', rawValue = ''] = match;
    const value = rawValue.trim();
    if (value === '') {
      // A bare `key:` with nothing after it on the line introduces one of the
      // two nested shapes described above. Try the block-list reading first:
      // if what follows is one or more `BLOCK_LIST_ITEM` lines, this key is
      // an array and each item is unquoted the same way a scalar value is.
      const items: unknown[] = [];
      while (i < closingIndex) {
        const listItem = BLOCK_LIST_ITEM.exec(lines[i] ?? '');
        if (!listItem) break;
        items.push(unquote(listItem[1] ?? ''));
        i++;
      }
      if (items.length > 0) {
        data[key] = items;
        continue;
      }
      // Not a block list -- a nested map (`series:` / `name:` / `order:`) or
      // anything else this function does not recognise. Skip the key and
      // every more-indented line that belongs to it, rather than misreading
      // the first child line as this key's scalar value.
      while (i < closingIndex && /^\s+\S/.test(lines[i] ?? '')) i++;
      continue;
    }
    data[key] = unquote(value);
  }

  // `toMarkdown` (src/lib/markdown-export.ts) always separates the closing
  // fence from the body with exactly one blank line
  // (`---\n${frontmatterYaml}\n---\n\n${body}\n`); that blank line is part of
  // the frontmatter block's own grammar, not the body, so it is dropped here
  // rather than left for every caller to trim itself.
  const bodyStart = lines[closingIndex + 1] === '' ? closingIndex + 2 : closingIndex + 1;
  const body = lines.slice(bodyStart).join('\n');
  return { data, body };
}

/** What each of `yamlString`'s four escape sequences decodes back to. */
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { n: '\n', r: '\r', '"': '"', '\\': '\\' };

/**
 * Strips one layer of matching surrounding quotes (`"..."` or `'...'`),
 * unescaping `yamlString`'s double-quoted form.
 *
 * The double-quoted branch MUST be one coordinated pass over `\X` pairs, not
 * four independent, sequential `.replace()` calls -- `yamlString` escapes
 * `\` FIRST, then `"`, `\r`, `\n`, so a plaintext value containing a literal
 * backslash immediately followed by `n`, `r` or `"` encodes that backslash
 * doubled, right before a character a later independent pass also matches
 * on. A sequential decode re-matches the leftover half of that doubled
 * backslash as a fresh escape (e.g. the encoded `\\n` for plaintext `\n`
 * gets its SECOND backslash consumed by an `\n`-decoding pass, producing a
 * real newline and stranding the first backslash) and silently corrupts the
 * value instead of decoding it. Consuming both characters of every `\X`
 * pair in a single left-to-right scan is what makes that impossible: each
 * backslash can only ever start (or be swallowed by) one substitution.
 */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(
        /\\(.)/g,
        (whole: string, escaped: string) => DOUBLE_QUOTE_ESCAPES[escaped] ?? whole,
      );
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** Optional metadata a case study may declare (03 §2). Copied only when present. */
const OPTIONAL_KEYS = ['orgScale', 'domain', 'outcomes'] as const;

export function summarize(source: CorpusSource, markdown: string, origin: string): DocumentSummary {
  const { data } = parseFrontmatter(markdown);

  const summary: DocumentSummary = {
    type: source.type,
    slug: source.slug,
    title: typeof data.title === 'string' ? data.title : source.slug,
    description: typeof data.description === 'string' ? data.description : '',
    url: pageUrlFor(source, origin),
    markdownUrl: new URL(source.path, origin).href,
  };

  // ASSIGNED ONLY WHEN PRESENT, never `= undefined`. JSON.stringify drops an
  // undefined value but `Object.values()` does not, and the tool contract in
  // Task 7 is that an undeclared field is ABSENT rather than null -- a null
  // reads as "this case study has no outcomes", which is a claim nobody made.
  for (const key of OPTIONAL_KEYS) {
    if (data[key] !== undefined) (summary as unknown as Record<string, unknown>)[key] = data[key];
  }

  return summary;
}

async function fetchAsset(env: DocumentsEnv, path: string): Promise<Response> {
  return await env.SITE.fetch(new URL(path, env.SITE_ORIGIN));
}

/**
 * The résumé plus every document `/llms.txt` links, in the order
 * `corpusSources` returns them.
 *
 * Reuses `corpusSources` rather than parsing `/llms.txt` a second time here:
 * that function already prepends `RESUME_SOURCE`, filters to `/writing/*.md`
 * and `/work/*.md`, de-duplicates, and inherits the draft filter from
 * `/llms.txt` itself (a document `/llms.txt` does not link is a document
 * this function cannot see, exactly as intended). A second parser would be a
 * second place to forget that filter.
 *
 * A missing `/llms.txt` throws rather than resolving to `[RESUME_SOURCE]` or
 * `[]`: no index means the site is broken or `SITE_ORIGIN` points at the
 * wrong host, and answering "there are no documents" in that case would be a
 * confident lie rather than an honest failure.
 */
export async function fetchDocumentIndex(env: DocumentsEnv): Promise<CorpusSource[]> {
  const response = await fetchAsset(env, '/llms.txt');
  if (!response.ok) {
    throw new Error(`mcp/documents: /llms.txt returned ${response.status} from ${env.SITE_ORIGIN}`);
  }
  return corpusSources(await response.text());
}

/**
 * One document's markdown, or `null` if it is not published.
 *
 * `null`, not a throw: unlike a missing `/llms.txt`, a 404 for one document
 * is an ordinary, answerable outcome -- a caller asked for a slug that is
 * not (or no longer) published, and a content tool should be able to say so
 * rather than fail the whole request.
 */
export async function fetchDocument(
  env: DocumentsEnv,
  source: CorpusSource,
): Promise<string | null> {
  const response = await fetchAsset(env, source.path);
  if (!response.ok) return null;
  return await response.text();
}

/**
 * `/resume.json`, JSON Resume verbatim, or `null` if it is not published.
 * Same missing-document reasoning as `fetchDocument`: this is one more
 * asset read over `SITE_ORIGIN`, not the document index.
 */
export async function fetchResumeJson(env: DocumentsEnv): Promise<unknown | null> {
  const response = await fetchAsset(env, '/resume.json');
  if (!response.ok) return null;
  return await response.json();
}
