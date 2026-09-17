import type { Db } from '../db/pool.js';

/**
 * Brief 2, item 2: the three states that mean something is wrong, read from what Studio already
 * keeps. Nothing here changes anything and nothing is cached, so each condition clears itself the
 * moment the state behind it does — which is what lets the Home banner disappear on its own.
 */

/**
 * How long a pending send may sit with no answer at all before the banner says so. The sweep
 * resolves most sends within about two minutes, so ten quiet minutes are worth saying out loud.
 */
export const QUIET_MINUTES = 10;

export type ProblemKind = 'operator_down' | 'no_callback' | 'balance_refused';

/** The specifics behind a sentence. The server sends these to the owner alone. */
export interface ProblemDetail {
  /** The operator that stopped working, for operator_down. A name, never a credential. */
  name: string | null;
  /** How long the state has lasted, in whole minutes, or null when it is not a matter of time. */
  minutes: number | null;
}

export interface Problem { kind: ProblemKind; detail: ProblemDetail | null }

export interface ProblemService {
  /** `owner` decides whether the specifics ride along; the sentences are for everybody. */
  list(owner: boolean): Promise<Problem[]>;
}

const minutesSince = (at: Date | null): number | null =>
  (at ? Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000)) : null);

export function createProblemService(deps: { db: Db }): ProblemService {
  return {
    async list(owner) {
      const out: Problem[] = [];
      const detail = (name: string | null, minutes: number | null): ProblemDetail | null =>
        (owner ? { name, minutes } : null);

      // 1. An operator that went DOWN. Feature 8 already records it and the Settings page offers
      //    Reinstate; this only says so where the owner starts their day.
      const [down] = await deps.db.query<{ name: string; at: Date | null }>(
        `SELECT name, COALESCE(down_since, last_failure_at, last_probe_at) AS at FROM operators
          WHERE status = 'failed' ORDER BY at NULLS LAST, priority LIMIT 1`);
      if (down) out.push({ kind: 'operator_down', detail: detail(down.name, minutesSince(down.at)) });

      // 2. Sends are pending and Safaricom has gone quiet. Both halves matter: a quiet hour with
      //    nothing pending is just a quiet hour, and a send made a minute ago has not waited.
      const [pending] = await deps.db.query<{ n: number; oldest: Date | null }>(
        `SELECT count(*)::int AS n, min(sent_at) AS oldest FROM requests
          WHERE status='sent' AND sent_at IS NOT NULL AND sent_at < now() - make_interval(mins => $1::int)`,
        [QUIET_MINUTES]);
      if (pending.n > 0 && pending.oldest) {
        const [cb] = await deps.db.query<{ at: Date | null }>(`SELECT max(received_at) AS at FROM callbacks_raw`);
        const quiet = !cb.at || Date.now() - cb.at.getTime() > QUIET_MINUTES * 60_000;
        if (quiet) {
          out.push({ kind: 'no_callback', detail: detail(null, minutesSince(cb.at ?? pending.oldest)) });
        }
      }

      // 3. The last balance query was refused. Only the newest row counts, so a later success — or
      //    a later query still running — clears the banner without anybody doing anything.
      const [bal] = await deps.db.query<{ status: string; at: Date | null }>(
        `SELECT status, COALESCE(result_at, sent_at) AS at FROM requests
          WHERE type='balance' AND subtype IS DISTINCT FROM 'operator_probe'
          ORDER BY created_at DESC LIMIT 1`);
      if (bal && bal.status === 'failed') out.push({ kind: 'balance_refused', detail: detail(null, minutesSince(bal.at)) });

      return out;
    },
  };
}
