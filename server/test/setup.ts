import { createAdminPool, withSystem } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TEST_ORG_ID } from './helpers.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
  const db = createAdminPool(url);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations'));
  // A fresh database has no people and no settings, so 007 creates no organisation. Tests need one,
  // with a fixed id so the synchronous testDeps() can set it as the fallback without awaiting.
  // `orgs` has FORCE ROW LEVEL SECURITY, so the write announces itself as the system rather than
  // relying on DATABASE_URL's user happening to be a superuser (pre-flight S5).
  await withSystem(() =>
    db.query(
      `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ($1, 'org-1', 'Test organisation', 'verified', true, encode(digest('sekret','sha256'),'hex'), 'unset', gen_random_bytes(32))
       ON CONFLICT (id) DO NOTHING`,
      [TEST_ORG_ID],
    ),
  );
  // Step one of the tiers-and-modules design: the tier this test database runs on. Written here and
  // in helpers.ts's ensureTestOrg (which resetTables calls after every truncate) so a test that
  // never resets still starts where a live install does.
  await withSystem(() => db.query(
    `INSERT INTO settings(org_id, key, value) VALUES ($1, 'org.tier', 'platform')
     ON CONFLICT (org_id, key) DO UPDATE SET value = 'platform'`,
    [TEST_ORG_ID],
  ));
  await db.end();
}
