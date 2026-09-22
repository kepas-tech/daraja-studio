import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { withOrg, withSystem } from '../db/pool.js';
import type { Config } from '../config.js';
import { HttpError } from '../util/errors.js';
import { clientIp } from '../util/ip.js';
import { audit } from '../audit/log.js';
import { DUMMY_HASH, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password.js';
import { clearCookieHeader, cookieHeader, createSession, destroySession } from './sessions.js';
import { clearFailures, recordAttempt, retryAfterSeconds } from './lockout.js';
import { checkPin, hashPin, PIN_LENGTH, PIN_PATTERN, pinKey } from './pin.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from './middleware.js';
import type { ModuleService } from '../modules/service.js';

const loginSchema = z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(512) });
const changeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(512) });

/** Migration 008 sets `is_host_admin` on this install's owner, a column that only ever meant
 * anything alongside a host console this product does not have. Always masked to false. */
function maskHostAdmin<T extends { is_host_admin: boolean }>(person: T): T {
  return { ...person, is_host_admin: false };
}

export function authRoutes(db: Db, config: Config, modules: ModuleService): Router {
  const r = Router();

  r.post('/login', async (req, res, next) => {
    try {
      const body = loginSchema.parse(req.body);
      const ip = clientIp(req);
      const keys = [`u:${body.username.toLowerCase()}`, `ip:${ip}`];
      const attempt = await recordAttempt(db, keys);
      if (attempt.lockedUntil && attempt.lockedUntil > new Date()) {
        throw new HttpError(423, 'locked', 'Too many wrong tries. Wait 15 minutes and try again.');
      }
      const rows = await withSystem(() =>
        db.query<{ id: string; org_id: string; password_hash: string; status: string; org_status: string }>(
          `SELECT p.id, p.org_id, p.password_hash, p.status, o.status AS org_status
             FROM people p JOIN orgs o ON o.id = p.org_id
            WHERE lower(p.username) = lower($1)
            ORDER BY p.created_at LIMIT 1`,
          [body.username],
        ),
      );
      const p = rows[0];
      const ok = p ? await verifyPassword(p.password_hash, body.password) : (await verifyPassword(DUMMY_HASH, body.password), false);
      // A closed organisation answers exactly like a wrong password (spec 5.1): there is nothing to
      // enumerate, and its rows have been deleted, so an audit row would be the one visible
      // difference between "closed" and "wrong".
      const orgClosed = p?.org_status === 'closed';
      if (!p || !ok || p.status !== 'active' || orgClosed) {
        // An unknown username belongs to no organisation, and audit_log rows must. The lockout
        // counters above already recorded the attempt, which is what actually stops guessing.
        if (p && !orgClosed) await withOrg(p.org_id, () => audit(db, { action: 'auth.login_failed', target: body.username, ip }));
        throw new HttpError(401, 'bad_login', 'Wrong username or password.');
      }
      await withOrg(p.org_id, async () => {
        await clearFailures(db, keys);
        const s = await createSession(db, p.id, ip, req.get('user-agent') ?? '');
        await db.query('UPDATE people SET last_login_at=now() WHERE id=$1', [p.id]);
        await audit(db, { personId: p.id, action: 'auth.login', ip });
        const person = (await db.query<{ id: string; username: string; display_name: string; is_owner: boolean; status: string; must_change_password: boolean; email: string | null; role: string; is_host_admin: boolean }>(
          'SELECT id, username, display_name, is_owner, status, must_change_password, email, role, is_host_admin FROM people WHERE id=$1', [p.id]))[0];
        res.setHeader('Set-Cookie', cookieHeader(s.id, config.nodeEnv === 'production'));
        res.json({ person: maskHostAdmin(person), csrf: s.csrf });
      });
    } catch (e) { next(e instanceof z.ZodError ? new HttpError(400, 'invalid', 'Enter a username and password.') : e); }
  });

  r.get('/me', requireAuth(db), async (req, res, next) => {
    try {
      const perms = await db.query<{ permission: string }>('SELECT permission FROM permissions WHERE person_id=$1', [req.person!.id]);
      const org = req.org!;
      // RLS already scopes this to the caller's organisation (orgContext has entered it), but the
      // explicit org_id predicate is the store's own convention (settings/store.ts) and the one that
      // still holds against an admin pool, which bypasses RLS entirely.
      const environment = (await db.query<{ value: string }>(
        `SELECT value FROM settings WHERE org_id=$1 AND key='daraja.environment'`, [org.id],
      ))[0]?.value ?? 'sandbox';
      // Spec 9: Settings › Organisation shows when this organisation signed up and when Safaricom
      // verified it. Both are facts about the caller's own row — org_self already scopes the read,
      // and the explicit id predicate is this file's own convention.
      const [dates] = await db.query<{ created_at: Date; verified_at: Date | null }>(
        'SELECT created_at, verified_at FROM orgs WHERE id=$1', [org.id],
      );
      // Home shows the shortcode of the environment in use and the name Safaricom itself holds for
      // it (recorded when the shortcode was checked), not just the name the owner typed.
      const slot = await db.query<{ key: string; value: string }>(
        `SELECT key, value FROM settings WHERE org_id=$1 AND key IN ($2, $3, $4) AND encrypted = false`, [org.id, `env.${environment}.shortcode`, `env.${environment}.safaricomName`, `env.${environment}.shortcodeKind`],
      );
      const slotOf = (k: string) => slot.find((r) => r.key === `env.${environment}.${k}`)?.value ?? null;
      const [operator] = await db.query<{ name: string }>(`SELECT name FROM operators WHERE org_id=$1 AND environment=$2 AND status='verified' ORDER BY priority ASC, created_at ASC LIMIT 1`, [org.id, environment]);
      // Brief 2, item 5b: whether this person has a fingerprint enrolled, and whether this install
      // can offer one at all. Two booleans, never an identifier.
      const [bio] = await db.query<{ one: number }>('SELECT 1 AS one FROM webauthn_credentials WHERE person_id=$1 LIMIT 1', [req.person!.id]);
      // Step one of the tiers-and-modules design: the menu builder's half of the one answer. Nobody
      // is asked to make a call whose module is off, and the nav hides the entry it would open.
      const moduleState = await modules.state();
      res.json({
        person: maskHostAdmin(req.person!),
        csrf: req.csrf,
        permissions: perms.map((p) => p.permission),
        // Brief 2, item 3. Only these two facts about the PIN ever leave the server: whether one is
        // set, and whether this session is waiting for it. Never the hash, never the PIN.
        pin: { set: req.personPinHash != null, locked: req.pinLocked === true, bio: config.publicUrl != null && !!bio },
        modules: {
          off: moduleState.modules.filter((m) => !m.on).map((m) => m.key),
          /** The menu entries to leave out, named by the web's own nav keys. */
          menuOff: moduleState.modules.filter((m) => !m.on).flatMap((m) => m.menu),
          /**
           * Step six, part six: the tier the switched-on parts actually equal, or null when they
           * equal none because something was switched by hand. The top bar's mode tag reads this,
           * never the stored choice, so it says what the studio is rather than what was asked for.
           */
          tier: moduleState.matches,
        },
        // Spec 5.1. `slug` is deliberately absent: it is a host-admin handle, not a tenant's.
        org: {
          id: org.id, name: org.name, status: org.status, environment,
          isHost: org.isHost, suspendReason: org.suspendReason,
          createdAt: dates?.created_at.toISOString() ?? null,
          verifiedAt: dates?.verified_at?.toISOString() ?? null,
          shortcode: slotOf('shortcode'), safaricomName: slotOf('safaricomName'), shortcodeKind: slotOf('shortcodeKind'), operatorName: operator?.name ?? null,
        },
        // Migration 008 sets is_host_admin on this install's owner, but there is no host console
        // here for it to mean anything — always false.
        hostAdmin: false,
      });
    } catch (e) { next(e); }
  });

  r.post('/logout', requireAuth(db), requireCsrf, async (req, res, next) => {
    try {
      await destroySession(db, req.sessionId!);
      res.setHeader('Set-Cookie', clearCookieHeader());
      res.status(204).end();
    } catch (e) { next(e); }
  });

  /**
   * Feature 12: every session this person holds, on every device, including the one asking. The
   * route the app already has for a password change signs the others out; this one exists for the
   * owner who thinks a session on a lost or shared phone is still open. It takes the password
   * (requireStepUp), so a borrowed screen cannot end somebody else's session, and it clears this
   * browser's cookie so the tab lands on the login page rather than on a 401 loop.
   */
  r.post('/sign-out-everywhere', requireAuth(db), requireCsrf, requireStepUp(db), async (req, res, next) => {
    try {
      await db.query('DELETE FROM sessions WHERE person_id=$1', [req.person!.id]);
      await audit(db, { personId: req.person!.id, action: 'auth.signed_out_everywhere', ip: clientIp(req) });
      res.setHeader('Set-Cookie', clearCookieHeader());
      res.status(204).end();
    } catch (e) { next(e); }
  });

  /**
   * Brief 2, item 3: the PIN lock. Owner only, because the phone that carries Studio is the owner's.
   * Setting one takes the password (requireStepUp) and the PIN is hashed with the same argon2id as a
   * password: it is never stored, never logged and never written into an audit row — the audit says
   * only that one was set, and when.
   */
  r.put('/pin', requireAuth(db), requireCsrf, requireOwner, requireStepUp(db), async (req, res, next) => {
    try {
      const newPin = typeof req.body?.newPin === 'string' ? req.body.newPin.trim() : '';
      if (!PIN_PATTERN.test(newPin)) throw new HttpError(400, 'invalid', `A PIN is exactly ${PIN_LENGTH} digits.`);
      await db.query('UPDATE people SET pin_hash=$2, pin_set_at=now() WHERE id=$1', [req.person!.id, await hashPin(newPin)]);
      // The session that just proved the password may use the new PIN straight away.
      await db.query('UPDATE sessions SET pin_entered_at = now() WHERE id=$1', [req.sessionId]);
      await audit(db, { personId: req.person!.id, action: 'auth.pin_set', ip: clientIp(req) });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.delete('/pin', requireAuth(db), requireCsrf, requireOwner, requireStepUp(db), async (req, res, next) => {
    try {
      await db.query('UPDATE people SET pin_hash=NULL, pin_set_at=NULL WHERE id=$1', [req.person!.id]);
      // The fingerprints exist to open a PIN lock, so they go with it: no credential outlives the
      // thing it opens (brief 2, item 5b).
      await db.query('DELETE FROM webauthn_credentials WHERE person_id=$1', [req.person!.id]);
      await clearFailures(db, [pinKey(req.person!.id)]);
      await audit(db, { personId: req.person!.id, action: 'auth.pin_removed', ip: clientIp(req) });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  /**
   * This is its own route because it is the one action a locked session may take. The PIN is
   * counted and locks after five wrong tries; the password is always the way back in for a forgotten
   * PIN, counted on the password's own key so a phone left alone cannot be walked into either.
   */
  r.post('/open', requireAuth(db), requireCsrf, async (req, res, next) => {
    try {
      const pw = typeof req.body?.password === 'string' ? req.body.password : '';
      const pin = typeof req.body?.pin === 'string' ? req.body.pin : '';
      if (pw) {
        const key = `stepup:${req.person!.id}`;
        const attempt = await recordAttempt(db, [key]);
        if (attempt.lockedUntil && attempt.lockedUntil > new Date()) {
          throw new HttpError(423, 'locked', 'Too many wrong tries. Wait 15 minutes and try again.', { retryAfterSec: retryAfterSeconds(attempt.lockedUntil) });
        }
        if (!req.personHash || !(await verifyPassword(req.personHash, pw))) throw new HttpError(403, 'step_up_required', 'Your password is wrong.');
        await clearFailures(db, [key]);
      } else if (pin && req.personPinHash) {
        await checkPin(db, req.person!.id, req.personPinHash, pin);
      } else {
        throw new HttpError(400, 'invalid', 'Enter your PIN.');
      }
      await db.query('UPDATE sessions SET pin_entered_at = now() WHERE id=$1', [req.sessionId]);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  /**
   * Locking has nothing to prove: it is what a phone put down does, and refusing it would leave the
   * session open. Called when the page goes to the background, on a fresh page load, and after
   * PIN_IDLE_MINUTES without a touch (web/src/app/useLockWatchers.ts).
   */
  r.post('/lock', requireAuth(db), requireCsrf, async (req, res, next) => {
    try {
      await db.query('UPDATE sessions SET pin_entered_at = NULL WHERE id=$1', [req.sessionId]);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.put('/display-name', requireAuth(db), requireCsrf, async (req, res, next) => {
    try {
      const name = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
      if (!name || name.length > 80) throw new HttpError(400, 'invalid', 'Enter a name of up to 80 characters.');
      await db.query('UPDATE people SET display_name = $2 WHERE id = $1', [req.person!.id, name]);
      await audit(db, { personId: req.person!.id, action: 'auth.display_name', after: { displayName: name }, ip: clientIp(req) });
      res.status(204).end();
    } catch (e) { next(e); }
  });
  r.post('/change-password', requireAuth(db), requireCsrf, async (req, res, next) => {
    try {
      const body = changeSchema.parse(req.body);
      const stepUpKey = `stepup:${req.person!.id}`;
      const attempt = await recordAttempt(db, [stepUpKey]);
      if (attempt.lockedUntil && attempt.lockedUntil > new Date()) {
        throw new HttpError(423, 'locked', 'Too many wrong tries. Wait 15 minutes and try again.');
      }
      if (!(await verifyPassword(req.personHash!, body.currentPassword))) throw new HttpError(403, 'step_up_required', 'Your current password is wrong.');
      await clearFailures(db, [stepUpKey]);
      if (body.currentPassword === body.newPassword) throw new HttpError(400, 'password_unchanged', 'Choose a different password from the one you were given.');
      await db.query('UPDATE people SET password_hash=$2, must_change_password=false WHERE id=$1', [req.person!.id, await hashPassword(body.newPassword)]);
      await db.query('DELETE FROM sessions WHERE person_id=$1 AND id<>$2', [req.person!.id, req.sessionId]);
      await audit(db, { personId: req.person!.id, action: 'auth.password_changed', ip: clientIp(req) });
      res.status(204).end();
    } catch (e) { next(e instanceof z.ZodError ? new HttpError(400, 'invalid', `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`) : e); }
  });

  return r;
}
