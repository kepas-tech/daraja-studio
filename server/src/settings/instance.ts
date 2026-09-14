import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import { decrypt, encrypt } from '../crypto/secrets.js';

/** Install-wide facts. `instance_settings` has no organisation and no row-level security. */
export type InstanceKey = 'https.seen' | 'billing.env' | 'billing.payeeName';

/** `billing.*` is encrypted under the install master key (migration 007's `encrypted` column). */
const isEncrypted = (key: InstanceKey) => key.startsWith('billing.');

export interface InstanceSettings {
  get(key: InstanceKey): Promise<string | null>;
  set(key: InstanceKey, value: string): Promise<void>;
  /**
   * The same write on the caller's transaction client, so a change that spans two keys commits
   * together with its audit row (the host's billing settings, spec 6.1).
   */
  setOn(c: PoolClient, key: InstanceKey, value: string): Promise<void>;
}

export function createInstanceSettings(db: Db, master: Buffer): InstanceSettings {
  const upsert =
    `INSERT INTO instance_settings(key, value, encrypted) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, encrypted=EXCLUDED.encrypted, updated_at=now()`;
  const params = (key: InstanceKey, value: string): [string, string, boolean] =>
    [key, isEncrypted(key) ? encrypt(master, value) : value, isEncrypted(key)];

  return {
    // `https.seen` is a plain flag and stays readable exactly as it was; only a row written with
    // the encrypted flag set is decrypted, so both shapes can live in one table.
    async get(key) {
      const rows = await db.query<{ value: string; encrypted: boolean }>('SELECT value, encrypted FROM instance_settings WHERE key=$1', [key]);
      const row = rows[0];
      if (!row) return null;
      return row.encrypted ? decrypt(master, row.value) : row.value;
    },
    async set(key, value) {
      await db.query(upsert, params(key, value));
    },
    async setOn(c, key, value) {
      await c.query(upsert, params(key, value));
    },
  };
}
