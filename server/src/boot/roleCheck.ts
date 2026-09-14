import { createPool, type AppRole, type Db } from '../db/pool.js';

interface RoleRow {
  cur: string;
  login: string;
  rolsuper: boolean | null;
  rolbypassrls: boolean | null;
  orgs_delete: boolean | null;
}

/**
 * Ask the database what the pooled connection actually is. Returns a plain-English description of
 * the problem, or null when the connection is safe: it runs as `studio_app` and that role is
 * neither a superuser nor BYPASSRLS, so PostgreSQL applies the rules that keep organisations apart.
 *
 * Every message names the exact statements an administrator has to run once, because on a managed
 * PostgreSQL the person reading the log is usually not the person with CREATEROLE.
 */
function mustAssumeStudioApp(r: RoleRow): string {
  return [
    `This service must connect to PostgreSQL as the limited role studio_app, but its connection is running as "${r.cur}".`,
    'Without that role, one organisation could read another organisation\'s rows.',
    'An administrator must run these two statements once against this database:',
    '  CREATE ROLE studio_app NOLOGIN NOBYPASSRLS;',
    `  GRANT studio_app TO "${r.login}";`,
  ].join('\n');
}

/** Null unless the role actually in effect (`r.cur`, whatever it is named) can bypass row-level security. */
function flagsProblem(r: RoleRow): string | null {
  if (!r.rolsuper && !r.rolbypassrls) return null;
  const why = r.rolsuper ? 'a superuser' : 'allowed to bypass row-level security (BYPASSRLS)';
  return [
    `The database role ${r.cur} is ${why}, so PostgreSQL ignores the rules that keep organisations apart.`,
    'An administrator must run this statement once against this database:',
    `  ALTER ROLE ${r.cur} NOSUPERUSER NOBYPASSRLS;`,
  ].join('\n');
}

/**
 * Null unless `studio_app` can delete an `orgs` row. Migration 008 revokes that; nothing re-narrows
 * it afterwards, so a hand re-run of 007's blanket `GRANT ... ON ALL TABLES` (or a managed PostgreSQL
 * restore that predates 008) silently reopens it, and `migrate()` never re-applies an already-applied
 * migration to notice. This is what makes `dbRoleOk` on `/healthz` an actual keeper of the boundary,
 * not just a one-time check at boot.
 */
function orgsDeleteProblem(r: RoleRow): string | null {
  if (!r.orgs_delete) return null;
  return [
    'The database role studio_app can delete organisations.',
    "Migration 008 revokes that; re-run the studio's migrations or ask an administrator to run:",
    '  REVOKE DELETE ON orgs FROM studio_app;',
  ].join('\n');
}

export async function checkDbRole(db: Db): Promise<string | null> {
  const rows = await db.query<RoleRow>(
    `SELECT current_user AS cur,
            session_user AS login,
            (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS rolsuper,
            (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls,
            -- By role/table oid, not name: the text overload of has_table_privilege resolves
            -- 'orgs' through the caller's own search path, which needs USAGE on schema public —
            -- a role this check is specifically trying to describe (e.g. a BYPASSRLS role an
            -- administrator created with no grants of its own) may not have. Reading the oids
            -- straight out of pg_roles/pg_class is a plain catalog read, open to everyone.
            (SELECT has_table_privilege(r.oid, c.oid, 'DELETE')
               FROM pg_roles r, pg_class c
              WHERE r.rolname = 'studio_app' AND c.relname = 'orgs' AND c.relnamespace = 'public'::regnamespace) AS orgs_delete`,
  );
  const r = rows[0];
  if (!r) return 'The database did not answer a question about the current role. Check DATABASE_URL.';

  // The role in effect is the one we want: judge it on its own flags, never on whether it also
  // happens to be the login user. A login user named studio_app with clean flags is the safest
  // possible configuration — it must never be told to GRANT studio_app TO "studio_app".
  if (r.cur === 'studio_app') return flagsProblem(r) ?? orgsDeleteProblem(r);

  // Some other role was assumed (current_user differs from whoever logged in). Whatever it is
  // called, a bypass is the more urgent problem; otherwise it is simply the wrong role.
  if (r.cur !== r.login) return flagsProblem(r) ?? mustAssumeStudioApp(r);

  // No role was ever assumed: the connection is still running as whoever logged in (e.g. the admin
  // pool, or an app pool whose SET ROLE never landed). The local/CI login user is itself a
  // superuser (Docker Postgres default), so this branch must not consult rolsuper/rolbypassrls —
  // that would misreport "superuser" instead of "wrong role".
  return mustAssumeStudioApp(r);
}

/**
 * Thrown only by `assertDbRole`'s own hosted-mode refusal (a role that was successfully assumed but
 * has bad flags, or a role that was never assumed at all). Lets `assumeAppRole` tell that apart from
 * a raw connection failure — `SET ROLE` itself rejecting the login — which `checkDbRole`'s own query
 * cannot catch.
 */
export class DbIsolationRefused extends Error {}

/**
 * Hosted mode refuses to serve a database it cannot isolate. Single mode is one organisation
 * anyway, so a warning is honest and does not stop a self-hoster whose managed PostgreSQL has no
 * CREATEROLE. Spec section 2.3.
 */
export async function assertDbRole(db: Db): Promise<void> {
  const problem = await checkDbRole(db);
  if (!problem) return;
  console.warn(`Database isolation is not fully switched on:\n${problem}`);
}

/**
 * Create the application pool bound to `studio_app`, degrading gracefully when the role cannot even
 * be assumed — a managed PostgreSQL with no CREATEROLE never ran migration 007's `GRANT`, so `SET
 * ROLE` itself rejects the login. `checkDbRole`/`assertDbRole` only judge a role once it has been
 * assumed; that rejection instead throws straight out of the role-bound pool's own `db.query()`,
 * which used to propagate uncaught and kill boot outright.
 *
 * Warns and names the exact statement an administrator must run, then hands back a role-less pool
 * so the process still starts (row-level security no longer applies, `dbRoleOk` reports that
 * honestly on every `/healthz` call).
 */
export async function assumeAppRole(connectionString: string, admin: Db): Promise<Db> {
  const role: AppRole = 'studio_app';
  const db = createPool(connectionString, { role });
  try {
    await assertDbRole(db);
    return db;
  } catch (e) {
    if (e instanceof DbIsolationRefused) throw e;
    // SET ROLE itself failed. The admin pool never assumes a role, so checkDbRole(admin) always
    // names the real login and the exact GRANT it needs, regardless of what this raw error said.
    await db.end();
    const problem = (await checkDbRole(admin)) ?? (e instanceof Error ? e.message : String(e));
    console.warn(`Database isolation is not fully switched on:\n${problem}`);
    return createPool(connectionString);
  }
}
