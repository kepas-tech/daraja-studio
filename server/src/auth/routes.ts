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
import { clearFailures, recordAttempt } from './lockout.js';
import { requireAuth, requireCsrf } from './middleware.js';

const loginSchema = z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(512) });
const changeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(512) });

/** Migration 008 sets `is_host_admin` on this install's owner, a column that only ever meant
 * anything alongside a host console this product does not have. Always masked to false. */
function maskHostAdmin<T extends { is_host_admin: boolean }>(person: T): T {
  return { ...person, is_host_admin: false };
}

export function authRoutes(db: Db, config: Config): Router {
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
        `SELECT key, value FROM settings WHERE org_id=$1 AND key IN ($2, $3) AND encrypted = false`, [org.id, `env.${environment}.shortcode`, `env.${environment}.safaricomName`],
      );
      const slotOf = (k: string) => slot.find((r) => r.key === `env.${environment}.${k}`)?.value ?? null;
      const [operator] = await db.query<{ name: string }>(`SELECT name FROM operators WHERE org_id=$1 AND environment=$2 AND status='verified' ORDER BY priority ASC, created_at ASC LIMIT 1`, [org.id, environment]);
      res.json({
        person: maskHostAdmin(req.person!),
        csrf: req.csrf,
        permissions: perms.map((p) => p.permission),
        // Spec 5.1. `slug` is deliberately absent: it is a host-admin handle, not a tenant's.
        org: {
          id: org.id, name: org.name, status: org.status, environment,
          isHost: org.isHost, suspendReason: org.suspendReason,
          createdAt: dates?.created_at.toISOString() ?? null,
          verifiedAt: dates?.verified_at?.toISOString() ?? null,
          shortcode: slotOf('shortcode'), safaricomName: slotOf('safaricomName'), operatorName: operator?.name ?? null,
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
