import type { RequestHandler } from 'express';
import type { Db } from '../db/pool.js';
import { withOrg, withSystem } from '../db/pool.js';
import { loadSessionWithOrg, readCookie, SESSION_COOKIE } from '../auth/sessions.js';
import { isLocked } from '../auth/pin.js';
import type { ApiKeysService } from '../keys/service.js';

/** `Authorization: Bearer <key>`, or null. Nothing about the value is logged or echoed. */
function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * Resolves the organisation once, at the front of the request, and runs everything after it inside
 * that organisation. Anonymous requests pass straight through: the routes that serve them enter
 * their own context. requireAuth is then only a check on what this middleware found.
 *
 * The person's organisation is the authority, not the session row's: a crafted session id can
 * therefore never pick which organisation a request belongs to.
 */
export function orgContext(deps: { db: Db; apiKeys: ApiKeysService }): RequestHandler {
  return (req, _res, next) => {
    const id = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!id) {
      // Round 3, phase E: no cookie, but a key. A key names its own organisation, so this is the one
      // cross-organisation read on the request path besides the session's, and it runs in the same
      // system context for the same reason.
      const token = bearer(req.headers.authorization);
      if (!token) {
        req.authProblem = 'Please log in.';
        return next();
      }
      return withSystem(() => deps.apiKeys.authenticate(token))
        .then((found) => {
          if (!found) {
            req.authProblem = 'That API key is not valid, or it has been revoked.';
            return next();
          }
          return withOrg(found.org.id, async () => {
            // A machine actor, never an owner: `is_owner` stays false so nothing owner-only can be
            // reached with a key, and its permissions are the role's own preset.
            req.person = {
              id: found.keyId, username: 'key-' + found.prefix, display_name: found.name,
              is_owner: false, status: 'active', must_change_password: false,
              email: null, role: 'custom', is_host_admin: false,
            };
            req.apiKey = { keyId: found.keyId, name: found.name, prefix: found.prefix, role: found.role, permissions: found.permissions, businessId: found.businessId };
            req.org = found.org;
            next();
          });
        })
        .catch(next);
    }
    withSystem(() => loadSessionWithOrg(deps.db, id))
      .then((found) => {
        if (!found) {
          req.authProblem = 'Your session has ended. Please log in again.';
          return next();
        }
        if (found.person.status !== 'active') {
          req.authProblem = 'This account is not active.';
          return next();
        }
        req.sessionId = found.session.id;
        req.csrf = found.session.csrf_token;
        // Both hashes stay off request.person: it is handed to route modules and serialised back to
        // the browser by /api/auth/me, and only the fact that a PIN exists may leave the server.
        const { password_hash, pin_hash, ...person } = found.person;
        // Everything downstream — routes, services, jobs enqueued by them — is this organisation.
        return withOrg(found.org.id, async () => {
          req.person = person;
          req.personHash = password_hash;
          req.personPinHash = pin_hash;
          req.pinLocked = isLocked(pin_hash, found.session.pin_fresh);
          req.org = found.org;
          next();
        });
      })
      .catch(next);
  };
}
