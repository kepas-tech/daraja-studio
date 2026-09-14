import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import {
  encrypt,
  decrypt,
  randomSecret,
  sha256,
  deriveOrgKey,
  createKeyring,
  createDbKeyring,
  encryptForOrg,
  encryptWithOrgKey,
  decryptForOrg,
  type Keyring,
} from '../src/crypto/secrets.js';
import { withOrg, withSystem, resetContextForTests, createPool, createAdminPool, type Db } from '../src/db/pool.js';
import { TEST_ORG_ID, ensureStudioAppRole } from './helpers.js';

const key = Buffer.alloc(32, 1);
const other = Buffer.alloc(32, 2);

describe('secrets', () => {
  it('round-trips', () => {
    const packed = encrypt(key, 'hello');
    expect(packed.startsWith('v1:')).toBe(true);
    expect(packed).not.toContain('hello');
    expect(decrypt(key, packed)).toBe('hello');
  });
  it('uses a fresh iv each time', () => {
    expect(encrypt(key, 'x')).not.toBe(encrypt(key, 'x'));
  });
  it('fails with the wrong key', () => {
    expect(() => decrypt(other, encrypt(key, 'x'))).toThrow();
  });
  it('rejects tampered ciphertext', () => {
    const p = encrypt(key, 'x').split(':');
    p[3] = Buffer.from('zz').toString('base64');
    expect(() => decrypt(key, p.join(':'))).toThrow();
  });
  it('round-trips an empty string', () => {
    expect(decrypt(key, encrypt(key, ''))).toBe('');
  });
  it('rejects a five-segment ciphertext', () => {
    const packed = `${encrypt(key, 'x')}:zz`;
    expect(() => decrypt(key, packed)).toThrow(/bad ciphertext format/);
  });
  it('randomSecret is url-safe and long', () => {
    const s = randomSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBeGreaterThanOrEqual(43);
  });
  it('sha256 is stable', () => {
    expect(sha256('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
});

const MASTER = Buffer.alloc(32, 3);
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SALT_A = Buffer.alloc(32, 10);
const SALT_B = Buffer.alloc(32, 11);

function fakeKeyring(): { keyring: Keyring; loads: string[] } {
  const loads: string[] = [];
  const keyring = createKeyring(MASTER, async (orgId) => {
    loads.push(orgId);
    return orgId === ORG_A ? SALT_A : SALT_B;
  });
  return { keyring, loads };
}

describe('derived organisation keys', () => {
  afterEach(() => resetContextForTests());

  it('deriveOrgKey is deterministic, 32 bytes, and different for every organisation and salt', () => {
    const a = deriveOrgKey(MASTER, ORG_A, SALT_A);
    expect(a).toHaveLength(32);
    expect(deriveOrgKey(MASTER, ORG_A, SALT_A).equals(a)).toBe(true);
    // The organisation id is in the HKDF info, so the same salt still gives a different key.
    expect(deriveOrgKey(MASTER, ORG_B, SALT_A).equals(a)).toBe(false);
    expect(deriveOrgKey(MASTER, ORG_A, SALT_B).equals(a)).toBe(false);
    // And so is the master key.
    expect(deriveOrgKey(Buffer.alloc(32, 4), ORG_A, SALT_A).equals(a)).toBe(false);
    expect(a.equals(MASTER)).toBe(false);
  });

  it('the keyring derives once per organisation and hands the same key back', async () => {
    const { keyring, loads } = fakeKeyring();
    const first = await keyring.keyFor(ORG_A);
    const second = await keyring.keyFor(ORG_A);
    expect(second.equals(first)).toBe(true);
    await keyring.keyFor(ORG_B);
    expect(loads).toEqual([ORG_A, ORG_B]);
    keyring.invalidate(ORG_A);
    await keyring.keyFor(ORG_A);
    expect(loads).toEqual([ORG_A, ORG_B, ORG_A]);
    keyring.invalidate();
    await keyring.keyFor(ORG_B);
    expect(loads).toEqual([ORG_A, ORG_B, ORG_A, ORG_B]);
  });

  it('encryptForOrg writes v2 and round-trips inside the same organisation', async () => {
    const { keyring } = fakeKeyring();
    const packed = await withOrg(ORG_A, () => encryptForOrg(keyring, 'consumer-secret'));
    expect(packed.startsWith('v2:')).toBe(true);
    expect(packed).not.toContain('consumer-secret');
    expect(await withOrg(ORG_A, () => decryptForOrg(keyring, packed))).toBe('consumer-secret');
  });

  it('a v2 ciphertext copied into another organisation does not decrypt', async () => {
    const { keyring } = fakeKeyring();
    const packed = await withOrg(ORG_A, () => encryptForOrg(keyring, 'consumer-secret'));
    const ciphertextFromOrgA = packed.split(':')[3];
    // Pin the actual GCM authentication failure, not just any throw — a bare rejects.toThrow()
    // would also pass if the failure came from somewhere else entirely (a broken salt loader, a
    // future requireOrg regression, a format check).
    await expect(withOrg(ORG_B, () => decryptForOrg(keyring, packed))).rejects.toThrow(/unable to authenticate data/);
    // The ciphertext handed to ORG_B's failed attempt is byte-identical to what ORG_A produced —
    // proves the test really exercised the same v2 blob, not something re-encrypted along the way.
    expect(packed.split(':')[3]).toBe(ciphertextFromOrgA);
  });

  it('a v1 ciphertext still decrypts, under the master key, whatever the organisation', async () => {
    const { keyring } = fakeKeyring();
    const legacy = encrypt(MASTER, 'old value');
    expect(legacy.startsWith('v1:')).toBe(true);
    expect(await withOrg(ORG_A, () => decryptForOrg(keyring, legacy))).toBe('old value');
    expect(await withOrg(ORG_B, () => decryptForOrg(keyring, legacy))).toBe('old value');
    expect(await withSystem(() => decryptForOrg(keyring, legacy))).toBe('old value');
  });

  it('refuses to encrypt outside an organisation', async () => {
    const { keyring } = fakeKeyring();
    await expect(encryptForOrg(keyring, 'x')).rejects.toThrow(/outside an organisation/);
    await expect(withSystem(() => encryptForOrg(keyring, 'x'))).rejects.toThrow(/outside an organisation/);
  });

  it('refuses to read a v2 ciphertext outside an organisation', async () => {
    const { keyring } = fakeKeyring();
    const packed = await withOrg(ORG_A, () => encryptForOrg(keyring, 'x'));
    await expect(decryptForOrg(keyring, packed)).rejects.toThrow(/outside an organisation/);
  });

  it('rejects an unknown ciphertext version', async () => {
    const { keyring } = fakeKeyring();
    const bad = (await withOrg(ORG_A, () => encryptForOrg(keyring, 'x'))).replace(/^v2:/, 'v9:');
    await expect(withOrg(ORG_A, () => decryptForOrg(keyring, bad))).rejects.toThrow(/bad ciphertext format/);
  });

  it('decrypt(key, …) reads a v2 packing when it is handed the right key — the boot pass needs this', async () => {
    const { keyring } = fakeKeyring();
    const packed = await withOrg(ORG_A, () => encryptForOrg(keyring, 'x'));
    expect(decrypt(deriveOrgKey(MASTER, ORG_A, SALT_A), packed)).toBe('x');
    expect(() => decrypt(MASTER, packed)).toThrow();
  });

  it('encryptWithOrgKey packs the same way encryptForOrg does, for a key derived before any row exists', async () => {
    const { keyring } = fakeKeyring();
    // orgs.create derives this key itself, from (master, id, salt), before its row exists to read a
    // salt back out of — encryptWithOrgKey is what lets it still write a v2 ciphertext that
    // decryptForOrg's usual (org-context, keyFor) path can open afterwards.
    const preDerived = encryptWithOrgKey(deriveOrgKey(MASTER, ORG_A, SALT_A), 'consumer-secret');
    expect(preDerived.startsWith('v2:')).toBe(true);
    expect(await withOrg(ORG_A, () => decryptForOrg(keyring, preDerived))).toBe('consumer-secret');

    // Interchangeable with encryptForOrg for the same organisation: both derive the identical key
    // from (master, orgId, salt), so either can read what the other wrote.
    const viaEncryptForOrg = await withOrg(ORG_A, () => encryptForOrg(keyring, 'another-secret'));
    expect(await withOrg(ORG_A, () => decryptForOrg(keyring, viaEncryptForOrg))).toBe('another-secret');
    expect(decrypt(deriveOrgKey(MASTER, ORG_A, SALT_A), viaEncryptForOrg)).toBe('another-secret');
  });
});

describe('createDbKeyring (real Postgres)', () => {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
  const pools: Db[] = [];
  function track(db: Db): Db {
    pools.push(db);
    return db;
  }

  beforeAll(async () => {
    const admin = track(createAdminPool(url));
    await ensureStudioAppRole(admin);
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
  });

  it('on the studio_app pool, keyFor(A) returns a 32-byte key and loads the salt once, then memoises', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    const keyring = createDbKeyring(db, MASTER);
    const spy = vi.spyOn(db, 'query');
    const first = await withOrg(TEST_ORG_ID, () => keyring.keyFor(TEST_ORG_ID));
    expect(first).toHaveLength(32);
    expect(spy).toHaveBeenCalledTimes(1);
    const second = await withOrg(TEST_ORG_ID, () => keyring.keyFor(TEST_ORG_ID));
    expect(second.equals(first)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('under withOrg(A), keyFor of an organisation that does not exist fails with the missing-organisation error', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    const keyring = createDbKeyring(db, MASTER);
    const unknownOrgId = '99999999-9999-4999-8999-999999999999';
    await expect(withOrg(TEST_ORG_ID, () => keyring.keyFor(unknownOrgId))).rejects.toThrow(`no organisation ${unknownOrgId}`);
  });

  it('the same lookup works on the admin pool', async () => {
    const db = track(createAdminPool(url));
    const keyring = createDbKeyring(db, MASTER);
    const key = await keyring.keyFor(TEST_ORG_ID);
    expect(key).toHaveLength(32);
  });

  it('key_salt arrives as a Buffer of the length migration 007 generates, and the derived key matches deriveOrgKey', async () => {
    const admin = track(createAdminPool(url));
    const rows = await withSystem(() => admin.query<{ key_salt: Buffer }>('SELECT key_salt FROM orgs WHERE id = $1', [TEST_ORG_ID]));
    const salt = rows[0].key_salt;
    expect(Buffer.isBuffer(salt)).toBe(true);
    expect(salt).toHaveLength(32);
    const db = track(createPool(url, { role: 'studio_app' }));
    const keyring = createDbKeyring(db, MASTER);
    const key = await withOrg(TEST_ORG_ID, () => keyring.keyFor(TEST_ORG_ID));
    expect(key.equals(deriveOrgKey(MASTER, TEST_ORG_ID, salt))).toBe(true);
  });
});
