import type { Db } from '../db/pool.js';
import { decryptForOrg, type Keyring } from '../crypto/secrets.js';
import { EVENT_HEADER, SIGNATURE_HEADER, checkWebhookUrl, signWebhook } from './signing.js';

/**
 * Round 3, phase E: the webhook dispatcher, modelled on kepas-pay's but in Studio's own words.
 *
 * Every tick it takes the deliveries that are due, signs each one, and posts it. What it does with
 * the answer is the whole point:
 *
 *   attempt 1 fails -> try again in 1 minute
 *   attempt 2 fails -> 5 minutes
 *   attempt 3 fails -> 30 minutes
 *   attempt 4 fails -> 2 hours
 *   attempt 5 fails -> 6 hours
 *   attempt 6 fails -> 24 hours, and that was the sixth: the delivery is left failed for a person
 *
 * A receiver that answers 2xx is done. Nothing here ever logs the secret or the signature, and the
 * payload is what Studio already shows on the payment's own page.
 */
export const RETRY_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 24 * 3600];
export const MAX_ATTEMPTS = RETRY_SECONDS.length;
export const HTTP_TIMEOUT_MS = 5_000;
export const BATCH = 25;
const RESPONSE_KEPT = 512;

export interface DispatchResult { sent: number; failed: number; given: number }

interface DueRow {
  id: string; event: string; url: string; payload: Record<string, unknown>; attempts: number; secret_enc: string;
}

export function createWebhookDispatcher(deps: { db: Db; keyring: Keyring; fetchImpl?: typeof fetch }) {
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    async dispatchOnce(): Promise<DispatchResult> {
      const due = await deps.db.query<DueRow>(
        `SELECT d.id, d.event, d.url, d.payload, d.attempts, w.secret_enc
           FROM webhook_deliveries d
           JOIN webhooks w ON w.org_id = d.org_id
          WHERE d.delivered_at IS NULL AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= now()
          ORDER BY d.next_retry_at
          LIMIT $1
          FOR UPDATE OF d SKIP LOCKED`,
        [BATCH],
      );

      const out: DispatchResult = { sent: 0, failed: 0, given: 0 };
      for (const row of due) {
        const done = await deliver(row);
        if (done === 'sent') out.sent += 1;
        else if (done === 'given') out.given += 1;
        else out.failed += 1;
      }
      return out;
    },
  };

  async function deliver(row: DueRow): Promise<'sent' | 'failed' | 'given'> {
    const attempts = row.attempts + 1;
    const guard = checkWebhookUrl(row.url);
    if (!guard.ok) {
      // A permanent answer, not a retry: this address cannot be posted to at all.
      await deps.db.query(
        `UPDATE webhook_deliveries SET attempts = $2, last_status = NULL, last_response = $3, last_try_at = now(), next_retry_at = NULL, updated_at = now() WHERE id = $1`,
        [row.id, attempts, 'blocked: ' + guard.reason],
      );
      console.error('webhook blocked', row.id, guard.reason);
      return 'given';
    }

    const secret = await decryptForOrg(deps.keyring, row.secret_enc);
    const rawBody = JSON.stringify(row.payload);
    const sig = signWebhook(rawBody, secret);

    let status: number | null = null;
    let said: string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await doFetch(row.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: sig.header,
          [EVENT_HEADER]: row.event,
          'user-agent': 'daraja-studio/1.0',
        },
        body: rawBody,
        signal: controller.signal,
      });
      status = res.status;
      said = (await res.text()).slice(0, RESPONSE_KEPT);
    } catch (e) {
      // The error's own words only; a URL can carry credentials, so it is never printed.
      said = 'network_error: ' + (e instanceof Error ? e.name : 'unknown');
    } finally {
      clearTimeout(timer);
    }

    const ok = status !== null && status >= 200 && status < 300;
    if (ok) {
      await deps.db.query(
        `UPDATE webhook_deliveries SET attempts = $2, last_status = $3, last_response = $4, last_try_at = now(), next_retry_at = NULL, delivered_at = now(), updated_at = now() WHERE id = $1`,
        [row.id, attempts, status, said],
      );
      return 'sent';
    }

    if (attempts >= MAX_ATTEMPTS) {
      await deps.db.query(
        `UPDATE webhook_deliveries SET attempts = $2, last_status = $3, last_response = $4, last_try_at = now(), next_retry_at = NULL, updated_at = now() WHERE id = $1`,
        [row.id, attempts, status, said],
      );
      console.error('webhook given up on', row.id, 'after', attempts, 'attempts');
      return 'given';
    }

    const wait = RETRY_SECONDS[attempts - 1]!;
    await deps.db.query(
      `UPDATE webhook_deliveries SET attempts = $2, last_status = $3, last_response = $4, last_try_at = now(), next_retry_at = now() + ($5 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
      [row.id, attempts, status, said, String(wait)],
    );
    return 'failed';
  }
}
