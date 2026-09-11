import type { ReferrerClass } from './classify';

// Which events are worth waking the operator for (06 §3), decided in one pure
// function so the list is reviewable rather than scattered across the two
// Workers that produce them.
//
// WHAT A MESSAGE MAY CARRY: labels the operator needs to act, and nothing a
// caller typed. No pasted description, no chat question, no IP, no token. The
// queue is a fan-out to email, and an email is a copy of its contents that
// leaves Cloudflare permanently -- so this is the narrowest surface in the
// system and it is kept narrow by the `detail` maps below being written out
// field by field rather than spread from a caller's object.

export type HighIntentKind =
  | 'fit-run'
  | 'private-access'
  | 'gated-read'
  | 'resume-pdf-referred'
  | 'chat-session'
  | 'first-seen-client';

export interface IntentEvent {
  kind: HighIntentKind;
  /** ISO 8601, set by the producer. */
  at: string;
  /** Bounded labels only. Never caller-supplied prose. */
  detail: Record<string, string>;
}

export type IntentInput =
  /**
   * `audience` is OPTIONAL here and required on `gated-read` below, and the
   * asymmetry is the point rather than an oversight.
   *
   * A fit run is observable from two places. The MCP Worker resolves the grant
   * and knows the audience. The site Worker sees only a 303 to `/fit/r/<id>` go
   * past, and resolving the token itself would mean a second grant verifier --
   * the one thing `resolveGrant` exists to prevent there being two of.
   *
   * So the site omits the field rather than filling it. A placeholder was tried
   * (`audience: 'unavailable-at-site'`) and is worse: `detail` renders straight
   * into a notification email as `key=value`, so a non-label sits in the one
   * field that otherwise always holds a real one, one careless read away from
   * looking like an audience actually named that. An absent key reads as absent.
   * The audience arrives in the `gated-read` event the MCP Worker queues for the
   * same run.
   */
  | { kind: 'fit-run'; at: string; audience?: string; reportId: string }
  | { kind: 'private-access'; at: string; client: string }
  | { kind: 'gated-read'; at: string; tool: string; audience: string }
  | { kind: 'resume-pdf'; at: string; referrerClass: ReferrerClass }
  | { kind: 'chat'; at: string; firstOfSession: boolean }
  | { kind: 'first-seen-client'; at: string; client: string }
  | { kind: 'page'; at: string };

const KINDS: readonly string[] = [
  'fit-run',
  'private-access',
  'gated-read',
  'resume-pdf-referred',
  'chat-session',
  'first-seen-client',
];

/**
 * The event to queue, or `null` for everything that belongs in the counters
 * and nowhere else.
 *
 * The `resume-pdf` rule is the only one with a condition attached, and 06 §3
 * writes that condition itself: a PDF download matters "with a campaign
 * referrer-class". `social` is included alongside `campaign` because a
 * download arriving straight off a LinkedIn link is the same signal a week
 * before any campaign exists -- which is the state the site launches in
 * (00 §5) and the state it may stay in for a while.
 */
export function highIntentFor(input: IntentInput): IntentEvent | null {
  switch (input.kind) {
    case 'fit-run':
      return {
        kind: 'fit-run',
        at: input.at,
        // Spread-if-present rather than `audience: input.audience`, which would
        // put an `undefined` value in a `Record<string, string>` -- present to
        // `Object.entries`, and rendered into the email as `audience=undefined`.
        detail: {
          ...(input.audience === undefined ? {} : { audience: input.audience }),
          report: input.reportId,
        },
      };
    case 'private-access':
      return { kind: 'private-access', at: input.at, detail: { client: input.client } };
    case 'gated-read':
      return {
        kind: 'gated-read',
        at: input.at,
        detail: { tool: input.tool, audience: input.audience },
      };
    case 'resume-pdf':
      return input.referrerClass === 'campaign' || input.referrerClass === 'social'
        ? {
            kind: 'resume-pdf-referred',
            at: input.at,
            detail: { referrer: input.referrerClass },
          }
        : null;
    case 'chat':
      return input.firstOfSession ? { kind: 'chat-session', at: input.at, detail: {} } : null;
    case 'first-seen-client':
      return { kind: 'first-seen-client', at: input.at, detail: { client: input.client } };
    default:
      return null;
  }
}

/**
 * Whether a queue message body is one of ours.
 *
 * A queue is a boundary: what comes back out is whatever was in the store,
 * possibly written by an older deploy, possibly a message this build has never
 * heard of. Validating on the way out means an unknown shape is dropped with a
 * log line rather than formatted into an email as `[object Object]`.
 */
export function isIntentEvent(value: unknown): value is IntentEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.kind !== 'string' || !KINDS.includes(event.kind)) return false;
  if (typeof event.at !== 'string') return false;
  if (typeof event.detail !== 'object' || event.detail === null) return false;
  return Object.values(event.detail as Record<string, unknown>).every(
    (entry) => typeof entry === 'string',
  );
}
