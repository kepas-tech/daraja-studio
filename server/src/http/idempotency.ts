import type { RequestHandler } from 'express';
import type { Db } from '../db/pool.js';
import { HttpError } from '../util/errors.js';

/**
 * The Stripe shape for a write, written once and used by every route that makes or releases money.
 *
 * A caller sends `Idempotency-Key: <its own string>`. The first call runs and its answer is kept;
 * a retry with the same key — after a timeout, after a dropped connection, after a deploy — is
 * answered with that same status and that same body, and never makes a second payment. The
 * namespace is the organisation and the route, so the same key on two different writes is two
 * different requests, which is what a caller expects.
 *
 * Three details are borrowed from Stripe because an integration already knows them:
 *
 *   - the header is `Idempotency-Key`, and a replay says so with `Idempotent-Replay: true`;
 *   - a key lives twenty-four hours, after which the row is cleared and the key may be used again;
 *   - a second call with a key whose first call is still running is refused with 409 rather than
 *     run beside it, which is the whole point: two payments from one key is the failure this exists
 *     to prevent. A claim older than a minute is treated as abandoned — the process that made it is
 *     gone — and is taken over, so a crash cannot hold a key for a day.
 *
 * Nothing is stored for a 5xx: the caller should be able to try again, and a server fault is not an
 * answer. Everything else is kept, including a refusal — a caller that retries a bad request with
 * the same key gets the same refusal, and a caller that meant something different sends a new key.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAY_HEADER = 'Idempotent-Replay';
/** Stripe's ceiling, and refused rather than truncated: a shortened key is a different key, and two
 *  different requests would silently share one answer. */
export const KEY_MAX = 255;
export const IN_PROGRESS = 'A request with that Idempotency-Key is already running. Wait for its answer rather than sending it again.';
const CLAIM_TIMEOUT_SECONDS = 60;
const CLAIMED = 0;

export function idempotency(deps: { db: Db }, scope: string): RequestHandler {
  return async (req, res, next) => {
    const key = req.get(IDEMPOTENCY_HEADER)?.trim();
    if (!key) return next();
    if (key.length > KEY_MAX) {
      return next(new HttpError(400, 'invalid_key', `An Idempotency-Key is at most ${KEY_MAX} characters.`));
    }

    try {
      // An answer older than the window is gone, and its key is free again.
      await deps.db.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND expires_at < now()', [scope, key]);
      const claimed = await deps.db.query<{ id: string }>(
        `INSERT INTO idempotency_keys(scope, key) VALUES ($1, $2)
         ON CONFLICT (org_id, scope, key) DO NOTHING RETURNING id`,
        [scope, key],
      );
      let id = claimed[0]?.id ?? null;

      if (!id) {
        const [existing] = await deps.db.query<{ id: string; status: number; body: unknown }>(
          'SELECT id, status, body FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key],
        );
        // Gone between the two statements: nothing to replay, so the request runs as an ordinary one.
        if (!existing) return next();
        if (existing.status !== CLAIMED) {
          res.set(REPLAY_HEADER, 'true');
          return res.status(existing.status).json(existing.body);
        }
        const taken = await deps.db.query<{ id: string }>(
          `UPDATE idempotency_keys SET created_at = now() WHERE id = $1 AND status = ${CLAIMED}
             AND created_at < now() - interval '${CLAIM_TIMEOUT_SECONDS} seconds' RETURNING id`,
          [existing.id],
        );
        if (taken.length === 0) return next(new HttpError(409, 'idempotency_in_progress', IN_PROGRESS));
        id = taken[0]!.id;
      }

      const claimId = id;
      const answer = res.json.bind(res);
      res.json = ((body?: unknown) => {
        const store = res.statusCode >= 500
          ? deps.db.query('DELETE FROM idempotency_keys WHERE id = $1', [claimId])
          : deps.db.query('UPDATE idempotency_keys SET status = $2, body = $3::jsonb WHERE id = $1', [claimId, res.statusCode, JSON.stringify(body ?? null)]);
        // The answer goes out either way: a store that failed is a retry that runs twice, which is
        // better than a payment the caller never hears about.
        void store.catch((e) => console.error('idempotency store failed', e instanceof Error ? e.message : e)).then(() => answer(body));
        return res;
      }) as typeof res.json;
      // A connection that dropped before an answer leaves no claim behind. `finish` is the only
      // honest signal of an answer that went out: `close` fires on every response here, finished or
      // not, so a claim released on `close` alone would be released after every success — and the
      // retry it was meant to answer would make a second request.
      let answered = false;
      res.on('finish', () => { answered = true; });
      res.on('close', () => {
        if (!answered) void deps.db.query('DELETE FROM idempotency_keys WHERE id = $1', [claimId]).catch(() => {});
      });
      next();
    } catch (e) { next(e); }
  };
}
