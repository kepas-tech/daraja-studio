import type { Db } from '../db/pool.js';
export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

export interface AttemptState { failures: number; lockedUntil: Date | null }

/**
 * Records one attempt for each key and returns the worst (highest failures / furthest
 * lockedUntil) state across them. The increment and the read are the same statement (UPSERT ...
 * RETURNING), so this is the gate itself: two requests racing the same key serialize on the
 * row's upsert instead of both reading a stale "not locked" state before either has recorded its
 * attempt (the previous check-then-write via a separate SELECT was a TOCTOU gap under
 * concurrency). Lock engages once failures exceeds MAX_FAILURES, so the attempt that produces the
 * 5th failure itself still runs (and is free to succeed or fail on its own merits); only the 6th+
 * attempt in a window is turned away before a password is even checked. Once locked, an attempt
 * leaves failures, updated_at and locked_until untouched — otherwise one request every
 * LOCK_MINUTES would keep re-arming the lock and the owner would never get back in. The lock (and
 * the failure count) only resets once locked_until or the attempt window has actually expired.
 */
export async function recordAttempt(db: Db, keys: string[]): Promise<AttemptState> {
  const worst: AttemptState = { failures: 0, lockedUntil: null };
  for (const key of keys) {
    const rows = await db.query<{ failures: number; locked_until: Date | null }>(
      `INSERT INTO login_attempts(key, failures, updated_at) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE
           WHEN login_attempts.locked_until > now() THEN login_attempts.failures
           WHEN login_attempts.locked_until <= now() OR login_attempts.updated_at < now() - ($3 || ' minutes')::interval THEN 1
           ELSE login_attempts.failures + 1
         END,
         updated_at = CASE WHEN login_attempts.locked_until > now() THEN login_attempts.updated_at ELSE now() END,
         locked_until = CASE
           WHEN login_attempts.locked_until > now() THEN login_attempts.locked_until
           WHEN login_attempts.locked_until <= now() OR login_attempts.updated_at < now() - ($3 || ' minutes')::interval THEN NULL
           WHEN login_attempts.failures + 1 > $2 THEN now() + ($3 || ' minutes')::interval
           ELSE login_attempts.locked_until
         END
       RETURNING failures, locked_until`,
      [key, MAX_FAILURES, String(LOCK_MINUTES)],
    );
    const row = rows[0];
    if (row) {
      if (row.failures > worst.failures) worst.failures = row.failures;
      if (row.locked_until && (!worst.lockedUntil || row.locked_until > worst.lockedUntil)) worst.lockedUntil = row.locked_until;
    }
  }
  return worst;
}

export async function clearFailures(db: Db, keys: string[]): Promise<void> {
  await db.query('DELETE FROM login_attempts WHERE key = ANY($1)', [keys]);
}
