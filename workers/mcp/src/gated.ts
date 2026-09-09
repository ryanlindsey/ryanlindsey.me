import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { readCampaignForAudience } from '../../../src/lib/tier/campaigns';
import {
  caseStudyDetailKey,
  narrativeKey,
  PROFILE_KEYS,
  readPrivateDoc,
} from '../../../src/lib/tier/private-docs';
import { defineTool, ToolError, type ToolContext } from './define';

// The private tier's tools (03 §2). Registered ONLY for a request whose grant
// carries the matching scope -- see ./server.ts. An unauthenticated caller's
// `McpServer` does not contain these tools, so `tools/list` cannot leak a name
// and `tools/call` answers the SDK's own unknown-tool error, which enumerates
// nothing.
//
// Every tool here is a document read. There is no query interface, no key
// parameter, and no listing: a general-purpose read primitive over the private
// bucket is exactly the shape the partition (src/lib/tier/private-docs.ts)
// exists to avoid handing to a caller, however well scoped their token is.
//
// Vocabulary (09 §2): these names and descriptions are code, and code is a
// public surface -- a granted caller can screenshot `tools/list`. They say
// audience, scope, private tier, engagement. What the DOCUMENTS say is runtime
// data and is not this file's business.

/** The sentence a caller sees when a document has not been deployed yet. */
const NOT_DEPLOYED = 'That document is not available on this tier yet.';

/**
 * One document tool. A local helper rather than five copies, and the shape is
 * the same every time: resolve a key, read it, hand back markdown.
 *
 * `scope: 'profile'` is fixed here rather than passed in, and deliberately so:
 * every caller of this helper is registered under the `profile` branch below,
 * and a helper that took the scope as an argument would let a future tool
 * declare one scope while being registered under another. That divergence is
 * precisely the mistake `defineTool`'s call-time check exists to catch, and
 * this is the cheaper place to make it impossible.
 */
function defineDocumentTool(
  server: McpServer,
  tc: ToolContext,
  spec: { name: string; title: string; description: string },
  key: string,
): void {
  defineTool(server, tc, { ...spec, cost: 'cheap', scope: 'profile' }, async (_args, tc) => {
    const text = await readPrivateDoc(tc.env, key);
    if (text === null) throw new ToolError(NOT_DEPLOYED);
    return text;
  });
}

const CASE_STUDY_INPUT = z.object({
  slug: z.string().describe('The slug of a published case study, as list_case_studies reports it.'),
});

/**
 * Every private-tier tool, registered against the scopes the grant carries.
 *
 * The scope is checked by the CALLER (./server.ts, via this function) for
 * registration and by `defineTool` again at call time. Two mechanisms on
 * purpose: 09 §3's "structural, not filtered" is a claim worth more than one
 * guarantee. `hasScope` is not imported here -- inside this function the grant
 * is already narrowed non-null, so `.includes` is the whole of the question,
 * and `hasScope`'s null handling belongs to the call-time check that has to
 * cope with a grant it did not narrow.
 */
export function registerGatedTools(server: McpServer, tc: ToolContext): void {
  const grant = tc.grant;
  if (grant === null) return;

  if (grant.scopes.includes('profile')) {
    defineDocumentTool(
      server,
      tc,
      {
        name: 'get_availability',
        title: 'Availability',
        description: "Ryan's current working status and engagement timing.",
      },
      PROFILE_KEYS.availability,
    );
    defineDocumentTool(
      server,
      tc,
      {
        name: 'get_references',
        title: 'References',
        description: 'Reference contacts and the context for each.',
      },
      PROFILE_KEYS.references,
    );
    defineDocumentTool(
      server,
      tc,
      {
        name: 'get_compensation_expectations',
        title: 'Compensation expectations',
        description: 'Compensation range and structure preferences.',
      },
      PROFILE_KEYS.compensation,
    );
  }

  if (grant.scopes.includes('documents')) {
    defineTool<z.infer<typeof CASE_STUDY_INPUT>>(
      server,
      tc,
      {
        name: 'get_case_study_details',
        title: 'Case study, unredacted',
        description:
          'The unredacted layer of one case study: named metrics and organisational specifics the published version omits.',
        cost: 'cheap',
        scope: 'documents',
        inputSchema: CASE_STUDY_INPUT,
      },
      async ({ slug }, tc) => {
        const key = caseStudyDetailKey(slug);
        // A refused key and a missing document answer the SAME sentence, on
        // purpose: a caller probing slugs learns nothing about which ones
        // exist, and the honest answer to both is "not available here".
        // tests/mcp-gated.test.ts asserts the two sentences are IDENTICAL
        // rather than merely both errors -- the weaker assertion would pass
        // with `safeSegment` deleted, since R2 is a flat keyspace and a
        // traversal-shaped key is simply a key that is not there.
        if (key === null) throw new ToolError(NOT_DEPLOYED);
        const text = await readPrivateDoc(tc.env, key);
        if (text === null) throw new ToolError(NOT_DEPLOYED);
        return text;
      },
    );
  }

  if (grant.scopes.includes('narrative')) {
    defineTool(
      server,
      tc,
      {
        name: 'get_application_narrative',
        title: 'Audience narrative',
        description:
          "The narrative written for this token's audience: why this engagement, and a first-90-days sketch.",
        cost: 'cheap',
        scope: 'narrative',
      },
      async (_args, tc) => {
        // The audience comes from the SIGNED claim, so a caller cannot ask for
        // someone else's narrative by changing an argument -- there is no
        // argument. That is why this tool takes none.
        const audience = tc.grant!.audience;
        // Configuration first: 00 §5 gives a campaign an explicit
        // `gated_narrative_doc`, and honouring it means a document can be
        // renamed without re-minting tokens. The convention key is the
        // fallback, not the rule.
        const campaign = await readCampaignForAudience(tc.env, audience);
        const key = campaign?.gatedNarrativeDoc || narrativeKey(audience);
        if (!key) throw new ToolError(NOT_DEPLOYED);
        const text = await readPrivateDoc(tc.env, key);
        if (text === null) throw new ToolError(NOT_DEPLOYED);
        return text;
      },
    );
  }

  // `analyze_fit` (scope `fit`) is registered here by Task 11.
}
