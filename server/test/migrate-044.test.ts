import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminPool, withOrg, withSystem, resetContextForTests, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { ensureTestOrg } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: Db;
let preDir: string;

/**
 * Migration 044, the repair for the flag migration 008 could never set.
 *
 * The state under test is the one every live install had: the migrations had all run, the host
 * organisation existed, its owner existed, and is_host_admin was false on every row. So this file
 * migrates a database to 043 first — 044 not among them — seeds that state by hand, and then runs the
 * real migration directory, which is what an upgrade to this version does.
 */
beforeAll(async () => {
  db = createAdminPool(url);
  preDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-044-'));
  const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql') && f < '044_');
  for (const f of files) await fs.copyFile(path.join(migrationsDir, f), path.join(preDir, f));
});

afterAll(async () => {
  resetContextForTests();
  await ensureTestOrg(db);
  await db.end();
  await fs.rm(preDir, { recursive: true, force: true });
});

async function upTo043(): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, preDir);
}

/** An organisation with one owner and, if asked, one other active person. Returns its id. */
async function seedOrg(slug: string, isHost: boolean, extra?: { username: string }): Promise<string> {
  const [org] = await withSystem(() =>
    db.query<{ id: string }>(
      `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ($1, $2, 'verified', $3, $4, 'unset', gen_random_bytes(32)) RETURNING id`,
      [slug, slug, isHost, 'hash-' + slug],
    ),
  );
  const orgId = org!.id;
  await withOrg(orgId, () =>
    db.query(
      `INSERT INTO people(username, display_name, password_hash, is_owner, is_host_admin)
       VALUES ($1, $1, 'h', true, false)`,
      [slug + '-owner'],
    ),
  );
  if (extra) {
    await withOrg(orgId, () =>
      db.query(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ($1, $1, 'h', false)`, [extra.username]),
    );
  }
  return orgId;
}

const flagOf = async (username: string): Promise<boolean | undefined> =>
  (await withSystem(() => db.query<{ is_host_admin: boolean }>('SELECT is_host_admin FROM people WHERE username = $1', [username])))[0]?.is_host_admin;
const hostAdmins = async (): Promise<string[]> =>
  (await withSystem(() => db.query<{ username: string }>('SELECT username FROM people WHERE is_host_admin ORDER BY username'))).map((r) => r.username);

describe('migration 044', () => {
  it('gives the host organisation own owner the flag, and touches nobody else', async () => {
    await upTo043();
    await seedOrg('kepas', true, { username: 'host-staff' });
    await seedOrg('a-tenant', false);
    // Every row starts where the live install started: the flag is false everywhere.
    expect(await hostAdmins()).toEqual([]);

    const applied = await migrate(db, migrationsDir);
    expect(applied[0]).toBe('044');

    expect(await flagOf('kepas-owner')).toBe(true);
    // Nobody else: not a second person in the host organisation, and nobody in another organisation.
    expect(await flagOf('host-staff')).toBe(false);
    expect(await flagOf('a-tenant-owner')).toBe(false);
    expect(await hostAdmins()).toEqual(['kepas-owner']);
  });

  it('changes nothing more the second time', async () => {
    await upTo043();
    await seedOrg('kepas', true);
    await seedOrg('a-tenant', false);
    await migrate(db, migrationsDir);
    expect(await hostAdmins()).toEqual(['kepas-owner']);

    // Nothing left to apply, and the rows are exactly as the first run left them.
    expect(await migrate(db, migrationsDir)).toEqual([]);
    expect(await hostAdmins()).toEqual(['kepas-owner']);
    expect(await flagOf('a-tenant-owner')).toBe(false);
  });

  it('leaves an install with no host organisation alone', async () => {
    // A brand-new database: the boot pass has not created organisation #1 yet, which is exactly the
    // state a fresh install is in when the migrations run.
    await upTo043();
    expect(await migrate(db, migrationsDir)).toContain('044');
    expect(await hostAdmins()).toEqual([]);

    // And an install whose one organisation is not marked as the host: the row is not touched.
    await upTo043();
    await seedOrg('not-the-host', false);
    await migrate(db, migrationsDir);
    expect(await hostAdmins()).toEqual([]);
    expect(await flagOf('not-the-host-owner')).toBe(false);
  });
});
