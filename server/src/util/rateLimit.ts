import type { Db } from '../db/pool.js';

export interface RateLimitState {
  /** Attempts recorded in the current window, this one included. */
  hits: number;
  /** True once `hits` has gone past `max` — the caller refuses the request. */
  exceeded: boolean;
  /** Whole seconds left in the current window, never less than 1. */
  retryAfterSeconds: number;
}

/**
 * One fixed window per key, counted with a single `INSERT … ON CONFLICT … RETURNING`, so the
 * increment and the read are the same statement: two requests racing the same key serialize on that
 * row instead of both reading a stale count before either has recorded its attempt. A window older
 * than `windowSeconds` restarts at 1.
 *
 * `rate_limits` (migration 007) is install-wide — no `org_id`, no row-level security — so the
 * organisation, the address or the username lives in the key. Spec section 8.3 lists them all.
 */
export async function hit(db: Db, key: string, max: number, windowSeconds: number): Promise<RateLimitState> {
  const rows = await db.query<{ hits: number; age_seconds: number }>(
    `INSERT INTO rate_limits(key, hits, window_start) VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       -- Both arms below ask the same question — has this window expired? — kept as one condition
       -- repeated rather than factored out, because sharing a single evaluation across both arms of
       -- one SET clause needs a CTE or a self-join, and neither pays for itself at this size.
       hits = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => $2::int)
                   THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start <= now() - make_interval(secs => $2::int)
                           THEN now() ELSE rate_limits.window_start END
     RETURNING hits, FLOOR(EXTRACT(EPOCH FROM (now() - window_start)))::int AS age_seconds`,
    [key, windowSeconds],
  );
  const row = rows[0];
  return {
    hits: row.hits,
    exceeded: row.hits > max,
    // age_seconds is floored, never rounded, so it never overstates how much of the window is
    // gone — retryAfterSeconds is therefore never a second early.
    retryAfterSeconds: Math.max(1, windowSeconds - Number(row.age_seconds)),
  };
}
