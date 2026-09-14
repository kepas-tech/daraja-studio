import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdminPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { fileURLToPath } from 'node:url';
import { ensureTestOrg } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: Db;
let preSevenDir: string;

beforeAll(async () => {
  db = createAdminPool(url);
  preSevenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-007-'));
  const files = (await fs.readdir(migrationsDir)).filter((f) => /^00[1-6]_.+\.sql$/.test(f));
  for (const f of files) await fs.copyFile(path.join(migrationsDir, f), path.join(preSevenDir, f));
});
afterAll(async () => {
  await ensureTestOrg(db);
  await db.end();
  await fs.rm(preSevenDir, { recursive: true, force: true });
});

/** The shape a live Phase 2 install has: an owner, an install secret, a verified production operator, history. */
async function seedPhase2(): Promise<{ personId: string; operatorId: string; requestId: string }> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, preSevenDir);
  await db.query(
    `INSERT INTO settings(key, value, encrypted) VALUES
       ('org.name','KEPAS TECHNOLOGIES',false),
       ('install.secret','v1:AAAA:BBBB:CCCC',true),
       ('https.seen','true',false),
       ('daraja.environment','production',false),
       ('public.url','https://darajastudio.com',false),
       ('setup.completedAt','2026-09-06T10:00:00.000Z',false),
       ('env.production.shortcode','700111',false),
       ('env.production.consumerKey','v1:K',true)`,
  );
  const [p] = await db.query<{ id: string }>(
    `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','h',true) RETURNING id`,
  );
  const [o] = await db.query<{ id: string }>(
    `INSERT INTO operators(name, credential_enc, status, environment) VALUES ('KEPAS','v1:C','verified','production') RETURNING id`,
  );
  const [r] = await db.query<{ id: string }>(
    `INSERT INTO requests(type, originator_conversation_id, status, amount_cents, operator_id, created_by)
     VALUES ('b2c','oc-1','completed',1000,$1,$2) RETURNING id`,
    [o.id, p.id],
  );
  await db.query(`INSERT INTO balances(working_cents, raw) VALUES (500, '{}'::jsonb)`);
  await db.query(`INSERT INTO callbacks_raw(path, verdict) VALUES ('/cb/x/b2c','applied')`);
  await db.query(`INSERT INTO audit_log(action, target) VALUES ('send.b2c',$1)`, [r.id]);
  await db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'send.phone')`, [p.id]);
  await db.query(`INSERT INTO sessions(id, person_id, csrf_token, expires_at) VALUES ('s1',$1,'c', now() + interval '1 day')`, [p.id]);
  return { personId: p.id, operatorId: o.id, requestId: r.id };
}

describe('migration 007', () => {
  it('folds a Phase 2 database into organisation #1 and leaves nothing behind', async () => {
    const seeded = await seedPhase2();
    const applied = await migrate(db, migrationsDir);
    expect(applied).toContain('007');

    const [org] = await db.query<{ id: string; slug: string; name: string; status: string; is_host: boolean; callback_secret_hash: string; callback_secret_enc: string; verified_at: string | null }>(
      'SELECT * FROM orgs',
    );
    expect(org.slug).toBe('org-1');
    expect(org.name).toBe('KEPAS TECHNOLOGIES');
    expect(org.status).toBe('verified');
    expect(org.is_host).toBe(true);
    expect(org.verified_at).not.toBeNull();
    // The boot pass finishes these two; the migration only carries the old ciphertext across.
    expect(org.callback_secret_hash).toBe('unset');
    expect(org.callback_secret_enc).toBe('v1:AAAA:BBBB:CCCC');

    for (const t of ['settings', 'people', 'permissions', 'sessions', 'operators', 'requests', 'balances', 'callbacks_raw', 'audit_log']) {
      const [row] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE org_id IS DISTINCT FROM $1`, [org.id]);
      expect(`${t}:${row.n}`).toBe(`${t}:0`);
    }

    const [pk] = await db.query<{ cols: string[] }>(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols
         FROM pg_constraint c
         JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'settings'::regclass AND c.contype = 'p'`,
    );
    expect(pk.cols).toEqual(['org_id', 'key']);

    const [inst] = await db.query<{ value: string }>(`SELECT value FROM instance_settings WHERE key = 'https.seen'`);
    expect(inst.value).toBe('true');
    const leftovers = await db.query(`SELECT key FROM settings WHERE key IN ('https.seen','install.secret')`);
    expect(leftovers).toEqual([]);

    const [person] = await db.query<{ role: string; is_host_admin: boolean }>('SELECT role, is_host_admin FROM people WHERE id=$1', [seeded.personId]);
    expect(person.role).toBe('owner');
    // migrationsDir is the real migrations directory, so this migrate() call also runs 008, which
    // makes the host organisation's owner its first host admin (spec 6.1).
    expect(person.is_host_admin).toBe(true);

    // The audit trigger was re-enabled: audit_log is still append-only.
    await expect(db.query(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(/append-only/);
  });

  it('creates the studio_app role, tolerates one an administrator created first, and never gives it TRUNCATE', async () => {
    await seedPhase2();
    // Pre-create the role exactly as a managed-Postgres administrator would (spec §13 q4).
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'studio_app') THEN
        CREATE ROLE studio_app NOLOGIN NOBYPASSRLS;
      END IF;
    END $$`);
    await expect(migrate(db, migrationsDir)).resolves.toContain('007');

    const [role] = await db.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'studio_app'`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });

    const [priv] = await db.query<{ ins: boolean; trunc: boolean }>(
      `SELECT has_table_privilege('studio_app','settings','INSERT') AS ins,
              has_table_privilege('studio_app','settings','TRUNCATE') AS trunc`,
    );
    expect(priv).toEqual({ ins: true, trunc: false });
  });

  it('creates no organisation on a fresh database — the boot pass does that', async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db, migrationsDir);
    expect(await db.query('SELECT id FROM orgs')).toEqual([]);
    const [col] = await db.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns WHERE table_name='settings' AND column_name='org_id'`,
    );
    expect(col.column_default).toContain('app_current_org()');
  });

  it('folds a Phase 2 database whose only rows live outside settings/people into organisation #1', async () => {
    // A database where nobody happened to insert a settings or people row before an operator sent
    // money is still a real, populated install — the organisation guard must not key off just two
    // of the nine backfilled tables.
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db, preSevenDir);
    const [o] = await db.query<{ id: string }>(
      `INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS','v1:C','verified') RETURNING id`,
    );
    const [r] = await db.query<{ id: string }>(
      `INSERT INTO requests(type, originator_conversation_id, status, operator_id) VALUES ('b2c','oc-1','completed',$1) RETURNING id`,
      [o.id],
    );
    await db.query(`INSERT INTO audit_log(action, target) VALUES ('send.b2c',$1)`, [r.id]);

    const applied = await migrate(db, migrationsDir);
    expect(applied).toContain('007');

    const [org] = await db.query<{ id: string; is_host: boolean }>('SELECT id, is_host FROM orgs');
    expect(org.is_host).toBe(true);
    for (const t of ['operators', 'requests', 'audit_log']) {
      const [row] = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE org_id IS DISTINCT FROM $1`, [org.id]);
      expect(`${t}:${row.n}`).toBe(`${t}:0`);
    }
  });

  it('is a no-op the second time, including the file run directly', async () => {
    await seedPhase2();
    await migrate(db, migrationsDir);
    const before = await db.query<{ id: string; name: string }>('SELECT id, name FROM orgs');
    expect(await migrate(db, migrationsDir)).toEqual([]);
    // And re-running the file itself, the way a hand-repair would.
    const sql = await fs.readFile(path.join(migrationsDir, '007_orgs.sql'), 'utf8');
    await db.tx(async (c) => { await c.query(sql); });
    expect(await db.query('SELECT id, name FROM orgs')).toEqual(before);

    // 007's GRANT ... ON ALL TABLES re-widens studio_app on every table, orgs included — left there,
    // it would leave the shared test database open for every file that runs after this one. Running
    // 008 directly, the same way, re-narrows it and doubles as 008's own direct-re-run idempotency
    // proof.
    const sql008 = await fs.readFile(path.join(migrationsDir, '008_hosted.sql'), 'utf8');
    await db.tx(async (c) => { await c.query(sql008); });
    const [g] = await db.query<{ del: boolean; migrations: boolean }>(
      `SELECT has_table_privilege('studio_app','orgs','DELETE') AS del,
              has_table_privilege('studio_app','schema_migrations','SELECT') AS migrations`,
    );
    expect(g).toEqual({ del: false, migrations: false });
  });
});
