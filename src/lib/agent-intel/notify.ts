import type { IntentEvent } from './intent';

// The private half of 06 §3: the operator's alert. Everything here runs in the
// queue consumer, off the request path, so latency is not a constraint and
// correctness of the message body is.
//
// NO `mimetext` DEPENDENCY, and the reason is proportion rather than
// minimalism. The `send_email` binding wants RFC 5322 bytes; what this sends is
// one plain-text part with six fixed headers and no attachments, no
// alternatives and no non-ASCII, which is thirty lines of string building with
// one real hazard (header injection) that a library would hide rather than
// remove. The hazard is handled below and tested directly. Revisit the day this
// needs HTML or an attachment.
//
// `EmailMessage` IS IMPORTED DYNAMICALLY, INSIDE THE SEND, and that is a
// requirement rather than a style choice. `cloudflare:email` is a runtime
// module: it resolves inside a Worker and nowhere else, so a top-level import
// of it makes this file unloadable by a plain vitest process -- which is the
// whole reason the pure rules in this repo live under src/lib in the first
// place. MEASURED: with the import at the top, tests/agent-notify.test.ts does
// not run at all ("Cannot find package 'cloudflare:email'"), and every
// assertion below it -- the header-injection refusal included -- is silently
// not executed. Deferring it to the one line that needs it keeps `buildNotification`,
// `buildMimeMessage` and all three skip paths testable, because none of them
// reaches the send.

export interface NotifyEnv {
  EMAIL: SendEmail;
  RLME_NOTIFY_ADDRESS: SecretsStoreSecret;
  RLME_NOTIFY_FROM: string;
  /**
   * Test-only seam, the same shape as `RLME_TURNSTILE_MODE`: no deployed
   * config declares it, `'stub'` skips the Secrets Store read and the send, and
   * an unrecognised value throws. It exists because the harness has neither a
   * populated local secrets store nor an Email Routing binding that can deliver.
   */
  RLME_NOTIFY_MODE?: string;
}

/** The order high-intent kinds are ranked in when naming a batch. */
const KIND_PRIORITY: readonly IntentEvent['kind'][] = [
  'fit-run',
  'private-access',
  'gated-read',
  'chat-session',
  'resume-pdf-referred',
  'first-seen-client',
];

export function buildNotification(events: readonly IntentEvent[]): {
  subject: string;
  body: string;
} {
  const lead =
    KIND_PRIORITY.find((kind) => events.some((event) => event.kind === kind)) ??
    events[0]?.kind ??
    'none';
  const noun = events.length === 1 ? 'event' : 'events';
  const lines = events.map((event) => {
    const detail = Object.entries(event.detail)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return `${event.at}  ${event.kind}  ${detail}`.trimEnd();
  });
  return {
    subject: `ryanlindsey.me: ${events.length} ${noun} (${lead})`,
    body: [...lines, '', 'Details: https://ryanlindsey.me/ops'].join('\n'),
  };
}

export interface MessageParts {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  date: Date;
}

/**
 * Refuses a header value containing CR or LF.
 *
 * THE ONE REAL HAZARD IN THIS FILE. A newline inside a header value ends that
 * header and starts another, so a `subject` carrying `\r\nBcc: …` would add a
 * recipient to an email this system sends. Nothing that reaches `subject` today
 * is caller-supplied -- `buildNotification` composes it from a fixed vocabulary
 * -- but "today" is the word that dates badly, and the check costs one pass.
 *
 * REFUSED, not stripped: a value that had to be edited to be safe is a value
 * whose origin should be looked at, and silently sending a repaired version
 * would hide that.
 */
function header(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`notify: ${name} header value contains a line break`);
  }
  return `${name}: ${value}`;
}

export function buildMimeMessage(parts: MessageParts): string {
  const headers = [
    header('From', parts.from),
    header('To', parts.to),
    header('Subject', parts.subject),
    header('Message-ID', parts.messageId),
    header('Date', parts.date.toUTCString()),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  // CRLF throughout, including inside the body: RFC 5322 defines a line ending
  // as CRLF, and a bare LF in the body is the kind of thing that survives every
  // local test and is rewritten or rejected by one relay in the chain.
  const body = parts.body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/**
 * Sends one batch, or says why it did not.
 *
 * SKIPS RATHER THAN THROWS on an absent destination secret. That state is the
 * expected one before the owner's prerequisite lands, and a queue consumer that
 * throws gets its batch retried and then dead-lettered -- turning "notifications
 * are not configured yet" into a growing pile of failed deliveries. The log line
 * is the operator's signal; the events are already in Analytics Engine and D1.
 */
export async function sendNotification(
  env: NotifyEnv,
  events: readonly IntentEvent[],
): Promise<'sent' | 'skipped'> {
  const mode = env.RLME_NOTIFY_MODE;
  if (mode !== undefined && mode !== 'stub') {
    throw new Error(`unrecognised RLME_NOTIFY_MODE: ${mode}`);
  }
  if (events.length === 0) return 'skipped';
  if (mode === 'stub') return 'skipped';

  let to: string;
  try {
    to = await env.RLME_NOTIFY_ADDRESS.get();
  } catch (error) {
    console.warn('agent-intel: no notification address is configured; not sending', error);
    return 'skipped';
  }
  if (to === '') return 'skipped';

  const { subject, body } = buildNotification(events);
  const messageId = `<${crypto.randomUUID()}@ryanlindsey.me>`;
  const raw = buildMimeMessage({
    from: env.RLME_NOTIFY_FROM,
    to,
    subject,
    body,
    messageId,
    date: new Date(),
  });

  try {
    const { EmailMessage } = await import('cloudflare:email');
    await env.EMAIL.send(new EmailMessage(env.RLME_NOTIFY_FROM, to, raw));
    return 'sent';
  } catch (error) {
    // Logged and swallowed for the same reason as the missing secret: a failed
    // send must not dead-letter an event that is already recorded elsewhere.
    console.error('agent-intel: the notification could not be sent', error);
    return 'skipped';
  }
}
