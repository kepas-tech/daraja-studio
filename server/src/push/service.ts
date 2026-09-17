import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import { audit } from '../audit/log.js';
import type { Classified } from '../notifications/classify.js';
import type { Vapid } from './config.js';
import { createVapidSender, type PushMessage, type PushResult, type PushSender, type PushTarget } from './sender.js';

/** Five failures in a row is a subscription that will never work; it is treated like a 410. */
const MAX_FAILURES = 5;

interface DeviceRow { id: string; person_id: string; endpoint: string; p256dh: string; auth: string }

const SELECT_LIVE = 'SELECT id, person_id, endpoint, p256dh, auth FROM push_subscriptions WHERE org_id = $1 AND gone_at IS NULL';

export interface PushService {
  /** False when the deployment has no VAPID keys: every other method then does nothing. */
  configured(): boolean;
  /** The public half the browser subscribes with, or null when push is off. */
  publicKey(): string | null;
  subscribe(input: { personId: string; endpoint: string; p256dh: string; auth: string; ip?: string }): Promise<{ devices: number }>;
  unsubscribe(input: { personId: string; endpoint: string; ip?: string }): Promise<void>;
  /** One line from the inbox, out to every live device of this organisation. Never throws. */
  notify(c: Classified): Promise<void>;
  sendTest(input: { personId: string; ip?: string }): Promise<{ sent: number; failed: number }>;
}

const TEST_MESSAGE: PushMessage = {
  title: 'Studio notifications are on',
  body: 'This device will be told when something happens. Send a test again any time.',
  tag: 'push-test',
  url: '/notifications',
};

/**
 * Feature 12, second half. Every statement runs inside the caller's organisation (orgContext on a
 * request, withOrg in the writer) with the explicit org predicate as the stores' usual defence in
 * depth. The endpoint and its two keys are stored because a push cannot be sent without them, and
 * are otherwise treated as a capability: they are never logged and never put in an audit row.
 */
export function createPushService(deps: { db: Db; vapid: Vapid | null; sender?: PushSender }): PushService {
  const orgId = () => currentOrgId();
  const sender = deps.sender ?? (deps.vapid ? createVapidSender(deps.vapid) : null);

  /** Every live device of this organisation, or only one person's. */
  async function liveDevices(personId?: string): Promise<DeviceRow[]> {
    return personId
      ? deps.db.query<DeviceRow>(SELECT_LIVE + ' AND person_id = $2', [orgId(), personId])
      : deps.db.query<DeviceRow>(SELECT_LIVE, [orgId()]);
  }

  /** What the page shows and what the audit row records: how many live devices this person has. */
  async function deviceCount(personId: string): Promise<number> {
    const [row] = await deps.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM push_subscriptions WHERE org_id = $1 AND person_id = $2 AND gone_at IS NULL',
      [orgId(), personId],
    );
    return row?.n ?? 0;
  }

  /**
   * One device, one answer, one bookkeeping row. A sender that throws counts as a failure rather
   * than ending the loop: the other devices of the same organisation still deserve their line.
   */
  async function sendTo(device: DeviceRow, message: PushMessage): Promise<PushResult> {
    const target: PushTarget = { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth };
    let result: PushResult;
    try {
      result = await sender!.send(target, message);
    } catch {
      result = 'failed';
    }
    if (result === 'ok') {
      await deps.db.query('UPDATE push_subscriptions SET failures = 0, last_ok_at = now() WHERE id = $1', [device.id]);
    } else if (result === 'gone') {
      await deps.db.query('UPDATE push_subscriptions SET gone_at = now() WHERE id = $1', [device.id]);
    } else {
      await deps.db.query(
        'UPDATE push_subscriptions SET failures = failures + 1, failed_at = now(), gone_at = CASE WHEN failures + 1 >= $2 THEN now() ELSE gone_at END WHERE id = $1',
        [device.id, MAX_FAILURES],
      );
    }
    return result;
  }

  return {
    configured: () => sender !== null,
    publicKey: () => deps.vapid?.publicKey ?? null,

    async subscribe(input) {
      // The upsert is the conflict target's whole point: the browser signed in now takes the device
      // over, and a subscription that had been marked gone comes back to life.
      await deps.db.query(
        `INSERT INTO push_subscriptions(org_id, person_id, endpoint, p256dh, auth)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, endpoint) DO UPDATE
           SET person_id = EXCLUDED.person_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
               created_at = now(), failures = 0, failed_at = NULL, gone_at = NULL`,
        [orgId(), input.personId, input.endpoint, input.p256dh, input.auth],
      );
      const devices = await deviceCount(input.personId);
      await audit(deps.db, { personId: input.personId, action: 'push.subscription_added', target: 'push', after: { devices }, ip: input.ip });
      return { devices };
    },

    async unsubscribe(input) {
      const rows = await deps.db.query<{ id: string }>(
        'DELETE FROM push_subscriptions WHERE org_id = $1 AND person_id = $2 AND endpoint = $3 RETURNING id',
        [orgId(), input.personId, input.endpoint],
      );
      // Pressing it twice, or on a device that was never subscribed, is harmless and writes nothing.
      if (rows.length === 0) return;
      await audit(deps.db, { personId: input.personId, action: 'push.subscription_removed', target: 'push', ip: input.ip });
    },

    async notify(c) {
      if (!sender) return;
      const message: PushMessage = {
        title: c.title,
        body: c.body,
        // The inbox collapses a repeat into one row with a count; the device collapses it the same
        // way, so a second failure is not a second banner.
        tag: c.dedupeKey,
        url: typeof c.data.requestId === 'string' ? '/requests/' + c.data.requestId : '/notifications',
      };
      try {
        const devices = await liveDevices();
        for (const device of devices) {
          try { await sendTo(device, message); }
          catch (err) { console.warn('push device skipped:', err instanceof Error ? err.name : 'unknown error'); }
        }
      } catch (err) {
        // The row in the inbox is worth more than the message about it: the writer always finishes.
        // A pg error's message can quote the value it rejected, and the value here is a capability,
        // so only its SQLSTATE (or the error type) is ever printed.
        const code = (err as { code?: unknown }).code;
        console.warn('push notify failed:', typeof code === 'string' ? 'code ' + code : err instanceof Error ? err.name : 'unknown error');
      }
    },

    async sendTest(input) {
      if (!sender) return { sent: 0, failed: 0 };
      const devices = await liveDevices(input.personId);
      let sent = 0; let failed = 0;
      for (const device of devices) {
        const result = await sendTo(device, TEST_MESSAGE);
        if (result === 'ok') sent += 1; else failed += 1;
      }
      return { sent, failed };
    },
  };
}
