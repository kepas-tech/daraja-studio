import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAdminPool, withOrg, withSystem, currentOrgId, resetContextForTests, type Db } from '../src/db/pool.js';
import { bootTenancy } from '../src/boot/tenancy.js';
import { createDbKeyring, decryptForOrg, decrypt, encrypt, sha256, randomSecret, type Keyring } from '../src/crypto/secrets.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { ensureTestOrg, TEST_KEY } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MASTER = Buffer.from(TEST_KEY, 'base64');
let db: Db;

function config(over: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: url, STUDIO_SECRET_KEY: TEST_KEY, NODE_ENV: 'test', ...over });
}
function boot(c: Config) {
  const keyring = createDbKeyring(db, MASTER);
  return bootTenancy({ db, config: c, keyring });
}

beforeAll(() => {
  db = createAdminPool(url);
});
afterAll(async () => {
  // The last test to run leaves whatever organisations it created (e.g. 'org-a'/'org-b') behind —
  // ensureTestOrg only reconciles rows that collide with organisation #1's own unique columns, so
  // those would otherwise leak into every test file that runs after this one in the same process.
  await freshSchema();
  await ensureTestOrg(db);
  await db.end();
});
beforeEach(() => {
  resetContextForTests();
  // resetContextForTests() forgets the process value; a pool's own fallback outlives it, and the
  // previous case left one on this pool.
  db.setFallbackOrg(null);
});

async function freshSchema() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, migrationsDir);
}

/**
 * The live darajastudio.com shape: an owner org, an encrypted install secret, both environments'
 * Daraja credentials encrypted, and two operators (one verified/production, one disabled/sandbox) —
 * 7 encrypted settings rows + 2 operator credentials = 9 rows for step 3 to re-encrypt, matching the
 * live rehearsal (`rowsReencrypted: 9`).
 */
async function seedPhase2Dump(installSecret: string): Promise<string> {
  await freshSchema();
  const [{ id: orgId }] = await withSystem(() =>
    db.query<{ id: string }>(
      `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt, verified_at)
       VALUES ('org-1','ACME TRADERS','verified',true,'unset',$1,gen_random_bytes(32), now()) RETURNING id`,
      [encrypt(MASTER, installSecret)],
    ),
  );
  await withOrg(orgId, async () => {
    await db.query(
      `INSERT INTO settings(key, value, encrypted) VALUES
         ('org.name','ACME TRADERS',false),
         ('daraja.environment','production',false),
         ('env.production.shortcode','700111',false),
         ('env.production.consumerKey',$1,true),
         ('env.production.consumerSecret',$2,true),
         ('env.production.passkey',$3,true),
         ('env.production.certPem',$4,true),
         ('env.sandbox.consumerKey',$5,true),
         ('env.sandbox.consumerSecret',$6,true),
         ('env.sandbox.passkey',$7,true)`,
      [
        encrypt(MASTER, 'CK-live'),
        encrypt(MASTER, 'CS-live'),
        encrypt(MASTER, 'PK-live'),
        encrypt(MASTER, '-----BEGIN CERTIFICATE-----'),
        encrypt(MASTER, 'CK-sandbox'),
        encrypt(MASTER, 'CS-sandbox'),
        encrypt(MASTER, 'PK-sandbox'),
      ],
    );
    await db.query(
      `INSERT INTO operators(name, credential_enc, status, environment) VALUES
         ('APIONE',$1,'verified','production'),
         ('testapi',$2,'disabled','sandbox')`,
      [encrypt(MASTER, 'SECURITY-CREDENTIAL'), encrypt(MASTER, 'SECURITY-CREDENTIAL-TEST')],
    );
  });
  return orgId;
}

describe('bootTenancy', () => {
  it('creates organisation #1 on a fresh single-mode install and sets the fallback', async () => {
    await freshSchema();
    const r = await boot(config());
    expect(r.created).toBe(true);
    expect(r.orgId).toBeTruthy();

    const [org] = await withSystem(() =>
      db.query<{ slug: string; status: string; is_host: boolean; callback_secret_hash: string; callback_secret_enc: string }>(
        'SELECT slug, status, is_host, callback_secret_hash, callback_secret_enc FROM orgs',
      ),
    );
    expect(org.slug).toBe('org-1');
    expect(org.status).toBe('pending');
    expect(org.is_host).toBe(true);
    expect(org.callback_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(org.callback_secret_enc.startsWith('v2:')).toBe(true);

    // setFallbackOrg wrote the process value as well as this pool's, so the bare currentOrgId()
    // that encryptForOrg and enqueue read now answers with organisation #1.
    expect(currentOrgId()).toBe(r.orgId);
  });

  it('keeps a Phase 2 install working: same secret, same settings, everything re-encrypted to v2', async () => {
    const installSecret = randomSecret(32);
    const orgId = await seedPhase2Dump(installSecret);

    const r = await boot(config());
    expect(r.created).toBe(false);
    expect(r.orgId).toBe(orgId);
    expect(r.secretsHashed).toBe(1);
    expect(r.rowsReencrypted).toBe(9); // seven encrypted settings rows (both environments) plus two operator credentials

    const [org] = await withSystem(() =>
      db.query<{ callback_secret_hash: string; callback_secret_enc: string }>(
        'SELECT callback_secret_hash, callback_secret_enc FROM orgs',
      ),
    );
    // Today's callback URLs keep working unchanged: the secret is the same, only its storage changed.
    expect(org.callback_secret_hash).toBe(sha256(installSecret));
    expect(org.callback_secret_enc.startsWith('v2:')).toBe(true);

    const keyring = createDbKeyring(db, MASTER);
    expect(await withOrg(orgId, () => decryptForOrg(keyring, org.callback_secret_enc))).toBe(installSecret);

    const rows = await withOrg(orgId, () =>
      db.query<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE encrypted ORDER BY key`),
    );
    expect(rows.map((x) => x.key)).toEqual([
      'env.production.certPem',
      'env.production.consumerKey',
      'env.production.consumerSecret',
      'env.production.passkey',
      'env.sandbox.consumerKey',
      'env.sandbox.consumerSecret',
      'env.sandbox.passkey',
    ]);
    for (const row of rows) expect(row.value.startsWith('v2:')).toBe(true);
    const orgKey = await keyring.keyFor(orgId);
    expect(rows.map((x) => decrypt(orgKey, x.value))).toEqual([
      '-----BEGIN CERTIFICATE-----',
      'CK-live',
      'CS-live',
      'PK-live',
      'CK-sandbox',
      'CS-sandbox',
      'PK-sandbox',
    ]);

    const ops = await withOrg(orgId, () =>
      db.query<{ name: string; credential_enc: string }>('SELECT name, credential_enc FROM operators'),
    );
    const opByName = Object.fromEntries(ops.map((o) => [o.name, o.credential_enc]));
    expect(opByName.APIONE.startsWith('v2:')).toBe(true);
    expect(decrypt(orgKey, opByName.APIONE)).toBe('SECURITY-CREDENTIAL');
    expect(opByName.testapi.startsWith('v2:')).toBe(true);
    expect(decrypt(orgKey, opByName.testapi)).toBe('SECURITY-CREDENTIAL-TEST');

    // Rows that were never encrypted are untouched.
    const [name] = await withOrg(orgId, () =>
      db.query<{ value: string }>(`SELECT value FROM settings WHERE key='org.name'`),
    );
    expect(name.value).toBe('ACME TRADERS');
  });

  it('is idempotent: a second boot changes nothing', async () => {
    const installSecret = randomSecret(32);
    const orgId = await seedPhase2Dump(installSecret);
    await boot(config());
    const before = await withSystem(() => db.query('SELECT * FROM orgs'));
    const beforeSettings = await withOrg(orgId, () => db.query('SELECT key, value FROM settings ORDER BY key'));

    const second = await boot(config());
    expect(second).toMatchObject({ created: false, secretsHashed: 0, rowsReencrypted: 0, orgId });
    expect(await withSystem(() => db.query('SELECT * FROM orgs'))).toEqual(before);
    expect(await withOrg(orgId, () => db.query('SELECT key, value FROM settings ORDER BY key'))).toEqual(beforeSettings);
  });

  it('mints a secret when the migration found none to carry across', async () => {
    await freshSchema();
    await withSystem(() =>
      db.query(
        `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
         VALUES ('org-1','My organisation','pending',true,'unset','unset',gen_random_bytes(32))`,
      ),
    );
    const r = await boot(config());
    expect(r.secretsHashed).toBe(1);
    const [org] = await withSystem(() =>
      db.query<{ callback_secret_hash: string; callback_secret_enc: string }>(
        'SELECT callback_secret_hash, callback_secret_enc FROM orgs',
      ),
    );
    expect(org.callback_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(org.callback_secret_enc.startsWith('v2:')).toBe(true);
  });

  it('rolls back an organisation whose re-encryption cannot be verified, leaving every row v1', async () => {
    await freshSchema();
    // callback_secret_hash is already set, so step 2 skips this org entirely — only step 3's
    // settings re-encryption is exercised here.
    const [{ id: orgId }] = await withSystem(() =>
      db.query<{ id: string }>(
        `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt, verified_at)
         VALUES ('org-1','ACME TRADERS','verified',true,$1,$2,gen_random_bytes(32), now()) RETURNING id`,
        [sha256('sekret'), encrypt(MASTER, 'sekret')],
      ),
    );
    await withOrg(orgId, () =>
      db.query(`INSERT INTO settings(key, value, encrypted) VALUES ('env.production.consumerKey',$1,true)`, [
        encrypt(MASTER, 'CK-live'),
      ]),
    );

    const goodKeyring = createDbKeyring(db, MASTER);
    const goodKey = await goodKeyring.keyFor(orgId);
    const wrongKey = randomBytes(32);
    let calls = 0;
    // The class of bug I1 exists to catch: a keyring whose `keyFor` resolves the wrong key for one
    // call (a salt read through the wrong context, or a rotation race) but the right key
    // moments later — encryptForOrg's write uses the first (bad) key, and if nothing reads it back
    // before committing, the row is silently unrecoverable.
    const faultyKeyring: Keyring = {
      master: MASTER,
      async keyFor() {
        calls += 1;
        return calls === 1 ? wrongKey : goodKey;
      },
      invalidate() {},
    };

    await expect(
      bootTenancy({ db, config: config(), keyring: faultyKeyring }),
    ).rejects.toThrow(/re-encryption verification failed/);

    // Nothing was written: the row is still v1 and still decrypts under the master key.
    const [row] = await withOrg(orgId, () =>
      db.query<{ value: string }>(`SELECT value FROM settings WHERE key='env.production.consumerKey'`),
    );
    expect(row.value.startsWith('v1:')).toBe(true);
    expect(decrypt(MASTER, row.value)).toBe('CK-live');
  });

  it('re-encrypts each organisation strictly under its own key (I2 — the org_id filter is load-bearing)', async () => {
    await freshSchema();
    const [orgA, orgB] = await withSystem(() =>
      db.query<{ id: string }>(
        `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
         VALUES ('org-a','A','verified',true,$1,$3,gen_random_bytes(32)),
                ('org-b','B','verified',false,$2,$3,gen_random_bytes(32))
         RETURNING id`,
        [sha256('secret-a'), sha256('secret-b'), 'unset'],
      ),
    );
    await withOrg(orgA.id, async () => {
      await db.query(`INSERT INTO settings(key, value, encrypted) VALUES ('env.production.consumerKey',$1,true)`, [
        encrypt(MASTER, 'CK-A'),
      ]);
      await db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('OP-A',$1,'verified')`, [
        encrypt(MASTER, 'CRED-A'),
      ]);
    });
    await withOrg(orgB.id, async () => {
      await db.query(`INSERT INTO settings(key, value, encrypted) VALUES ('env.production.consumerKey',$1,true)`, [
        encrypt(MASTER, 'CK-B'),
      ]);
      await db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('OP-B',$1,'verified')`, [
        encrypt(MASTER, 'CRED-B'),
      ]);
    });

    await boot(config());

    const keyring = createDbKeyring(db, MASTER);
    const keyA = await keyring.keyFor(orgA.id);
    const keyB = await keyring.keyFor(orgB.id);

    // Both organisations use the same settings key, and this runs on the admin pool (bypasses RLS),
    // so the org_id filter here is what actually picks the right organisation's row — the same
    // requirement C1/I2 hold tenancy.ts itself to.
    const [rowA] = await withOrg(orgA.id, () =>
      db.query<{ value: string }>(`SELECT value FROM settings WHERE org_id=$1 AND key='env.production.consumerKey'`, [orgA.id]),
    );
    expect(rowA.value.startsWith('v2:')).toBe(true);
    expect(decrypt(keyA, rowA.value)).toBe('CK-A');
    expect(() => decrypt(keyB, rowA.value)).toThrow();

    const [rowB] = await withOrg(orgB.id, () =>
      db.query<{ value: string }>(`SELECT value FROM settings WHERE org_id=$1 AND key='env.production.consumerKey'`, [orgB.id]),
    );
    expect(rowB.value.startsWith('v2:')).toBe(true);
    expect(decrypt(keyB, rowB.value)).toBe('CK-B');
    expect(() => decrypt(keyA, rowB.value)).toThrow();

    const [opA] = await withOrg(orgA.id, () =>
      db.query<{ credential_enc: string }>(`SELECT credential_enc FROM operators WHERE name='OP-A'`),
    );
    expect(decrypt(keyA, opA.credential_enc)).toBe('CRED-A');
    expect(() => decrypt(keyB, opA.credential_enc)).toThrow();

    const [opB] = await withOrg(orgB.id, () =>
      db.query<{ credential_enc: string }>(`SELECT credential_enc FROM operators WHERE name='OP-B'`),
    );
    expect(decrypt(keyB, opB.credential_enc)).toBe('CRED-B');
    expect(() => decrypt(keyA, opB.credential_enc)).toThrow();
  });

});
describe('the consumer-key-hash backfill (carry S1)', () => {
  it('claims every saved Daraja app, and a second boot has nothing left to claim', async () => {
    const orgId = await seedPhase2Dump(randomSecret(32));

    const first = await boot(config());
    expect(first.consumerKeysHashed).toBe(2); // production and sandbox

    const hashes = await withOrg(orgId, () =>
      db.query<{ key: string; value: string }>(
        `SELECT key, value FROM settings WHERE org_id = $1 AND key LIKE '%.consumerKeyHash' ORDER BY key`, [orgId]),
    );
    expect(hashes.map((r) => [r.key, r.value])).toEqual([
      ['env.production.consumerKeyHash', sha256('CK-live')],
      ['env.sandbox.consumerKeyHash', sha256('CK-sandbox')],
    ]);

    const again = await boot(config());
    expect(again.consumerKeysHashed).toBe(0);
  });

  it('leaves a hash that is already there exactly as it is', async () => {
    const orgId = await seedPhase2Dump(randomSecret(32));
    await withOrg(orgId, () =>
      db.query(`INSERT INTO settings(key, value, encrypted) VALUES ('env.sandbox.consumerKeyHash','already-claimed',false)`),
    );

    const r = await boot(config());
    expect(r.consumerKeysHashed).toBe(1); // production only
    const [kept] = await withOrg(orgId, () =>
      db.query<{ value: string }>(`SELECT value FROM settings WHERE org_id = $1 AND key='env.sandbox.consumerKeyHash'`, [orgId]),
    );
    expect(kept.value).toBe('already-claimed');
  });

  it('skips a key another organisation has already claimed instead of refusing to boot, and logs neither', async () => {
    const orgId = await seedPhase2Dump(randomSecret(32));
    // A second organisation holding the very same production key — possible only from before
    // settings_consumer_key_uniq existed, which is exactly the database this backfill walks into.
    const [{ id: other }] = await withSystem(() =>
      db.query<{ id: string }>(
        `INSERT INTO orgs(slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
         VALUES ('org-2','Other Ltd','verified',false,$1,$2,gen_random_bytes(32)) RETURNING id`,
        [sha256('other-secret'), encrypt(MASTER, 'other-secret')]),
    );
    await withOrg(other, () =>
      db.query(`INSERT INTO settings(key, value, encrypted) VALUES ('env.production.consumerKey',$1,true)`,
        [encrypt(MASTER, 'CK-live')]),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Three keys were unclaimed; one of them collides, so two are claimed and the boot survives.
      const r = await boot(config());
      expect(r.consumerKeysHashed).toBe(2);

      // The older organisation wins the claim (the pass walks orgs by created_at); the newer one
      // simply has none, and nothing is written under it.
      // The org_id predicate is load-bearing: on the admin pool (a superuser on this test DB)
      // row-level security is bypassed, so an unscoped SELECT would read every organisation's row.
      const [winner] = await withOrg(orgId, () =>
        db.query<{ value: string }>(`SELECT value FROM settings WHERE org_id = $1 AND key='env.production.consumerKeyHash'`, [orgId]));
      const loser = await withOrg(other, () =>
        db.query<{ value: string }>(`SELECT value FROM settings WHERE org_id = $1 AND key='env.production.consumerKeyHash'`, [other]));
      expect(winner.value).toBe(sha256('CK-live'));
      expect(loser).toEqual([]);

      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain(other);           // the organisation, so a host admin can find it
      expect(logged).not.toContain('CK-live');   // never the key
      expect(logged).not.toContain(sha256('CK-live')); // and never the claim itself
    } finally { warn.mockRestore(); }
  });
});

