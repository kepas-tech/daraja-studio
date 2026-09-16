import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminPool, createPool, withOrg, withSystem, resetContextForTests, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ensureTestOrg } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: Db;
let tenant: Db;
let preEightDir: string;

beforeAll(async () => {
  db = createAdminPool(url);
  tenant = createPool(url, { role: 'studio_app' });
  preEightDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-008-'));
  const files = (await fs.readdir(migrationsDir)).filter((f) => /^00[1-7]_.+\.sql$/.test(f));
  for (const f of files) await fs.copyFile(path.join(migrationsDir, f), path.join(preEightDir, f));
});

afterAll(async () => {
  resetContextForTests();
  await ensureTestOrg(db);
  await tenant.end();
  await db.end();
  await fs.rm(preEightDir, { recursive: true, force: true });
});

/** A Phase 3A database: migrations 001–007, one host organisation, its owner. */
async function seedPhase3a(): Promise<string> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, preEightDir);
  const [org] = await withSystem(() =>
    db.query<{ id: string }>(
      `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ('org-1','APIONE','verified',true,'hash-1','unset',gen_random_bytes(32)) RETURNING id`,
    ),
  );
  await withOrg(org.id, () =>
    db.query(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','h',true)`),
  );
  return org.id;
}

describe('migration 008', () => {
  it('adds the sign-up indexes, the key_salt default and the host admin, and is a no-op the second time', async () => {
    const orgId = await seedPhase3a();
    // The upgrade starts at 008 and also applies later migrations. The checks below pin
    // 008's schema and permissions without limiting which later migrations may exist.
    const applied = await migrate(db, migrationsDir);
    expect(applied[0]).toBe('008');

    const [{ names }] = await db.query<{ names: string[] }>(
      `SELECT array_agg(indexname::text ORDER BY indexname) AS names FROM pg_indexes
        WHERE schemaname='public' AND indexname IN ('settings_consumer_key_uniq','orgs_unverified_idx')`,
    );
    expect(names).toEqual(['orgs_unverified_idx', 'settings_consumer_key_uniq']);

    const [salt] = await db.query<{ default_expr: string | null }>(
      `SELECT column_default AS default_expr FROM information_schema.columns
        WHERE table_name='orgs' AND column_name='key_salt'`,
    );
    expect(salt.default_expr).toContain('gen_random_bytes');

    const [owner] = await withOrg(orgId, () =>
      db.query<{ is_host_admin: boolean }>(`SELECT is_host_admin FROM people WHERE username='owner'`),
    );
    expect(owner.is_host_admin).toBe(true);

    expect(await migrate(db, migrationsDir)).toEqual([]);
  });

  it('lets one organisation claim a Daraja app and refuses the next one', async () => {
    const orgA = await seedPhase3a();
    await migrate(db, migrationsDir);
    const [orgB] = await withSystem(() =>
      db.query<{ id: string }>(
        `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc)
         VALUES ('org-2','Other','pending',false,'hash-2','unset') RETURNING id`,
      ),
    );
    await withOrg(orgA, () =>
      db.query(`INSERT INTO settings(key, value, encrypted) VALUES ('env.sandbox.consumerKeyHash','abc',false)`),
    );
    await expect(
      withOrg(orgB.id, () =>
        db.query(`INSERT INTO settings(key, value, encrypted) VALUES ('env.sandbox.consumerKeyHash','abc',false)`),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // A different environment with the same hash is a different app as far as this index is concerned.
    await expect(
      withOrg(orgB.id, () =>
        db.query(`INSERT INTO settings(key, value, encrypted) VALUES ('env.production.consumerKeyHash','abc',false)`),
      ),
    ).resolves.toEqual([]);
  });

  it('leaves the application role only the six columns an organisation owns, and no DELETE', async () => {
    await seedPhase3a();
    await migrate(db, migrationsDir);

    const [g] = await db.query<{
      ins: boolean; del: boolean; upd: boolean; status: boolean; verifiedAt: boolean; failReason: boolean;
      suspendReason: boolean; suspendedAt: boolean; host: boolean; secret: boolean; salt: boolean; slug: boolean;
      signupIp: boolean; createdAt: boolean; migrations: boolean;
    }>(
      `SELECT has_table_privilege('studio_app','orgs','INSERT')                     AS ins,
              has_table_privilege('studio_app','orgs','DELETE')                     AS del,
              has_table_privilege('studio_app','orgs','UPDATE')                     AS upd,
              has_column_privilege('studio_app','orgs','status','UPDATE')           AS status,
              has_column_privilege('studio_app','orgs','verified_at','UPDATE')      AS "verifiedAt",
              has_column_privilege('studio_app','orgs','fail_reason','UPDATE')      AS "failReason",
              has_column_privilege('studio_app','orgs','suspend_reason','UPDATE')   AS "suspendReason",
              has_column_privilege('studio_app','orgs','suspended_at','UPDATE')     AS "suspendedAt",
              has_column_privilege('studio_app','orgs','is_host','UPDATE')          AS host,
              has_column_privilege('studio_app','orgs','callback_secret_hash','UPDATE') AS secret,
              has_column_privilege('studio_app','orgs','key_salt','UPDATE')         AS salt,
              has_column_privilege('studio_app','orgs','slug','UPDATE')             AS slug,
              has_column_privilege('studio_app','orgs','signup_ip','UPDATE')        AS "signupIp",
              has_column_privilege('studio_app','orgs','created_at','UPDATE')       AS "createdAt",
              has_table_privilege('studio_app','schema_migrations','SELECT')        AS migrations`,
    );
    // INSERT stays on purpose: the org_self policy, not the grant, is what stops a tenant creating
    // one (proven below). The six granted UPDATE columns are exactly what an organisation may change
    // about itself; everything else — its identity, its secrets, its audit trail — is gone.
    expect(g).toEqual({
      ins: true, del: false, upd: false,
      status: true, verifiedAt: true, failReason: true, suspendReason: true, suspendedAt: true,
      host: false, secret: false, salt: false, slug: false, signupIp: false, createdAt: false,
      migrations: false,
    });
  });

  it('lets only the system create an organisation, and nobody delete one, through the application pool', async () => {
    const orgId = await seedPhase3a();
    await migrate(db, migrationsDir);

    // A tenant context can only ever name its own id, which already exists — and the policy rejects
    // any other id outright, so the WITH CHECK fires before the primary key ever would. Asserting on
    // the message, not just the SQLSTATE, proves it is org_self's WITH CHECK doing the rejecting and
    // not some other 42501 (e.g. a column-level grant) coincidentally sharing the same code.
    await expect(
      withOrg(orgId, () =>
        tenant.query(
          `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc)
           VALUES ('sneaky','Sneaky','verified',true,'hash-x','unset')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    // The system context, on the very same role-bound pool, is how sign-up creates one.
    const [made] = await withSystem(() =>
      tenant.query<{ id: string }>(
        `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc)
         VALUES ('made-by-app','Made','pending',false,'hash-made','unset') RETURNING id`,
      ),
    );
    expect(made.id).toBeTruthy();

    // Deleting one is off the table for the application, system context or not.
    await expect(
      withSystem(() => tenant.query('DELETE FROM orgs WHERE id = $1', [made.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('lets an organisation rename itself and change nothing else about itself', async () => {
    const orgId = await seedPhase3a();
    await migrate(db, migrationsDir);

    await expect(
      withOrg(orgId, () => tenant.query(`UPDATE orgs SET name = 'Renamed' WHERE id = $1`, [orgId])),
    ).resolves.toEqual([]);

    for (const statement of [
      'UPDATE orgs SET is_host = true WHERE id = $1',
      `UPDATE orgs SET callback_secret_hash = 'hash-mine' WHERE id = $1`,
      `UPDATE orgs SET callback_secret_enc = 'v2:a:b:c' WHERE id = $1`,
      'UPDATE orgs SET key_salt = gen_random_bytes(32) WHERE id = $1',
      `UPDATE orgs SET slug = 'renamed' WHERE id = $1`,
    ]) {
      await expect(withOrg(orgId, () => tenant.query(statement, [orgId]))).rejects.toMatchObject({ code: '42501' });
    }
  });
});
