import { resolveGrant } from '../../../src/lib/tier/grant';
import { readCampaignForAudience } from '../../../src/lib/tier/campaigns';
import { grantedToolNames } from './gated';
import type { McpEnv } from './env';

/**
 * What one bearer unlocks, for the site (04 §2).
 *
 * WHY THIS EXISTS RATHER THAN THE SITE READING KV ITSELF. `/fit` preloads the
 * target description a campaign configures, and which campaign that is depends
 * on the grant -- so answering it means knowing the audience, which means
 * verifying the token. The site deliberately cannot do that (src/lib/fit/client.ts),
 * and giving it a second verifier is the thing `resolveGrant` exists to prevent.
 * So the Worker that already resolves the grant answers the whole question in
 * one call, and the site stays a consumer of the boundary rather than a second
 * implementation of it.
 *
 * WHAT IT REPLACED. The site used to call `activeCampaign()`, which returns
 * whichever entry is `active` with no reference to the caller. Two active
 * campaigns meant the first one KV listed won for everybody -- so a holder of
 * one campaign's token opened `/fit` and found another campaign's text in the
 * form. That is why only one campaign could run at a time, and it is the
 * defect this endpoint closes.
 *
 * PUBLIC, and gated exactly like every other private-tier surface. It is
 * reachable at https://mcp.ryanlindsey.me/grant, answers a bare 404 to anything
 * without a live grant, and discloses to a holder only what that token already
 * unlocks.
 */
export interface GrantContext {
  tools: string[];
  audience: string;
  /** Epoch seconds, straight off the signed claim. */
  expiresAt: number;
  /** The campaign's configured target description, or '' when there is none. */
  preload: string;
}

/**
 * A BARE 404 -- no body, no headers -- for every refusal, which is what an
 * unrouted path on this Worker returns. A refusal that differed observably in
 * body, content type or a header nothing else sets would be a route-existence
 * oracle, and this endpoint names an audience when it succeeds.
 */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

export async function handleGrantContext(request: Request, env: McpEnv): Promise<Response> {
  if (request.method !== 'POST') return notFound();

  const { grant } = await resolveGrant(env, request, Math.floor(Date.now() / 1000));
  if (grant === null) return notFound();

  // Matched on `token_audience`, exactly as `get_application_narrative` does
  // (./gated.ts). Not on `id`: 00 §5 lists them as separate fields and they are
  // allowed to differ.
  const campaign = await readCampaignForAudience(env, grant.audience);

  const body: GrantContext = {
    tools: grantedToolNames(grant),
    audience: grant.audience,
    expiresAt: grant.expiresAt,
    preload: campaign?.jdText ?? '',
  };
  return Response.json(body);
}
