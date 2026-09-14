import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { fileURLToPath } from 'node:url';
import { ensureTestOrg } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: Db;
let preSixDir: string;

beforeAll(async () => {
  db = createPool(url);
  // A directory holding only 001-005 lets us apply the schema as it existed just before this
  // migration, seed the legacy keys, and only then run 006 through the same programmatic runner
  // (see server/src/db/migrate.ts) that boot and every other migration test use.
  preSixDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-006-'));
  const files = (await fs.readdir(migrationsDir)).filter((f) => /^00[1-5]_.+\.sql$/.test(f));
  for (const f of files) await fs.copyFile(path.join(migrationsDir, f), path.join(preSixDir, f));
});
afterAll(async () => { await ensureTestOrg(db); await db.end(); await fs.rm(preSixDir, { recursive: true, force: true }); });

describe('migration 006', () => {
  it('moves the old shared Daraja keys into the target environment slot and is idempotent', async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db, preSixDir);

    await db.query(
      `INSERT INTO settings(key, value, encrypted) VALUES
         ('daraja.consumerKey','ENC-KEY',true),
         ('daraja.consumerSecret','ENC-SECRET',true),
         ('daraja.passkey','ENC-PASSKEY',true),
         ('daraja.certPem','ENC-CERT',true),
         ('org.shortcode','600999',false),
         ('daraja.credsEnv','production',false),
         ('daraja.environment','production',false)`,
    );

    const applied = await migrate(db, migrationsDir);
    expect(applied).toContain('006');

    const rows = await db.query<{ key: string; value: string; encrypted: boolean }>('SELECT key, value, encrypted FROM settings ORDER BY key');
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

    expect(byKey['env.production.consumerKey']).toMatchObject({ value: 'ENC-KEY', encrypted: true });
    expect(byKey['env.production.consumerSecret']).toMatchObject({ value: 'ENC-SECRET', encrypted: true });
    expect(byKey['env.production.passkey']).toMatchObject({ value: 'ENC-PASSKEY', encrypted: true });
    expect(byKey['env.production.certPem']).toMatchObject({ value: 'ENC-CERT', encrypted: true });
    expect(byKey['env.production.shortcode']).toMatchObject({ value: '600999', encrypted: false });
    expect(byKey['env.production.credsVerifiedAt'].value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Sandbox slot was never touched.
    expect(byKey['env.sandbox.consumerKey']).toBeUndefined();
    expect(byKey['env.sandbox.shortcode']).toBeUndefined();

    // Old keys are gone.
    for (const old of ['daraja.consumerKey', 'daraja.consumerSecret', 'daraja.passkey', 'daraja.certPem', 'org.shortcode', 'daraja.credsEnv']) {
      expect(byKey[old]).toBeUndefined();
    }
    // Unchanged key.
    expect(byKey['daraja.environment']).toMatchObject({ value: 'production' });

    // Running 006 again (already recorded in schema_migrations) is a no-op via the tracked runner.
    const second = await migrate(db, migrationsDir);
    expect(second).toEqual([]);

    const opCols = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='operators' AND column_name='environment'`);
    expect(opCols).toHaveLength(1);
    const idx = (await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename='operators'`)).map((x) => x.indexname);
    expect(idx).toContain('operators_environment_status_idx');
  });

  it('moves a verified operator into the target environment, leaving a non-verified one in sandbox', async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db, preSixDir);
    await db.query(
      `INSERT INTO settings(key, value, encrypted) VALUES
         ('daraja.consumerKey','ENC-KEY',true),
         ('daraja.consumerSecret','ENC-SECRET',true),
         ('daraja.credsEnv','production',false),
         ('daraja.environment','production',false)`,
    );
    const [{ id: verifiedId }] = await db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS','c','verified') RETURNING id`);
    const [{ id: failedId }] = await db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('KILELO','c','failed') RETURNING id`);

    await migrate(db, migrationsDir);

    const rows = await db.query<{ id: string; environment: string }>('SELECT id, environment FROM operators ORDER BY name');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.environment]));
    expect(byId[verifiedId]).toBe('production');
    expect(byId[failedId]).toBe('sandbox');
  });

  it('guards target to sandbox/production — a junk daraja.environment (no credsEnv) never produces an unreachable env.<junk>.* key', async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db, preSixDir);
    await db.query(
      `INSERT INTO settings(key, value, encrypted) VALUES
         ('daraja.consumerKey','ENC-KEY',true),
         ('daraja.environment','staging',false)`,
    );
    const [{ id: verifiedId }] = await db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS','c','verified') RETURNING id`);

    await migrate(db, migrationsDir);

    const rows = await db.query<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key');
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey['env.sandbox.consumerKey']).toBe('ENC-KEY');
    expect(byKey['env.staging.consumerKey']).toBeUndefined();
    const [op] = await db.query<{ environment: string }>('SELECT environment FROM operators WHERE id=$1', [verifiedId]);
    expect(op.environment).toBe('sandbox');
  });

  it('defaults existing operator rows to sandbox', async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db, preSixDir);
    const [{ id }] = await db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS','c','pending') RETURNING id`);
    await migrate(db, migrationsDir);
    const [op] = await db.query<{ environment: string }>('SELECT environment FROM operators WHERE id=$1', [id]);
    expect(op.environment).toBe('sandbox');
  });

  it('is a no-op on a database with none of the old keys', async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db, preSixDir);
    const before = await db.query<{ key: string }>('SELECT key FROM settings ORDER BY key');
    await migrate(db, migrationsDir);
    const after = await db.query<{ key: string }>('SELECT key FROM settings ORDER BY key');
    expect(after).toEqual(before);
  });
});
