import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';

/** How long the debounce waits before the balance is read again. */
export const BALANCE_REFRESH_DELAY_MS = 60_000;

/**
 * Feature 9. One balance read per organisation after money settles, never one per payment.
 *
 * The check and the insert are a single statement, so nothing is enqueued twice. That alone is not
 * enough under READ COMMITTED — two callbacks landing together would each see no pending row and
 * both insert — so the statement first takes a transaction-scoped advisory lock keyed on this
 * organisation's refresh. The second caller waits on the lock, then reads the row the first one
 * committed and skips. `run_at > now()` is deliberate: a job already due (or running) is about to
 * read the balance anyway, and a second one would only repeat the same query. The organisation is
 * part of the test because jobs are install-wide rows, and one organisation's pending refresh must
 * never silence another's.
 */
export async function scheduleBalanceRefresh(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO jobs(kind, payload, run_at, max_attempts)
     SELECT 'balance_refresh', jsonb_build_object('reason', 'settled', 'orgId', $1::text),
            now() + ($2::int * interval '1 millisecond'), 2
       FROM (SELECT pg_advisory_xact_lock(hashtext('balance_refresh:' || COALESCE($1::text, '')))) AS gate
      WHERE NOT EXISTS (
        SELECT 1 FROM jobs
         WHERE kind = 'balance_refresh' AND done_at IS NULL AND run_at > now()
           AND payload->>'orgId' IS NOT DISTINCT FROM $1::text)`,
    [currentOrgId(), BALANCE_REFRESH_DELAY_MS]);
}
