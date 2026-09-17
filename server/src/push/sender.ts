import { createRequire } from 'node:module';
import type { RequestOptions } from 'web-push';
import type { Vapid } from './config.js';

// web-push is CommonJS: its types name no default export and Node cannot see named exports on the
// package either, so it is required the same way health/routes.ts reads package.json.
const require = createRequire(import.meta.url);
const webpush = require('web-push') as typeof import('web-push');

/** One browser subscription as the sender needs it. */
export interface PushTarget { endpoint: string; p256dh: string; auth: string }

/** What the service worker shows. The tag is the inbox's dedupe key, so a repeat replaces. */
export interface PushMessage { title: string; body: string; tag: string; url: string }

export type PushResult = 'ok' | 'gone' | 'failed';

export interface PushSender { send(target: PushTarget, message: PushMessage): Promise<PushResult> }

/** An hour: a line about a payment is worth little by tomorrow, and the inbox still has it. */
const TTL_SECONDS = 3600;

/** What a push service answers when the browser has thrown the subscription away. */
const GONE = new Set([404, 410]);

/**
 * The real sender. It is built only when the deployment has keys, and every failure is answered
 * with a word, never an exception: the caller decides what a dead subscription means.
 */
export function createVapidSender(vapid: Vapid): PushSender {
  return {
    async send(target, message) {
      const options: RequestOptions = { vapidDetails: vapid, TTL: TTL_SECONDS, urgency: 'high' };
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(message),
          options,
        );
        return 'ok';
      } catch (err) {
        const status = (err as { statusCode?: unknown }).statusCode;
        if (typeof status === 'number' && GONE.has(status)) return 'gone';
        // A status code or a type name, never the address, the keys or the sentence: the endpoint
        // is a capability, and a container log is the easiest place for one to leak.
        console.warn('push send failed:', typeof status === 'number' ? 'status ' + status : err instanceof Error ? err.name : 'unknown error');
        return 'failed';
      }
    },
  };
}
