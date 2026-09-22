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
   * `audience` IS REQUIRED, and it used to be optional. A fit run was
   * observable from two places: the MCP Worker, which resolved the grant and
   * knew the audience, and the site Worker, which saw only a 303 go past and
   * could not resolve the token without becoming a second verifier. The site
   * omitted the field rather than filling it, and the operator recovered the
   * audience from the `gated-read` event queued for the same run.
   *
   * #269 removed the second observer. The run is queued by the Worker that
   * closes the row, which is the one that resolved the grant, so there is no
   * longer a producer that cannot answer. A `fit-run` event without an
   * audience is now a bug rather than a known gap.
   *
   * WHAT THE OPTIONAL FIELD TAUGHT is kept, because it applies to the next
   * field somebody is tempted to leave out. A placeholder was tried
   * (`audience: 'unavailable-at-site'`) and is worse than an absent key:
   * `detail` renders straight into a notification email as `key=value`, so a
   * non-label sits in the one field that otherwise always holds a real one.
   * An `undefined` value is worse still, because it is present to
   * `Object.entries` and ships as `audience=undefined`.
   *
   * `outcome` joins it for a reason of the same kind. The event is queued from
   * both branches of the run, and a `fit-run` line that does not say which one
   * reads as success for both.
   */
  | {
      kind: 'fit-run';
      at: string;
      audience: string;
      reportId: string;
      outcome: 'ok' | 'failed';
    }
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
        detail: { audience: input.audience, report: input.reportId, outcome: input.outcome },
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
