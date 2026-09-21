import { randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { decryptForOrg, encryptForOrg, type Keyring } from '../crypto/secrets.js';
import { checkWebhookUrl } from './signing.js';

/**
 * Round 3, phase E: the webhook address, its signing secret, and the deliveries queue.
 *
 * One address per organisation. The secret is the organisation's own and is stored encrypted with
 * the organisation's key, because the server has to sign with it; it is shown to the owner once,
 * when it is made or rotated, and never in a list, a log or an audit row.
 */
export interface WebhookView {
  url: string | null;
  /** The last four characters of the current secret, so the owner can tell which one is in use. */
  secretHint: string | null;
  updatedAt: string | null;
}
/** `secret` is filled only by the save that made one: the first save, and a rotation. */
export interface WebhookSaved { webhook: WebhookView; secret: string | null }
export type DeliveryState = 'pending' | 'delivered' | 'failed';
/**
 * What a person may ask the studio to forget: the deliveries that gave up, the ones still waiting
 * their turn, or every one that has not arrived. A delivery that arrived is the record of what the
 * receiver accepted, so it is never cleared — and none of this touches the payment itself.
 */
export type ClearableDeliveries = 'failed' | 'pending' | 'all';
export interface DeliveryView {
  id: string; event: string; url: string; requestId: string | null;
  attempts: number; lastStatus: number | null; lastResponse: string | null;
  lastTryAt: string | null; nextRetryAt: string | null; deliveredAt: string | null; createdAt: string;
  state: DeliveryState;
}
export interface WebhookActor { personId: string; ip: string }

export interface WebhooksService {
  get(): Promise<WebhookView>;
  /** Sets the address. A first save makes a secret and returns it; a later one keeps the secret. */
  save(url: string, actor: WebhookActor): Promise<WebhookSaved>;
  /** A new secret for the same address; the old one stops verifying immediately. */
  rotateSecret(actor: WebhookActor): Promise<WebhookSaved>;
  remove(actor: WebhookActor): Promise<void>;
  listDeliveries(q: { state: 'all' | DeliveryState; limit: number }): Promise<DeliveryView[]>;
  /** Puts a delivery back in the queue for the next tick, however it ended last time. */
  retry(id: string, actor: WebhookActor): Promise<DeliveryView>;
  /** Forgets undelivered deliveries, and says how many went. Nothing that arrived is ever cleared. */
  clear(state: ClearableDeliveries, actor: WebhookActor): Promise<number>;
  /** The secret, for the dispatcher. Never returned to a caller. */
  secretFor(enc: string): Promise<string>;
  enqueue(event: string, payload: Record<string, unknown>, requestId: string | null): Promise<{ id: string } | null>;
}

interface WebhookRow { id: string; url: string; secret_enc: string; secret_hint: string; updated_at: Date }
interface DeliveryRow {
  id: string; event: string; url: string; request_id: string | null; attempts: number;
  last_status: number | null; last_response: string | null; last_try_at: Date | null;
  next_retry_at: Date | null; delivered_at: Date | null; created_at: Date;
}

const DELIVERY_STATE = (r: DeliveryRow): DeliveryState => (r.delivered_at ? 'delivered' : r.next_retry_at ? 'pending' : 'failed');

export function deliveryView(r: DeliveryRow): DeliveryView {
  return {
    id: r.id, event: r.event, url: r.url, requestId: r.request_id, attempts: r.attempts,
    lastStatus: r.last_status, lastResponse: r.last_response,
    lastTryAt: r.last_try_at?.toISOString() ?? null,
    nextRetryAt: r.next_retry_at?.toISOString() ?? null,
    deliveredAt: r.delivered_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    state: DELIVERY_STATE(r),
  };
}

export function createWebhooksService({ db, keyring }: { db: Db; keyring: Keyring }): WebhooksService {
  async function row(): Promise<WebhookRow | null> {
    const [r] = await db.query<WebhookRow>('SELECT id, url, secret_enc, secret_hint, updated_at FROM webhooks');
    return r ?? null;
  }

  const viewOf = (r: WebhookRow | null): WebhookView => (r
    ? { url: r.url, secretHint: r.secret_hint, updatedAt: r.updated_at.toISOString() }
    : { url: null, secretHint: null, updatedAt: null });

  /** 32 bytes of base64url: long enough that guessing it is not a plan. */
  const newSecret = () => randomBytes(32).toString('base64url');

  function requireUrl(url: string): string {
    const trimmed = url.trim();
    const checked = checkWebhookUrl(trimmed);
    if (!checked.ok) throw new HttpError(400, 'bad_url', checked.reason);
    return trimmed;
  }

  return {
    async get() { return viewOf(await row()); },

    async save(url, actor) {
      const clean = requireUrl(url);
      const existing = await row();
      if (existing) {
        await db.query('UPDATE webhooks SET url = $1, updated_at = now() WHERE id = $2', [clean, existing.id]);
        await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.saved', target: existing.id, before: { url: existing.url }, after: { url: clean } });
        return { webhook: viewOf(await row()), secret: null };
      }
      const secret = newSecret();
      const enc = await encryptForOrg(keyring, secret);
      const [made] = await db.query<{ id: string }>(
        'INSERT INTO webhooks(url, secret_enc, secret_hint, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
        [clean, enc, secret.slice(-4), actor.personId],
      );
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.created', target: made!.id, after: { url: clean } });
      return { webhook: viewOf(await row()), secret };
    },

    async rotateSecret(actor) {
      const existing = await row();
      if (!existing) throw new HttpError(409, 'no_webhook', 'Set an address first.');
      const secret = newSecret();
      const enc = await encryptForOrg(keyring, secret);
      await db.query('UPDATE webhooks SET secret_enc = $1, secret_hint = $2, updated_at = now() WHERE id = $3', [enc, secret.slice(-4), existing.id]);
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.secret_rotated', target: existing.id, after: { url: existing.url } });
      return { webhook: viewOf(await row()), secret };
    },

    async remove(actor) {
      const existing = await row();
      if (!existing) return;
      // The queue goes with it: a delivery with nowhere to go is a retry storm waiting to happen.
      await db.query('DELETE FROM webhook_deliveries WHERE delivered_at IS NULL');
      await db.query('DELETE FROM webhooks WHERE id = $1', [existing.id]);
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.removed', target: existing.id, before: { url: existing.url } });
    },

    async listDeliveries(q) {
      const where: string[] = [];
      if (q.state === 'delivered') where.push('delivered_at IS NOT NULL');
      if (q.state === 'pending') where.push('delivered_at IS NULL AND next_retry_at IS NOT NULL');
      if (q.state === 'failed') where.push('delivered_at IS NULL AND next_retry_at IS NULL');
      const rows = await db.query<DeliveryRow>(
        `SELECT id, event, url, request_id, attempts, last_status, last_response, last_try_at, next_retry_at, delivered_at, created_at
           FROM webhook_deliveries ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY created_at DESC, id DESC LIMIT $1`,
        [q.limit],
      );
      return rows.map(deliveryView);
    },

    async retry(id, actor) {
      const [row] = await db.query<DeliveryRow & { delivered_at: Date | null }>(
        `UPDATE webhook_deliveries SET next_retry_at = now(), delivered_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING id, event, url, request_id, attempts, last_status, last_response, last_try_at, next_retry_at, delivered_at, created_at`,
        [id],
      );
      if (!row) throw new HttpError(404, 'not_found', 'That delivery does not exist.');
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.retried', target: id, after: { event: row.event } });
      return deliveryView(row);
    },

    async clear(state, actor) {
      const where = state === 'failed'
        ? 'delivered_at IS NULL AND next_retry_at IS NULL'
        : state === 'pending'
          ? 'delivered_at IS NULL AND next_retry_at IS NOT NULL'
          : 'delivered_at IS NULL';
      const gone = await db.query<{ id: string }>(`DELETE FROM webhook_deliveries WHERE ${where} RETURNING id`);
      if (gone.length > 0) {
        await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.deliveries_cleared', after: { state, removed: gone.length } });
      }
      return gone.length;
    },

    secretFor: (enc) => decryptForOrg(keyring, enc),

    async enqueue(event, payload, requestId) {
      const org = currentOrgId();
      if (!org) throw new Error('a webhook delivery needs an organisation');
      const hook = await row();
      // No address, no queue: nothing is accumulated for a receiver that does not exist.
      if (!hook) return null;
      const [made] = await db.query<{ id: string }>(
        'INSERT INTO webhook_deliveries(event, url, payload, request_id) VALUES ($1,$2,$3::jsonb,$4) RETURNING id',
        [event, hook.url, JSON.stringify(payload), requestId],
      );
      return made ?? null;
    },
  };
}
