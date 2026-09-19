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
 * reachable at https://mcp.ryanlindsey.me/grant, answers the same 404 as an
 * unrouted path to anything without a live grant (see `handleGrantContext`'s
 * own doc for why that is a fallthrough rather than a constructed response),
 * and discloses to a holder only what that token already unlocks.
 */
export interface GrantContext {
  tools: string[];
  audience: string;
  /** Epoch seconds, straight off the signed claim. */
  expiresAt: number;
  /** The campaign's configured target description, or '' when there is none. */
  preload: string;
  /**
   * The campaign's configured hero line, or '' when there is none or it is
   * not `active`.
   *
   * GATED HERE, NOT INSIDE `readCampaignForAudience`. That function returns
   * an entry of any `status` on purpose, which its own docblock states in one
   * sentence ("IT RETURNS AN ENTRY OF ANY `status`, BY DESIGN",
   * src/lib/tier/campaigns.ts) and `parseCampaign`'s docblock above
   * explains: the same call resolves `preload` and the gated narrative
   * document, and a filter inside it would take both of those out along with
   * the hero line. `preload`, declared just above, is deliberately NOT gated
   * on `status` -- it keeps its existing ungated behavior, and this field
   * must not change that. CORRECTED 2026-09-18: the citation here pointed at
   * `readCampaignForAudience`'s docblock for a `status` explanation it did
   * not contain, and the sentence quoted above was added there in the same
   * pass -- the function a caller opens is where its contract belongs.
   */
  heroLine: string;
}

/**
 * `null` for every refusal, which index.ts falls through to `createMcpHandler`
 * on -- so the refusal IS the genuine unrouted 404 that handler answers for
 * any path but `/mcp`, rather than a hand-built copy of it. A refusal that
 * differed observably in body, content type or a header nothing else sets
 * would be a route-existence oracle, and this endpoint names an audience when
 * it succeeds.
 *
 * CORRECTION, measured 2026-09-15. This function used to construct that 404
 * itself -- `new Response(null, { status: 404 })`, no headers -- on the claim
 * that this WAS what an unrouted path on this Worker returns. That claim was
 * false the whole time it was written: the real unrouted path falls through
 * to `createMcpHandler`, and agents@0.23.0's stateless `serve` answers it with
 * `withCors(new Response("Not Found", { status: 404 }), corsOptions)` --
 * `Not Found` as the body, `content-type: text/plain;charset=UTF-8`, and five
 * `access-control-*` headers from `corsOptions`. Measured directly against
 * this Worker: a hand-built refusal and a genuinely unrouted `POST /grantx`
 * disagreed on all three, which made `POST /grant` vs `POST /grantx` the exact
 * route-existence oracle the first paragraph above says a refusal must not be.
 * A literal copy of the real 404 was rejected as the fix for the reason the
 * original bug IS a copy that drifted: the next dependency bump to `agents`
 * can change `serve`'s 404 shape again, silently, and a hand-copied literal
 * has no way to notice. Falling through to the real handler cannot drift,
 * because there is nothing left to copy.
 */
export async function handleGrantContext(request: Request, env: McpEnv): Promise<Response | null> {
  if (request.method !== 'POST') return null;

  const { grant } = await resolveGrant(env, request, Math.floor(Date.now() / 1000));
  if (grant === null) return null;

  // Matched on `token_audience`, exactly as `get_application_narrative` does
  // (./gated.ts). Not on `id`: 00 §5 lists them as separate fields and they are
  // allowed to differ.
  const campaign = await readCampaignForAudience(env, grant.audience);

  const body: GrantContext = {
    tools: grantedToolNames(grant),
    audience: grant.audience,
    expiresAt: grant.expiresAt,
    preload: campaign?.jdText ?? '',
    heroLine: campaign?.status === 'active' ? campaign.heroLine : '',
  };
  return Response.json(body);
}
