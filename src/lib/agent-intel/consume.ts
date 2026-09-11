import { isIntentEvent, type IntentEvent } from './intent';
import { sendNotification, type NotifyEnv } from './notify';

/**
 * One queue batch, as a function a plain vitest test can call.
 *
 * The `queue()` export in src/worker.ts is a two-line delegation to this, and
 * that split is deliberate: the Worker entry imports Astro's virtual modules
 * and cannot be loaded by a vitest process, so anything left inside it is
 * untestable except through a booted harness. What is NOT proven by the tests
 * here, stated rather than implied: that wrangler.jsonc's consumer entry names
 * this queue, and that the platform actually invokes `queue()`. Task 13
 * verifies both against the deployed Worker.
 */
export async function handleEventBatch(
  messages: readonly { body: unknown }[],
  env: NotifyEnv,
): Promise<'sent' | 'skipped'> {
  const events: IntentEvent[] = [];
  for (const message of messages) {
    if (isIntentEvent(message.body)) events.push(message.body);
    else console.warn('agent-intel: dropped a queue message this build does not recognise');
  }
  return sendNotification(env, events);
}
