import type { PoolClient } from 'pg';
import type { Db } from './pool.js';
import { currentOrgId } from './pool.js';

export interface Job { id: string; kind: string; payload: unknown; attempts: number; max_attempts: number; recurring: boolean }

const INSERT_JOB = `INSERT INTO jobs(kind, payload, run_at, max_attempts) VALUES ($1, $2::jsonb, COALESCE($3, now()), $4) RETURNING id`;

export async function enqueue(db: Db, kind: string, payload: unknown, opts: { runAt?: Date; maxAttempts?: number } = {}): Promise<string> {
  const rows = await db.query<{ id: string }>(INSERT_JOB, jobParams(kind, payload, opts));
  return rows[0].id;
}

/**
 * `enqueue` on the caller's own transaction client, so the job row commits in the same
 * transaction as the state it belongs to (billing's payment timeout, spec 7.3 step 3).
 */
export async function enqueueOn(c: PoolClient, kind: string, payload: unknown, opts: { runAt?: Date; maxAttempts?: number } = {}): Promise<string> {
  const r = await c.query<{ id: string }>(INSERT_JOB, jobParams(kind, payload, opts));
  return r.rows[0].id;
}

/**
 * Every one-shot job belongs to the organisation that created it, and the loop runs it inside
 * that organisation. Enqueued outside one, the stamp is null and the loop refuses the job rather
 * than running it against whatever context it happens to find. Every call site passes an object.
 */
function jobParams(kind: string, payload: unknown, opts: { runAt?: Date; maxAttempts?: number }): [string, string, Date | null, number] {
  const base = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const stamped = { ...base, orgId: currentOrgId() };
  return [kind, JSON.stringify(stamped), opts.runAt ?? null, opts.maxAttempts ?? 5];
}

export async function claim(db: Db, workerId: string): Promise<Job | null> {
  const rows = await db.query<Job>(
    `WITH next AS (
       SELECT id FROM jobs
       WHERE done_at IS NULL AND run_at <= now()
         AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
       ORDER BY run_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     UPDATE jobs j SET locked_by=$1, locked_at=now(), attempts = j.attempts + 1
     FROM next WHERE j.id = next.id
     RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts, j.recurring`,
    [workerId],
  );
  return rows[0] ?? null;
}

export async function complete(db: Db, id: string): Promise<void> {
  await db.query('UPDATE jobs SET done_at=now(), locked_by=NULL, locked_at=NULL WHERE id=$1', [id]);
}

/** Record a failure. `attempts` was already counted by claim(); at the cap the job is done. */
export async function fail(db: Db, id: string, error: string): Promise<void> {
  await db.query(
    `UPDATE jobs SET error = $2, locked_by=NULL, locked_at=NULL,
       done_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
       run_at  = CASE WHEN attempts >= max_attempts THEN run_at ELSE now() + (power(2, attempts) || ' minutes')::interval END
     WHERE id=$1`,
    [id, error.slice(0, 2000)],
  );
}

/** A failure retrying cannot fix. Done immediately, no backoff, no second attempt. */
export async function failFinal(db: Db, id: string, error: string): Promise<void> {
  await db.query('UPDATE jobs SET error=$2, locked_by=NULL, locked_at=NULL, done_at=now() WHERE id=$1', [id, error.slice(0, 2000)]);
}

/** Re-arm a recurring job for its next slot (payload.everySeconds, default 300s if absent). Never sets done_at or leaves run_at NULL. */
export async function rearm(db: Db, id: string, error: string | null = null): Promise<void> {
  await db.query(
    `UPDATE jobs SET run_at = now() + (COALESCE((payload->>'everySeconds')::int, 300) || ' seconds')::interval,
       locked_by=NULL, locked_at=NULL, attempts=0, error=$2
     WHERE id=$1`,
    [id, error === null ? null : error.slice(0, 2000)],
  );
}

export async function ensureRecurring(db: Db, kind: string, everySeconds: number): Promise<void> {
  // The NOT EXISTS covers the common case cheaply; the partial unique index on
  // jobs(kind) WHERE recurring AND done_at IS NULL (migration 002) plus ON CONFLICT DO
  // NOTHING is what actually closes the race between concurrent callers.
  await db.query(
    `INSERT INTO jobs(kind, payload, run_at, max_attempts, recurring)
     SELECT $1, $2::jsonb, now() + ($3 || ' seconds')::interval, 1, true
     WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind=$1 AND done_at IS NULL)
     ON CONFLICT DO NOTHING`,
    [kind, JSON.stringify({ everySeconds }), String(everySeconds)],
  );
}
