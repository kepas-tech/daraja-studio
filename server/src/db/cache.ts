import type { Db } from './pool.js';
import { currentOrgId } from './pool.js';

export interface Cache {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomic read-and-delete: the row is gone the instant this returns, so two callers racing the
   * same key can never both see a live value. For a one-time ticket (owner recovery). */
  take<T = unknown>(key: string): Promise<T | null>;
  /**
   * Take a lease on a key for `ttlSeconds`, atomically: true means this caller now holds it. An
   * expired lease is taken over rather than refusing for ever, so a process that died holding one
   * cannot wedge the key (brief 2, item 7 — the operator pool's in-flight slot).
   */
  acquire(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  /** Give a lease up, but only while this token still holds it: a lease that already ran out and
   * was taken by somebody else must never be deleted by its old owner. */
  release(key: string, token: string): Promise<void>;
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
    async acquire(key, token, ttlSeconds) {
      const rows = await db.query<{ key: string }>(
        `INSERT INTO cache(key, value, expires_at) VALUES ($1, $2::jsonb, now() + ($3 || ' seconds')::interval)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
           WHERE cache.expires_at <= now()
         RETURNING key`,
        [scoped(key), JSON.stringify({ token }), String(ttlSeconds)]);
      return rows.length > 0;
    },
    async release(key, token) {
      await db.query("DELETE FROM cache WHERE key=$1 AND value->>'token' = $2", [scoped(key), token]);
    },
  };
}
