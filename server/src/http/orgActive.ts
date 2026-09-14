import type { RequestHandler } from 'express';
import { HttpError } from '../util/errors.js';

export const ORG_SUSPENDED = 'This organisation is read-only. Nothing has been deleted. Contact the service administrator to restore access.';
export const ORG_CLOSED = 'This organisation is closed.';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths a signed-in person must reach whatever state their organisation is in — logging out, changing
 * a password, recovering one, and the one status call the browser makes before it knows whether it
 * has a session at all. Relative to the `/api` mount, and matched against a lowercased path: Express
 * is not case-sensitive-routing (buildApp never enables it), so `/API/AUTH/logout` reaches the same
 * handler `/api/auth/logout` does and must be exempted the same way rateLimit.ts's isSafaricomPath is.
 *
 * C05: billing is exempt from the *suspended* branch below (spec 6.2), not from the closed one. An
 * organisation that owes money has to reach the billing routes to pay, while a closed one still
 * answers everything with 409. Billing is therefore deliberately not in this list.
 */
const ALWAYS_OPEN = [/^\/auth(\/|$)/, /^\/setup\/status\/?$/];

/**
 * Spec 6.2. This install's one organisation is created `pending` by the boot pass and nothing ever
 * moves it until the setup wizard finishes — treating `pending` as blocked would lock a self-hoster
 * out of their own setup. Only `suspended` and `closed` are enforced here. Anonymous requests pass
 * straight through — the routes that serve them resolve their own organisation.
 */
export function requireOrgActive(): RequestHandler {
  return (req, _res, next) => {
    const org = req.org;
    if (!org) return next();
    const path = req.path.toLowerCase();
    if (ALWAYS_OPEN.some((re) => re.test(path))) return next();
    if (org.status === 'closed') return next(new HttpError(409, 'org_closed', ORG_CLOSED));
    if (org.status === 'suspended') {
      // Reads keep working: History, Balances and Lookup all render, and only Send is refused.
      if (READ_METHODS.has(req.method)) return next();
      return next(new HttpError(409, 'org_suspended', ORG_SUSPENDED));
    }
    next();
  };
}
