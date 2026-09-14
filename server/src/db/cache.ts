import type { Db } from './pool.js';
import { currentOrgId } from './pool.js';

export interface Cache {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic read-and-delete: the row is gone the instant this returns, so two callers racing the
   * same key can never both see a live value. For a one-time ticket (owner recovery). */
  take<T = unknown>(key: string): Promise<T | null>;
}

/**
 * `cache` is a global table with no row-level security, so the organisation goes into the key.
 * A key written with no organisation in scope stays bare: that is what a genuinely install-wide
 * cache entry looks like.
 */
function scoped(key: string): string {
  const orgId = currentOrgId();
  return orgId ? `org:${orgId}:${key}` : key;
}

export function createCache(db: Db): Cache {
  return {
    async get<T>(key: string) {
      const rows = await db.query<{ value: T }>('SELECT value FROM cache WHERE key=$1 AND expires_at > now()', [scoped(key)]);
      return rows[0]?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      await db.query(
        `INSERT INTO cache(key, value, expires_at) VALUES ($1, $2::jsonb, now() + ($3 || ' seconds')::interval)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at`,
        [scoped(key), JSON.stringify(value), String(ttlSeconds)],
      );
    },
    async del(key) { await db.query('DELETE FROM cache WHERE key=$1', [scoped(key)]); },
    async take<T>(key: string) {
      const rows = await db.query<{ value: T }>('DELETE FROM cache WHERE key=$1 AND expires_at > now() RETURNING value', [scoped(key)]);
      return rows[0]?.value ?? null;
    },
  };
}
