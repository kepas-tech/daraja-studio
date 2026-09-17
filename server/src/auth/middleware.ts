import type { RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/pool.js';
import type { Config } from '../config.js';
import type { OrgView } from '../orgs/service.js';
import { HttpError } from '../util/errors.js';
import { verifyPassword } from './password.js';
import { clearFailures, recordAttempt } from './lockout.js';
import { checkPin } from './pin.js';

export type PersonRole = 'owner' | 'operator' | 'viewer' | 'approver' | 'custom';

export interface Person {
  id: string; username: string; display_name: string; is_owner: boolean;
  status: 'active' | 'suspended'; must_change_password: boolean;
  /** The login address, when one was given. */
  email: string | null;
  role: PersonRole;
  /** Kept for schema compatibility; there is no host console here for it to mean anything. */
  is_host_admin: boolean;
}

// The `declare module 'express-serve-static-core'` augmentation doesn't resolve under
// this repo's strict pnpm layout: express-serve-static-core's types aren't hoisted as a
// directly-resolvable module from server/, so NodeNext module resolution can't find it for a
// module augmentation. @types/express-serve-static-core itself opens `Express.Request` inside
// `declare global`, so augmenting that global namespace (the documented Express pattern) works
// without needing the module to resolve.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- required to augment Express's ambient Request type
  namespace Express {
    interface Request {
      person?: Person; personHash?: string; sessionId?: string; csrf?: string; rawBody?: string;
      org?: OrgView; authProblem?: string;
      /** The optional PIN's hash, kept off request.person so it can never be serialised (brief 2, item 3). */
      personPinHash?: string | null;
      /** A PIN is set and this session has not been unlocked recently: actions wait. */
      pinLocked?: boolean;
    }
  }
}

/**
 * orgContext has already resolved the session, the person and the organisation, so this is a
 * check. The Db parameter is kept so the eight route modules that call requireAuth(deps.db)
 * do not have to change.
 */
export function requireAuth(db: Db): RequestHandler {
  void db;
  return (req, _res, next) => {
    if (req.person) return next();
    next(new HttpError(401, 'not_logged_in', req.authProblem ?? 'Please log in.'));
  };
}

/** A temporary password proves identity only far enough to choose a private password. */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (!req.person?.must_change_password) return next();
  const path = req.path.toLowerCase().replace(/\/+$/, '');
  const read = ['GET', 'HEAD'].includes(req.method);
  if (read && ['/auth/me', '/setup/status'].includes(path)) return next();
  if (req.method === 'POST' && ['/auth/login', '/auth/logout', '/auth/change-password'].includes(path)) return next();
  next(new HttpError(403, 'password_change_required', 'Choose your own password before using Studio.'));
};


export const requireCsrf: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token');
  if (!req.csrf || !sent) return next(new HttpError(403, 'csrf', 'This form has expired. Reload the page and try again.'));
  const a = Buffer.from(sent);
  const b = Buffer.from(req.csrf);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new HttpError(403, 'csrf', 'This form has expired. Reload the page and try again.'));
  }
  next();
};

export const requireOwner: RequestHandler = (req, _res, next) => {
  if (!req.person?.is_owner) return next(new HttpError(403, 'owner_only', 'Only the owner can do this.'));
  next();
};

/**
 * Spec 6.1 and 6.3. The host console belongs to people inside the host organisation who carry the
 * flag, and to nobody else. Everybody else gets 404, not 403: this is not part of the product a
 * tenant can see, and a 403 would confirm it is there. `app.use('/api', notFound)` answers a
 * non-existent path exactly the same way, so the two cannot be told apart.
 */
export const requireHostAdmin: RequestHandler = (req, _res, next) => {
  if (req.person?.is_host_admin === true && req.org?.isHost === true) return next();
  next(new HttpError(404, 'not_found', 'Not found.'));
};

/**
 * The confirmation in front of anything that moves money or changes who can: the owner's own
 * password, or — once a PIN is set (brief 2, item 3) — that PIN, which is what makes a phone
 * bearable to use. While the session is locked, nothing here runs at all: the caller has to enter
 * the PIN first, so a phone picked up off a table cannot spend by sending a password it does not have.
 */
export function requireStepUp(db: Db): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (req.pinLocked) throw new HttpError(423, 'session_locked', 'Enter your PIN to continue.');
      const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
      if (req.personPinHash && pin) {
        await checkPin(db, req.person!.id, req.personPinHash, pin);
        delete req.body.pin;
        return next();
      }
      const key = `stepup:${req.person!.id}`;
      const attempt = await recordAttempt(db, [key]);
      if (attempt.lockedUntil && attempt.lockedUntil > new Date()) {
        throw new HttpError(423, 'locked', 'Too many wrong tries. Wait 15 minutes and try again.');
      }
      const pw = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!req.personHash || !pw || !(await verifyPassword(req.personHash, pw))) {
        throw new HttpError(403, 'step_up_required', 'Enter your own password to confirm.');
      }
      await clearFailures(db, [key]);
      delete req.body.password;
      // A stray one must never reach a route handler, where a schema might carry it onward.
      delete req.body.pin;
      next();
    } catch (e) { next(e); }
  };
}

/**
 * The lock's gate on its own, for the actions that never ask for a password: asking a payer's phone
 * for money, a standing order, an express checkout, a Bonga redemption. Reads are not gated — the
 * lock is about what a hand that is not yours could do, not about what it could see.
 */
export const requireUnlocked: RequestHandler = (req, _res, next) => {
  if (req.pinLocked) return next(new HttpError(423, 'session_locked', 'Enter your PIN to continue.'));
  next();
};

export function requireHttps(config: Config): RequestHandler {
  return (req, _res, next) => {
    if (config.nodeEnv !== 'production') return next();
    // req.secure already honours X-Forwarded-Proto, but only from a hop Express's own
    // `trust proxy` setting trusts. Trusting the raw header directly here would let any direct
    // client satisfy this guard over plaintext with one header, and mishandles chained proxies.
    if (req.secure) return next();
    next(new HttpError(403, 'https_required', 'This action needs a secure (https) address.'));
  };
}
