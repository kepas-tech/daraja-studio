import type { Db } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import { CREDENTIAL_CODES } from './registry.js';

/** One failure stands for ten minutes; after that the next one starts the count again at one. */
export const FAILURE_WINDOW_MS = 10 * 60_000;
/** Failures inside one window before the operator is marked failed: the second, never the first. */
export const FAILURES_BEFORE_DOWN = 2;

/**
 * Safaricom refused a request with a credential-class code for the operator that signed it.
 *
 * One refusal is not proof the credential is dead: a stale password often survives the next call
 * with a fresh token, and a single blip must not stop every send. So the first refusal only records
 * itself; the second inside the window marks the operator failed, which takes it out of sending
 * until somebody presses Reinstate. Returns true when the operator was recorded.
 *
 * One statement, so two results landing together cannot each read the old count: the CTE locks the
 * row before it is counted, and the UPDATE re-reads it under that lock.
 */
export async function failOperatorOnCredentialCode(db: Db, events: EventHub, operatorId: string | null, code: string | number, resultDesc: string): Promise<boolean> {
  if (!operatorId || !CREDENTIAL_CODES.has(String(code))) return false;
  const rows = await db.query<{ consecutive_failures: number; status: string }>(
    `WITH current AS (
       SELECT id, status, consecutive_failures, last_failure_at
         FROM operators
        WHERE id=$1 AND status <> 'disabled'
        FOR UPDATE
     ), counted AS (
       SELECT id,
              CASE WHEN last_failure_at IS NULL OR last_failure_at < now() - ($3::int * interval '1 millisecond')
                   THEN 1 ELSE consecutive_failures + 1 END AS failures
         FROM current
     )
     UPDATE operators o
        SET consecutive_failures = counted.failures,
            last_failure_at = now(),
            last_error = $2,
            status = CASE WHEN counted.failures >= $4 THEN 'failed' ELSE o.status END,
            down_since = CASE WHEN counted.failures >= $4 THEN now() ELSE o.down_since END
       FROM counted
      WHERE o.id = counted.id
      RETURNING o.consecutive_failures, o.status`,
    [operatorId, resultDesc.slice(0, 500), FAILURE_WINDOW_MS, FAILURES_BEFORE_DOWN],
  );
  const row = rows[0];
  if (!row) return false;
  await events.publish('operator.updated', { operatorId, status: row.status, consecutiveFailures: row.consecutive_failures });
  return true;
}

/**
 * Any success clears the guard: Safaricom accepting a probe (what the Reinstate button calls), or a
 * request of this operator settling successfully. Both callers use this one helper so the count can
 * never outlive the failure it counted.
 */
export async function clearOperatorFailures(db: Db, operatorId: string | null): Promise<void> {
  if (!operatorId) return;
  await db.query(`UPDATE operators SET consecutive_failures=0, last_failure_at=NULL, down_since=NULL WHERE id=$1`, [operatorId]);
}
