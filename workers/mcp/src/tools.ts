import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { RESUME_SOURCE } from '../../../src/lib/corpus';
import {
  fetchDocument,
  fetchResumeJson,
  pageUrlFor,
  parseFrontmatter,
  type DocumentsEnv,
} from '../../../src/lib/mcp/documents';
import type { McpEnv } from './env';
import { defineTool, ToolError, type ToolContext } from './server';

/**
 * The published documents, as this Worker reads them.
 *
 * Assembled explicitly for the same reason `corpusEnv` is in ./index.ts, whose
 * doc comment is the long version: `SITE` is not a binding this Worker
 * declares, the documents are read over the public origin rather than from a
 * second copy of the site's assets, and global `fetch` is wrapped in an arrow
 * rather than passed as a bare reference.
 */
function documentsEnv(env: McpEnv): DocumentsEnv {
  return {
    SITE: { fetch: (input, init) => fetch(input, init) },
    SITE_ORIGIN: env.SITE_ORIGIN,
  };
}

const RESUME_FORMAT = z.object({
  format: z
    .enum(['json', 'markdown', 'summary'])
    .default('json')
    .describe(
      'json = JSON Resume schema; markdown = the published document; summary = a short prose read.',
    ),
});

/** A non-empty string, or nothing. Every field the summary reads is optional in JSON Resume. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * One `work` entry as `role — company (range)`, or nothing when the entry does
 * not name both. An entry missing either is skipped rather than filled in with
 * a placeholder: a line reading "Role not stated" is a claim the résumé never
 * made.
 */
function roleLine(entry: Record<string, unknown>): string | undefined {
  const position = text(entry.position);
  // JSON Resume v1 names the employer `name`, not `company`.
  const company = text(entry.name);
  if (position === undefined || company === undefined) return undefined;

  const start = text(entry.startDate);
  // An absent `endDate` is how JSON Resume says "current", and "Present" is the
  // word the published résumé itself uses for it.
  const range = start === undefined ? '' : ` (${start} – ${text(entry.endDate) ?? 'Present'})`;
  return `${position} — ${company}${range}`;
}

/** How many `work` entries the summary names. `work` is published most-recent-first. */
const SUMMARY_ROLES = 3;

/**
 * A short prose read of the résumé, built from the same JSON `format=json`
 * returns so the two cannot contradict each other.
 *
 * The entries are taken in published order rather than re-sorted by date:
 * `/resume.json` publishes `work` most-recent-first, and a second ordering
 * computed here could disagree with the markdown a caller gets from
 * `format=markdown`.
 *
 * The citation prefers the résumé's own `basics.url` over `SITE_ORIGIN`, and
 * the difference matters: `SITE_ORIGIN` is the origin these documents were
 * FETCHED from, which under the test harness or a preview deploy is not an
 * address to send a reader to. `basics.url` is what the document publishes
 * about itself, so the summary cites the same source everything else in it
 * came from. `SITE_ORIGIN` is the fallback for a résumé that publishes no URL.
 */
function summaryOf(resume: unknown, origin: string): string {
  // Read defensively rather than parsed into a type: `format=json` hands this
  // same object back verbatim, so nothing here may narrow what the document is
  // allowed to contain.
  const json = (resume ?? {}) as { basics?: unknown; work?: unknown };
  const basics = (json.basics ?? {}) as Record<string, unknown>;
  const work = Array.isArray(json.work) ? (json.work as Record<string, unknown>[]) : [];

  const paragraphs: string[] = [];
  const label = text(basics.label);
  if (label !== undefined) paragraphs.push(label);
  const summary = text(basics.summary);
  if (summary !== undefined) paragraphs.push(summary);

  const roles = work
    .slice(0, SUMMARY_ROLES)
    .map(roleLine)
    .filter((line): line is string => line !== undefined);
  if (roles.length > 0) paragraphs.push(`Recent roles:\n${roles.join('\n')}`);

  paragraphs.push(`Full résumé: ${pageUrlFor(RESUME_SOURCE, text(basics.url) ?? origin)}`);
  return paragraphs.join('\n\n');
}

/**
 * What a caller is told when the résumé cannot be read.
 *
 * A `ToolError`, so `defineTool` shows this sentence rather than the generic
 * "the error was logged" -- the caller asked for a document and the honest
 * answer is that it is not there, not that something broke inside.
 */
const RESUME_UNAVAILABLE = 'The résumé could not be read from the site right now.';

/**
 * Every tool this server exposes beyond the one `createServer` registers
 * itself, through `defineTool` and nothing else (03 §3).
 *
 * One function rather than one per tool: adding a tool is a `defineTool(...)`
 * call appended here, and there is no second place to remember. Registering
 * one any other way skips the audit trail and the limiter, which is why
 * `defineTool` is the only registration path in this Worker.
 */
export function registerTools(server: McpServer, tc: ToolContext): void {
  defineTool<z.infer<typeof RESUME_FORMAT>>(
    server,
    tc,
    {
      name: 'get_resume',
      title: 'Résumé',
      description:
        "Ryan Lindsey's résumé: JSON Resume data, the published markdown document, or a short prose summary.",
      cost: 'cheap',
      inputSchema: RESUME_FORMAT,
      // NO `outputSchema`, and this is a measurement rather than an omission.
      // 04's step 3 asks for `structuredContent` on `format=json`, and
      // `defineTool` emits that only for a tool that declares an
      // `outputSchema`. But @modelcontextprotocol/server 2.0.0 then requires
      // structured content on EVERY non-error result of the tool
      // (`validateToolOutput`, dist/mcp-DXXb3Vv3.mjs:1439) and validates it
      // against that schema -- and this tool's other two formats answer with a
      // string. Declaring one was tried and measured; `format=markdown` came
      // back as:
      //   "Output validation error: Invalid structured content for tool
      //    get_resume: Invalid input: expected object, received string"
      // The ways out are all worse: an object schema loose enough to admit a
      // string does not exist for a `z.ZodObject`, and wrapping the résumé in
      // an envelope so every format is an object would mean `format=json` no
      // longer answers with JSON Resume verbatim, which 02 §1 forbids. So the
      // JSON format's object goes out as the `content` text -- valid JSON a
      // client parses -- and the tool advertises no output schema at all.
    },
    async ({ format }, { env }) => {
      const documents = documentsEnv(env);

      if (format === 'markdown') {
        const markdown = await fetchDocument(documents, RESUME_SOURCE);
        if (markdown === null) throw new ToolError(RESUME_UNAVAILABLE);
        // Frontmatter is the export format's own envelope, not part of the
        // document a reader was served.
        return parseFrontmatter(markdown).body;
      }

      const resume = await fetchResumeJson(documents);
      if (resume === null) throw new ToolError(RESUME_UNAVAILABLE);
      // `json` returns it UNRESHAPED (02 §1). `summary` is derived from the
      // same object rather than from a second fetch of the markdown.
      return format === 'summary' ? summaryOf(resume, env.SITE_ORIGIN) : resume;
    },
  );
}
