import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { PersonRole } from '../auth/middleware.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from '../auth/middleware.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { ASSIGNABLE_ROLES, applyRole } from '../permissions/roles.js';
import { audit } from '../audit/log.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { withSystem } from '../db/pool.js';

export interface PersonView {
  id: string; username: string; displayName: string; email: string | null;
  role: PersonRole; status: 'active' | 'suspended'; isOwner: boolean; isHostAdmin: boolean;
  mustChangePassword: boolean; createdAt: string; lastLoginAt: string | null;
}

interface PersonRow {
  id: string; username: string; display_name: string; email: string | null;
  role: PersonRole; status: 'active' | 'suspended'; is_owner: boolean; is_host_admin: boolean;
  must_change_password: boolean; created_at: Date; last_login_at: Date | null;
}

const SELECT = `SELECT id, username, display_name, email, role, status, is_owner, is_host_admin, must_change_password, created_at, last_login_at FROM people`;

/**
 * Masks `is_host_admin` exactly as auth/routes.ts's maskHostAdmin does: migration 008 sets the
 * column on this install's owner, but there is no host console here for it to mean anything.
 */
function toView(r: PersonRow): PersonView {
  return {
    id: r.id, username: r.username, displayName: r.display_name, email: r.email,
    role: r.role, status: r.status, isOwner: r.is_owner,
    isHostAdmin: false,
    mustChangePassword: r.must_change_password,
    createdAt: r.created_at.toISOString(), lastLoginAt: r.last_login_at?.toISOString() ?? null,
  };
}

// A username is either a plain name (single mode, as it always was) or an e-mail address. Hosted
// mode requires the address: it is how a person logs in, and it is unique install-wide (spec 5.1).
const PLAIN_USERNAME = /^[a-z0-9_.-]{3,32}$/i;
// The same validator sign-up uses (signup/routes.ts), not a hand-rolled regex.
const EMAIL_SCHEMA = z.string().email();
const isEmailAddress = (s: string) => EMAIL_SCHEMA.safeParse(s).success;

const createSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  username: z.string().trim().toLowerCase().min(3).max(200),
  role: z.enum(ASSIGNABLE_ROLES),
  temporaryPassword: z.string().min(MIN_PASSWORD_LENGTH).max(512),
});
const roleSchema = z.object({ role: z.enum(ASSIGNABLE_ROLES) });
const resetSchema = z.object({ temporaryPassword: z.string().min(MIN_PASSWORD_LENGTH).max(512) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

const UNIQUE_VIOLATION = '23505';
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const USERNAME_TAKEN = 'Somebody on this service already uses that name or address.';

/**
 * Spec 5.3. Everything here runs inside the caller's organisation (orgContext put it there), so
 * row-level security already keeps one organisation's owner out of another's people; the explicit
 * `org_id` predicates below are the stores' own defence-in-depth convention (settings/store.ts),
 * not the only thing enforcing it.
 */
export function peopleRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf);
  const stepUp = requireStepUp(deps.db);

  const canReadPeople: RequestHandler = (req, _res, next) => {
    if (req.person?.is_owner) return next();
    next(new HttpError(403, 'owner_only', 'Only the owner can do this.'));
  };
  const actor = (req: Parameters<typeof clientIp>[0] & { person?: { id: string } }) => ({ personId: req.person?.id ?? null, ip: clientIp(req) });

  /** The target of a write: must exist in this organisation, and must never be the owner. */
  async function target(id: string, orgId: string): Promise<PersonRow> {
    if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That person does not exist.');
    const [row] = await deps.db.query<PersonRow>(`${SELECT} WHERE id = $1 AND org_id = $2`, [id, orgId]);
    if (!row) throw new HttpError(404, 'not_found', 'That person does not exist.');
    if (row.is_owner) throw new HttpError(400, 'not_the_owner', 'The owner cannot be changed here.');
    return row;
  }

  r.get('/', canReadPeople, async (req, res, next) => {
    try {
      const rows = await deps.db.query<PersonRow>(`${SELECT} WHERE org_id = $1 ORDER BY is_owner DESC, display_name ASC`, [req.org!.id]);
      res.json(rows.map((r) => toView(r)));
    } catch (e) { next(e); }
  });

  r.post('/', requireOwner, stepUp, async (req, res, next) => {
    try {
      const b = parse(createSchema, req.body);
      const isEmail = isEmailAddress(b.username);
      if (!isEmail && !PLAIN_USERNAME.test(b.username)) {
        throw new HttpError(400, 'invalid', 'A username is 3 to 32 letters, numbers, dots, dashes or underscores — or an e-mail address.');
      }
      // A friendly, early check — usernames are unique install-wide, not just in this organisation,
      // so this has to look across every organisation, which is exactly what withSystem is for.
      // The unique index (migration 009) is what actually stops a race between two such checks.
      const dup = await withSystem(() => deps.db.query<{ one: number }>('SELECT 1 AS one FROM people WHERE lower(username) = lower($1)', [b.username]));
      if (dup.length > 0) throw new HttpError(409, 'username_taken', USERNAME_TAKEN);

      const passwordHash = await hashPassword(b.temporaryPassword);
      let row: PersonRow;
      try {
        row = await deps.db.tx(async (c) => {
          const { rows } = await c.query<PersonRow>(
            `INSERT INTO people(username, display_name, password_hash, is_owner, email, must_change_password)
             VALUES ($1, $2, $3, false, $4, true)
             RETURNING id, username, display_name, email, role, status, is_owner, is_host_admin, must_change_password, created_at, last_login_at`,
            [b.username, b.displayName, passwordHash, isEmail ? b.username : null],
          );
          const created = rows[0];
          // In the same transaction as the INSERT: a failure here leaves no half-created person.
          await applyRole(c, created.id, b.role);
          return created;
        });
      } catch (e) {
        // Either unique index (the case-sensitive one from 001, or 009's case-insensitive one) can
        // fire here too — a race with another request between the check above and this insert. Same
        // code and message either way: this is an existence oracle already bounded by owner-only,
        // step-up and the mutation rate limit, not a new one.
        if (e && typeof e === 'object' && (e as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new HttpError(409, 'username_taken', USERNAME_TAKEN);
        }
        throw e;
      }
      await audit(deps.db, { ...actor(req), action: 'people.added', target: row.id, after: { role: b.role } });
      res.status(201).json(toView({ ...row, role: b.role }));
    } catch (e) { next(e); }
  });

  r.put('/:id/role', requireOwner, stepUp, async (req, res, next) => {
    try {
      const row = await target(String(req.params.id), req.org!.id);
      const b = parse(roleSchema, req.body);
      await deps.db.tx((c) => applyRole(c, row.id, b.role));
      await audit(deps.db, { ...actor(req), action: 'people.role_changed', target: row.id, before: { role: row.role }, after: { role: b.role } });
      const [after] = await deps.db.query<PersonRow>(`${SELECT} WHERE id = $1 AND org_id = $2`, [row.id, req.org!.id]);
      res.json(toView(after));
    } catch (e) { next(e); }
  });

  r.post('/:id/reset-password', requireOwner, stepUp, async (req, res, next) => {
    try {
      const row = await target(String(req.params.id), req.org!.id);
      const b = parse(resetSchema, req.body);
      await deps.db.query(
        'UPDATE people SET password_hash=$3, must_change_password=true WHERE id=$1 AND org_id=$2',
        [row.id, req.org!.id, await hashPassword(b.temporaryPassword)],
      );
      // Whoever is holding a session for this person is holding it on the old password.
      await deps.db.query('DELETE FROM sessions WHERE person_id=$1 AND org_id=$2', [row.id, req.org!.id]);
      await audit(deps.db, { ...actor(req), action: 'people.password_reset', target: row.id });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.post('/:id/suspend', requireOwner, stepUp, async (req, res, next) => {
    try {
      const row = await target(String(req.params.id), req.org!.id);
      await deps.db.query(`UPDATE people SET status='suspended' WHERE id=$1 AND org_id=$2`, [row.id, req.org!.id]);
      await deps.db.query('DELETE FROM sessions WHERE person_id=$1 AND org_id=$2', [row.id, req.org!.id]);
      await audit(deps.db, { ...actor(req), action: 'people.suspended', target: row.id });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.post('/:id/resume', requireOwner, stepUp, async (req, res, next) => {
    try {
      const row = await target(String(req.params.id), req.org!.id);
      await deps.db.query(`UPDATE people SET status='active' WHERE id=$1 AND org_id=$2`, [row.id, req.org!.id]);
      await audit(deps.db, { ...actor(req), action: 'people.resumed', target: row.id });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
