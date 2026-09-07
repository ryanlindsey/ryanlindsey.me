import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/server';
import {
  fetchDocument,
  fetchDocumentIndex,
  fetchResumeJson,
  parseFrontmatter,
} from '../../../src/lib/mcp/documents';
import { defineResource, type ToolContext } from './define';
import { documentsEnv, RESUME_UNAVAILABLE } from './tools';

// 03 §2's MCP resources, for clients that prefer resource attachment over tool
// calls. They serve exactly the documents the tools serve, read the same way
// (over `SITE_ORIGIN`, through Task 3's layer), and they are registered through
// `defineResource` and nothing else -- read its doc comment for why that is the
// resource half of the "one registration path" rule rather than an exception to
// it.
//
// What is NOT guarded, deliberately: discovery. `resources/list` and
// `resources/templates/list` go through no limiter and write no audit row.
// That is an accepted trade, and it is worth stating precisely rather than by
// analogy, because the obvious analogy is wrong.
//
// `tools/list` is free in a way this is NOT. It enumerates an in-memory
// registry and does no I/O at all. The writing template's `list` callback
// below makes a live `fetchDocumentIndex` call -- the same `/llms.txt` fetch
// `list_writing` makes behind a 60/60s limiter -- so an unthrottled
// `resources/list` is a second, unmetered path to that backend cost. What
// keeps it small is that the cost is 1:1 rather than amplifying: one listing,
// one fetch, no per-document fan-out (see the `list` callback's own note), of
// a small static asset the site serves to anonymous GETs anyway.
//
// It is still not limited, because throttling it fails worse than it helps.
// Clients call discovery on connect and again on every reconnect, so a refused
// `resources/list` refuses the connection rather than one read -- and a client
// that cannot list cannot find the resource it would then have been allowed to
// read. The option that removes the cost instead of refusing the caller is
// caching the index (`KV_CACHE` is bound on this Worker); that was considered
// and deliberately not taken here, and it belongs with day 5/6's work on this
// surface rather than to Task 11. Reads are limited; the menu is not.

/**
 * The published index, with a message a stranger's agent can be shown.
 *
 * `fetchDocumentIndex` throws when `/llms.txt` will not read, and its message
 * names the status and the origin it tried. The reason this wrapper exists is
 * the LISTING, which does not go through `defineResource` at all: the SDK
 * calls a template's `list` callback straight from its own request handler,
 * where a throw is copied onto the wire verbatim. The read path is sanitised
 * by `defineResource` regardless, and calls this for the better sentence.
 *
 * It re-raises rather than answering `[]`, for the reason `fetchDocumentIndex`
 * itself gives: "there are no documents" would be a confident lie about a
 * broken deploy.
 */
async function publishedIndex(tc: ToolContext) {
  try {
    return await fetchDocumentIndex(documentsEnv(tc.env));
  } catch (error) {
    console.error('mcp/resource: the published index could not be read', error);
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      'The published index could not be read right now.',
    );
  }
}

/** The resource URI one published post is served at. */
function writingUri(slug: string): string {
  return `writing://${slug}`;
}

/**
 * Both resources, through `defineResource` and nothing else -- the shape
 * `registerTools` has, for the same reason: adding one is a call appended
 * here, and there is no second place to remember.
 */
export function registerResources(server: McpServer, tc: ToolContext): void {
  defineResource(
    server,
    tc,
    {
      name: 'resume',
      title: 'Résumé (JSON Resume)',
      description: "Ryan Lindsey's résumé as JSON Resume, exactly as it is published.",
      mimeType: 'application/json',
      // A document read, no inference -- the same bucket every content tool
      // draws from (src/lib/mcp/limits.ts).
      cost: 'cheap',
      uri: 'resume://json',
    },
    async (uri, _variables, tc) => {
      const resume = await fetchResumeJson(documentsEnv(tc.env));
      // Not there is an ordinary, answerable outcome for a resource: say so at
      // the URI that was asked for rather than reporting an internal failure.
      if (resume === null) throw new ResourceNotFoundError(uri.href, RESUME_UNAVAILABLE);
      // VERBATIM (02 §1): the parsed document, re-serialised and not reshaped.
      // No envelope, no added fields -- `get_resume`'s `format=json` answers
      // with the same object, and the two must not be able to disagree.
      return JSON.stringify(resume, null, 2);
    },
  );

  defineResource(
    server,
    tc,
    {
      name: 'writing',
      title: 'Writing',
      description: 'The full markdown of one published post, by slug.',
      mimeType: 'text/markdown',
      cost: 'cheap',
      // The template and the URIs its `list` emits are built from the same
      // function, so the two cannot drift into disagreeing about the shape.
      uri: new ResourceTemplate(writingUri('{slug}'), {
        /**
         * PUBLISHED SLUGS ONLY, and by construction rather than by a filter of
         * its own: `/llms.txt` is the published index and already excludes
         * drafts, so a document this callback cannot see is a document this
         * template cannot serve. A second filter here would be a second place
         * to forget one.
         *
         * Each entry carries its URI and its slug and nothing more. The SDK
         * spreads the template's own `title`/`description`/`mimeType` over
         * every listed resource, so the alternative -- a real title and
         * description per post -- would mean one `.md` fetch PER DOCUMENT on
         * every `resources/list`. This callback is not rate limited (see the
         * note at the top of this file), and the whole basis of that trade is
         * that its cost stays 1:1 with the call -- one `/llms.txt` fetch --
         * rather than growing with the corpus. `list_writing` is the tool for
         * per-document metadata, and it is limited.
         */
        list: async () => {
          const index = await publishedIndex(tc);
          return {
            resources: index
              .filter((source) => source.type === 'post')
              .map((source) => ({ uri: writingUri(source.slug), name: source.slug })),
          };
        },
      }),
    },
    async (uri, variables, tc) => {
      // A `Variables` value is `string | string[]` because a URI template can
      // expand a list. `{slug}` is a simple expansion and matches one segment,
      // so anything else is not a slug this template serves -- answered as the
      // miss it is rather than flattened into a string that would then miss
      // anyway, with a worse story about why.
      const slug = variables.slug;
      if (typeof slug !== 'string') throw new ResourceNotFoundError(uri.href);

      const index = await publishedIndex(tc);
      const source = index.find((s) => s.type === 'post' && s.slug === slug);
      // A slug that is not in the index is not published -- including one that
      // names a case study, which is served by `get_case_study` and has no
      // resource URI of its own.
      if (source === undefined) throw new ResourceNotFoundError(uri.href);

      const markdown = await fetchDocument(documentsEnv(tc.env), source);
      if (markdown === null) {
        throw new ResourceNotFoundError(uri.href, `"${slug}" is indexed but did not fetch.`);
      }
      // Frontmatter is the export format's own envelope, not part of the
      // document a reader was served -- `get_post` strips it for the same reason.
      return parseFrontmatter(markdown).body;
    },
  );

  // policy://ai is 03 §2's third resource and is DEFERRED, by a locked
  // decision: /ai-policy is day 6's page and does not exist yet, and a
  // resource that resolves to a 404 is worse than an absent one. Day 6 adds it
  // here, next to these two:
  // defineResource(server, tc, { name: 'policy', uri: 'policy://ai', ... }, ...);
}
