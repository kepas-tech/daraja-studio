import type { RequestHandler } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import type { Settings } from '../settings/store.js';
import { requireHttps } from '../auth/middleware.js';
import { HttpError } from '../util/errors.js';
import { NO_OPERATOR_MESSAGE } from '../sdk/client.js';
import { ORG_CLOSED, ORG_SUSPENDED } from '../http/orgActive.js';

export const NO_OPERATOR = NO_OPERATOR_MESSAGE;
export const PUBLIC_URL_UNVERIFIED = 'Test your public address in Settings first.';

/**
 * Money features need: https (production only), a tested public address (callbacks can land), and
 * one verified API operator (Safaricom will accept the initiator). Runs before requireStepUp so a
 * password is never consumed by a request that could not have moved money anyway.
 *
 * `requireOrgActive` already refuses a suspended or closed organisation earlier in the chain; this
 * is the belt to its braces, and it is what protects a route mounted without it — so it reports the
 * same two reasons `requireOrgActive` would, never inventing a third.
 */
export function requireMoneyReady(deps: { config: Config; settings: Settings; db: Db }): RequestHandler {
  const https = requireHttps(deps.config);
  return (req, res, next) => {
    https(req, res, async (err?: unknown) => {
      if (err) return next(err);
      try {
        const status = req.org?.status;
        if (status === 'closed') throw new HttpError(409, 'org_closed', ORG_CLOSED);
        if (status === 'suspended') throw new HttpError(409, 'org_suspended', ORG_SUSPENDED);
        if (!(await deps.settings.get('public.verifiedAt'))) throw new HttpError(409, 'public_url_unverified', PUBLIC_URL_UNVERIFIED);
        const mode = (await deps.settings.get('daraja.environment')) || 'sandbox';
        const ok = await deps.db.query(`SELECT 1 FROM operators WHERE status='verified' AND environment=$1 LIMIT 1`, [mode]);
        if (ok.length === 0) throw new HttpError(409, 'no_operator', NO_OPERATOR);
        next();
      } catch (e) { next(e); }
    });
  };
}
