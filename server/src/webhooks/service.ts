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
 * One address per organisation, and one address per API key as well. A key may be given its own
 * address and its own signing secret, and every notice for a payment that key asked for goes there
 * instead of to the organisation's. A key with no address of its own falls back to the
 * organisation's, so a studio whose keys were never given one behaves exactly as it always has.
 *
 * The secret belongs to the address and is stored encrypted with the organisation's key, because the
 * server has to sign with it; it is shown to the owner once, when it is made or rotated, and never in
 * a list, a log or an audit row.
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
  /** The key whose payments this notice is about, when the address it was written for is a key's. */
  keyName: string | null;
  attempts: number; lastStatus: number | null; lastResponse: string | null;
  lastTryAt: string | null; nextRetryAt: string | null; deliveredAt: string | null; createdAt: string;
  state: DeliveryState;
}
export interface WebhookActor { personId: string; ip: string }

/** One address and its secret: the organisation's own, or one key's own. */
export interface AddressService {
  get(): Promise<WebhookView>;
  /** Sets the address. A first save makes a secret and returns it; a later one keeps the secret. */
  save(url: string, actor: WebhookActor): Promise<WebhookSaved>;
  /** A new secret for the same address; the old one stops verifying immediately. */
  rotateSecret(actor: WebhookActor): Promise<WebhookSaved>;
  remove(actor: WebhookActor): Promise<void>;
}

export interface WebhooksService extends AddressService {
  /**
   * A key's own address. Reading answers with the organisation's when the key holds none of its own,
   * because that is where its notices will go. Saving, rotating and removing act on the key's own
   * address alone: rotating a key that has none is refused rather than changing the organisation's
   * secret, which belongs to every other receiver.
   */
  forKey(keyId: string): AddressService;
  /** The addresses keys hold themselves, by key id. A key with none of its own is not in the map. */
  heldByKeys(): Promise<Map<string, WebhookView>>;
  /**
   * The receiver follows its replacement: the replaced key's own address is copied to the new key,
   * address and secret together, so replacing a key never reconfigures or disturbs a receiver. A
   * replaced key keeps its own row while the notices already written for it drain.
   */
  copyForKey(fromKeyId: string, toKeyId: string, actor: WebhookActor): Promise<void>;
  listDeliveries(q: { state: 'all' | DeliveryState; limit: number }): Promise<DeliveryView[]>;
  /** Puts a delivery back in the queue for the next tick, however it ended last time. */
  retry(id: string, actor: WebhookActor): Promise<DeliveryView>;
  /** Forgets undelivered deliveries, and says how many went. Nothing that arrived is ever cleared. */
  clear(state: ClearableDeliveries, actor: WebhookActor): Promise<number>;
  /** The secret, for the dispatcher. Never returned to a caller. */
  secretFor(enc: string): Promise<string>;
  /**
   * Writes a notice for the address of the key that asked for the payment, falling back to the
   * organisation's address. `apiKeyId` is null for a payment no key asked for — money that arrived on
   * its own, or a send a person made — and those notices belong to the organisation's address.
   */
  enqueue(event: string, payload: Record<string, unknown>, requestId: string | null, apiKeyId?: string | null): Promise<{ id: string } | null>;
}

interface WebhookRow { id: string; api_key_id: string | null; url: string; secret_enc: string; secret_hint: string; updated_at: Date }
interface DeliveryRow {
  id: string; event: string; url: string; request_id: string | null; attempts: number;
  last_status: number | null; last_response: string | null; last_try_at: Date | null;
  next_retry_at: Date | null; delivered_at: Date | null; created_at: Date;
  key_name?: string | null;
}

const DELIVERY_STATE = (r: DeliveryRow): DeliveryState => (r.delivered_at ? 'delivered' : r.next_retry_at ? 'pending' : 'failed');

export function deliveryView(r: DeliveryRow): DeliveryView {
  return {
    id: r.id, event: r.event, url: r.url, requestId: r.request_id, keyName: r.key_name ?? null,
    attempts: r.attempts, lastStatus: r.last_status, lastResponse: r.last_response,
    lastTryAt: r.last_try_at?.toISOString() ?? null,
    nextRetryAt: r.next_retry_at?.toISOString() ?? null,
    deliveredAt: r.delivered_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    state: DELIVERY_STATE(r),
  };
}

/** One delivery with the key its address belongs to, for the list and for a single row. */
const DELIVERY_SELECT = `SELECT d.id, d.event, d.url, d.request_id, d.attempts, d.last_status, d.last_response,
       d.last_try_at, d.next_retry_at, d.delivered_at, d.created_at, k.name AS key_name
  FROM webhook_deliveries d
  LEFT JOIN webhooks w ON w.id = d.webhook_id
  LEFT JOIN api_keys k ON k.id = w.api_key_id`;

export function createWebhooksService({ db, keyring }: { db: Db; keyring: Keyring }): WebhooksService {
  /** The organisation's own address (keyId null), or the address a key holds itself. */
  async function rowFor(keyId: string | null): Promise<WebhookRow | null> {
    const [r] = await db.query<WebhookRow>(
      'SELECT id, api_key_id, url, secret_enc, secret_hint, updated_at FROM webhooks WHERE api_key_id IS NOT DISTINCT FROM $1',
      [keyId],
    );
    return r ?? null;
  }

  const viewOf = (r: WebhookRow | null): WebhookView => (r
    ? { url: r.url, secretHint: r.secret_hint, updatedAt: r.updated_at.toISOString() }
    : { url: null, secretHint: null, updatedAt: null });

  /** 32 bytes of base64url: long enough that guessing it is not a plan. */
  const newSecret = () => randomBytes(32).toString('base64url');

  /** What an audit row says an address is: the URL, and whose address it is when it is a key's. */
  const addressed = (base: { url: string }, keyId: string | null) => (keyId ? { ...base, apiKeyId: keyId } : base);

  function requireUrl(url: string): string {
    const trimmed = url.trim();
    const checked = checkWebhookUrl(trimmed);
    if (!checked.ok) throw new HttpError(400, 'bad_url', checked.reason);
    return trimmed;
  }

  /** A key that is not this organisation's own is not a key at all, as far as this service goes. */
  async function requireKey(keyId: string): Promise<void> {
    const [row] = await db.query<{ id: string }>('SELECT id FROM api_keys WHERE id = $1', [keyId]);
    if (!row) throw new HttpError(404, 'not_found', 'That key does not exist.');
  }

  async function saveFor(keyId: string | null, url: string, actor: WebhookActor): Promise<WebhookSaved> {
    const clean = requireUrl(url);
    const existing = await rowFor(keyId);
    if (existing) {
      await db.query('UPDATE webhooks SET url = $1, updated_at = now() WHERE id = $2', [clean, existing.id]);
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.saved', target: existing.id, before: { url: existing.url }, after: addressed({ url: clean }, keyId) });
      return { webhook: viewOf(await rowFor(keyId)), secret: null };
    }
    const secret = newSecret();
    const enc = await encryptForOrg(keyring, secret);
    const [made] = await db.query<{ id: string }>(
      'INSERT INTO webhooks(url, secret_enc, secret_hint, created_by, api_key_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [clean, enc, secret.slice(-4), actor.personId, keyId],
    );
    await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.created', target: made!.id, after: addressed({ url: clean }, keyId) });
    return { webhook: viewOf(await rowFor(keyId)), secret };
  }

  async function rotateFor(keyId: string | null, actor: WebhookActor): Promise<WebhookSaved> {
    const existing = await rowFor(keyId);
    if (!existing) {
      throw new HttpError(409, 'no_webhook', keyId
        ? 'That key has no address of its own. Set one for it first.'
        : 'Set an address first.');
    }
    const secret = newSecret();
    const enc = await encryptForOrg(keyring, secret);
    await db.query('UPDATE webhooks SET secret_enc = $1, secret_hint = $2, updated_at = now() WHERE id = $3', [enc, secret.slice(-4), existing.id]);
    await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.secret_rotated', target: existing.id, after: addressed({ url: existing.url }, keyId) });
    return { webhook: viewOf(await rowFor(keyId)), secret };
  }

  async function removeFor(keyId: string | null, actor: WebhookActor): Promise<void> {
    const existing = await rowFor(keyId);
    if (!existing) return;
    // The queue goes with the address: a delivery with nowhere to go is a retry storm waiting to
    // happen. Only this address's own queue, though — another receiver's notices are not this
    // address's to throw away.
    await db.query('DELETE FROM webhook_deliveries WHERE webhook_id = $1 AND delivered_at IS NULL', [existing.id]);
    await db.query('DELETE FROM webhooks WHERE id = $1', [existing.id]);
    await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.removed', target: existing.id, before: addressed({ url: existing.url }, keyId) });
  }

  function addressFor(keyId: string | null): AddressService {
    return {
      async get() {
        const own = await rowFor(keyId);
        if (own || keyId === null) return viewOf(own);
        // A key with no address of its own answers with the organisation's: that is where its
        // notices actually go.
        return viewOf(await rowFor(null));
      },
      async save(url, actor) {
        if (keyId) await requireKey(keyId);
        return saveFor(keyId, url, actor);
      },
      async rotateSecret(actor) {
        if (keyId) await requireKey(keyId);
        return rotateFor(keyId, actor);
      },
      async remove(actor) {
        if (keyId) await requireKey(keyId);
        return removeFor(keyId, actor);
      },
    };
  }

  return {
    ...addressFor(null),

    forKey: (keyId) => addressFor(keyId),

    async heldByKeys() {
      const rows = await db.query<WebhookRow>(
        'SELECT id, api_key_id, url, secret_enc, secret_hint, updated_at FROM webhooks WHERE api_key_id IS NOT NULL',
      );
      return new Map(rows.map((r) => [r.api_key_id!, viewOf(r)]));
    },

    async copyForKey(fromKeyId, toKeyId, actor) {
      const source = await rowFor(fromKeyId);
      if (!source) return;
      await db.query(
        `INSERT INTO webhooks(url, secret_enc, secret_hint, created_by, api_key_id) VALUES ($1,$2,$3,$4,$5)`,
        [source.url, source.secret_enc, source.secret_hint, actor.personId, toKeyId],
      );
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.copied', after: { url: source.url, apiKeyId: toKeyId, copiedFrom: fromKeyId } });
    },

    async listDeliveries(q) {
      const where: string[] = [];
      if (q.state === 'delivered') where.push('d.delivered_at IS NOT NULL');
      if (q.state === 'pending') where.push('d.delivered_at IS NULL AND d.next_retry_at IS NOT NULL');
      if (q.state === 'failed') where.push('d.delivered_at IS NULL AND d.next_retry_at IS NULL');
      const rows = await db.query<DeliveryRow>(
        `${DELIVERY_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY d.created_at DESC, d.id DESC LIMIT $1`,
        [q.limit],
      );
      return rows.map(deliveryView);
    },

    async retry(id, actor) {
      const [row] = await db.query<{ id: string; event: string }>(
        `UPDATE webhook_deliveries SET next_retry_at = now(), delivered_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING id, event`,
        [id],
      );
      if (!row) throw new HttpError(404, 'not_found', 'That delivery does not exist.');
      await audit(db, { personId: actor.personId, ip: actor.ip, action: 'webhook.retried', target: id, after: { event: row.event } });
      const [after] = await db.query<DeliveryRow>(`${DELIVERY_SELECT} WHERE d.id = $1`, [id]);
      return deliveryView(after!);
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

    async enqueue(event, payload, requestId, apiKeyId = null) {
      const org = currentOrgId();
      if (!org) throw new Error('a webhook delivery needs an organisation');
      // The notice belongs to the key that asked for the payment; a key with no address of its own
      // falls back to the organisation's, and a payment no key asked for belongs to the
      // organisation's address outright.
      const own = apiKeyId ? await rowFor(apiKeyId) : null;
      const hook = own ?? (await rowFor(null));
      // No address, no queue: nothing is accumulated for a receiver that does not exist.
      if (!hook) return null;
      const [made] = await db.query<{ id: string }>(
        'INSERT INTO webhook_deliveries(event, url, payload, request_id, webhook_id) VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING id',
        [event, hook.url, JSON.stringify(payload), requestId, hook.id],
      );
      return made ?? null;
    },
  };
}
