import type { RequestHandler } from 'express';
import type { Db } from '../db/pool.js';
import { hit } from '../util/rateLimit.js';
import { HttpError } from '../util/errors.js';
import { clientIp } from '../util/ip.js';

export const TOO_FAST = 'Too fast. Wait a moment and try again.';
export const MUTATIONS_PER_MINUTE = 120;
export const SAFARICOM_PER_MINUTE = 30;
export const ANON_PER_MINUTE = 60;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The routes that make Safaricom do work for this organisation, as paths **relative to the `/api`
 * mount** (both limiters are mounted with `app.use('/api', …)`, so Express has already stripped the
 * prefix from `req.path`). Adding a route that calls Safaricom means adding it here; nothing else in
 * the codebase knows this list, and `server/test/rate-limit.test.ts` walks every entry.
 */
const SAFARICOM_PATHS: RegExp[] = [
  /^\/send(\/|$)/,                                    // POST /api/send/phone
  /^\/balances\/refresh$/,                            // POST /api/balances/refresh
  /^\/lookup\/?$/,                                    // POST /api/lookup
  /^\/requests\/[^/]+\/check$/,                       // POST /api/requests/:id/check
  /^\/settings\/environments\/[^/]+\/(daraja|shortcode|operators)$/,
  /^\/settings\/operators\/[^/]+\/(probe|rotate)$/,
  /^\/settings\/public-url\/test$/,
  /^\/setup\/(daraja|shortcode|operator)$/,
  /^\/setup\/public-url\/test$/,
  /^\/signup\/(daraja|shortcode|operator)$/,
  /^\/auth\/recover\/start$/,                         // POST /api/auth/recover/start
];

/**
 * True when `path` (relative to the `/api` mount) reaches Safaricom. Express matches routes
 * case-insensitively but hands `req.path` back in whatever case the caller sent — `case sensitive
 * routing` is never enabled in `buildApp` — so `/api/LOOKUP` reaches the same route `/api/lookup`
 * does. Every pattern above is written lowercase, so the comparison lowercases `path` first rather
 * than trusting the caller's case; the `[^/]+` id segments are unaffected either way.
 */
export function isSafaricomPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SAFARICOM_PATHS.some((re) => re.test(lower));
}

function limiter(db: Db, key: (orgId: string) => string, max: number, windowSeconds: number, applies: (path: string, method: string) => boolean): RequestHandler {
  return (req, res, next) => {
    const orgId = req.org?.id;
    // Anonymous routes have no organisation to bill: login, sign-up start and recovery start carry
    // their own per-address and per-username limits instead (spec 8.3).
    if (!orgId || !applies(req.path, req.method)) return next();
    hit(db, key(orgId), max, windowSeconds)
      .then((state) => {
        if (!state.exceeded) return next();
        res.setHeader('Retry-After', String(state.retryAfterSeconds));
        next(new HttpError(429, 'too_fast', TOO_FAST));
      })
      // A database that cannot count cannot serve the route either — this fails closed on purpose.
      .catch(next);
  };
}

/** Every non-GET call under `/api`, per organisation: 120 a minute. Spec 8.3. */
export function limitMutations(deps: { db: Db }): RequestHandler {
  return limiter(deps.db, (orgId) => `org:${orgId}:mutations`, MUTATIONS_PER_MINUTE, 60, (_path, method) => !READ_METHODS.has(method));
}

/** The routes above, per organisation: 30 a minute. Spec 8.3. */
export function limitSafaricom(deps: { db: Db }): RequestHandler {
  return limiter(deps.db, (orgId) => `org:${orgId}:safaricom`, SAFARICOM_PER_MINUTE, 60, (path, method) => !READ_METHODS.has(method) && isSafaricomPath(path));
}

/**
 * Every non-GET call under `/api` with no organisation in scope, per address: 60 a minute. Login,
 * sign-up start and the host's own owner setup carry their own, narrower limits already (a lockout,
 * an hourly/daily sign-up budget); this bucket is metered on top of those, not instead of them, so
 * an unauthenticated flood against any one of them still costs something before its own check runs.
 */
export function limitAnonymous(deps: { db: Db }): RequestHandler {
  return (req, res, next) => {
    if (req.org || READ_METHODS.has(req.method)) return next();
    hit(deps.db, `anon:ip:${clientIp(req)}`, ANON_PER_MINUTE, 60)
      .then((state) => {
        if (!state.exceeded) return next();
        res.setHeader('Retry-After', String(state.retryAfterSeconds));
        next(new HttpError(429, 'too_fast', TOO_FAST));
      })
      .catch(next);
  };
}
