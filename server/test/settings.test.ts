import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, type Db } from '../src/db/pool.js';
import { createDbKeyring, type Keyring } from '../src/crypto/secrets.js';
import { createSettings } from '../src/settings/store.js';
import { resetTables, ensureTestOrg, TEST_ORG_ID, TEST_KEY } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
let db: Db;
let keyring: Keyring;
beforeAll(async () => {
  db = createPool(url);
  await resetTables(db);
  await ensureTestOrg();
  db.setFallbackOrg(TEST_ORG_ID);
  keyring = createDbKeyring(db, Buffer.from(TEST_KEY, 'base64'));
});
afterAll(() => db.end());

describe('settings', () => {
  it('stores plain and encrypted values', async () => {
    const s = createSettings(db, keyring);
    await s.set('org.name', 'APIONE');
    await s.set('env.sandbox.consumerSecret', 'topsecret');
    expect(await s.get('org.name')).toBe('APIONE');
    expect(await s.get('env.sandbox.consumerSecret')).toBe('topsecret');
    const raw = await db.query<{ value: string; encrypted: boolean }>(`SELECT value, encrypted FROM settings WHERE key='env.sandbox.consumerSecret'`);
    expect(raw[0].encrypted).toBe(true);
    expect(raw[0].value).not.toContain('topsecret');
  });
  it('returns null for missing, and getMany', async () => {
    const s = createSettings(db, keyring);
    expect(await s.get('public.url')).toBeNull();
    const m = await s.getMany(['org.name', 'public.url']);
    expect(m['org.name']).toBe('APIONE');
    expect(m['public.url']).toBeNull();
  });

  // The B2C API version and its detection are plain settings, not secrets.
  it('stores the B2C API version and detection keys unencrypted', async () => {
    const s = createSettings(db, keyring);
    await s.set('env.sandbox.b2cApi', 'v1');
    await s.set('env.sandbox.b2cApiDetected', 'v1');
    const raw = await db.query<{ key: string; encrypted: boolean }>(`SELECT key, encrypted FROM settings WHERE key IN ('env.sandbox.b2cApi','env.sandbox.b2cApiDetected')`);
    expect(raw.every((r) => r.encrypted === false)).toBe(true);
  });

  // A9: encryption is decided by ENCRYPTED_KEYS alone — set() no longer takes a per-call override.
  it('ignores a stray third argument; encryption is decided by ENCRYPTED_KEYS alone', async () => {
    const s = createSettings(db, keyring);
    await (s.set as (k: string, v: string, opts?: unknown) => Promise<void>)('org.name', 'ExplicitPlain', { encrypted: true });
    const raw = await db.query<{ value: string; encrypted: boolean }>(`SELECT value, encrypted FROM settings WHERE key='org.name'`);
    expect(raw[0].encrypted).toBe(false);
    expect(raw[0].value).toBe('ExplicitPlain');
  });
});
