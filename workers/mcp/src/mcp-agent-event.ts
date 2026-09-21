import { classifyRequest, signalsFrom } from '../../../src/lib/agent-intel/classify';
import type { AgentEvent } from '../../../src/lib/agent-intel/record';

// THE ONE PLACE THIS WORKER WOULD READ CAMPAIGN DOMAINS, and does not, for the
// identical reason src/worker.ts's own `CAMPAIGN_DOMAINS_OFF` does not: they
// live in KV, and this route has no more cause to pay a KV read per request
// than the site has to pay one per request. `classifyRequest`'s campaign label
// is therefore unavailable here; the referrer still classifies as `social` or
// `search` where it applies. The same constant, with the same comment, sits in
// ./chat.ts for the chat route.
const CAMPAIGN_DOMAINS_OFF: readonly string[] = [];

/**
 * The AE event for a request that reached `/mcp` on this Worker directly.
 * EXTRACTED for the reason ./chat.ts extracts chatAgentEvent: `surface` is
 * always the literal `'mcp'`, and this signature does not accept another.
 */
export function mcpAgentEvent(request: Request, status: number, durationMs: number): AgentEvent {
  return {
    classification: classifyRequest(signalsFrom(request), CAMPAIGN_DOMAINS_OFF),
    surface: 'mcp',
    status,
    durationMs,
  };
}
