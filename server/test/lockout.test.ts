import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createPool, type Db } from '../src/db/pool.js';
import { recordAttempt, MAX_FAILURES } from '../src/auth/lockout.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
let db: Db;
beforeAll(() => { db = createPool(url); });
afterAll(() => db.end());
beforeEach(() => db.query('TRUNCATE login_attempts'));

describe('lockout', () => {
  it('does not extend the lock or change failures while already locked', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await recordAttempt(db, ['k']);
    expect(last!.lockedUntil).not.toBeNull();
    expect(last!.failures).toBe(6);

    const row6 = (await db.query<{ failures: number; locked_until: Date }>(
      'SELECT failures, locked_until FROM login_attempts WHERE key=$1', ['k'],
    ))[0]!;

    const seventh = await recordAttempt(db, ['k']);
    expect(seventh.failures).toBe(row6.failures);
    expect(seventh.lockedUntil?.getTime()).toBe(row6.locked_until.getTime());

    const row7 = (await db.query<{ failures: number; locked_until: Date }>(
      'SELECT failures, locked_until FROM login_attempts WHERE key=$1', ['k'],
    ))[0]!;
    expect(row7.failures).toBe(row6.failures);
    expect(row7.locked_until.getTime()).toBe(row6.locked_until.getTime());
  });

  it('restarts failures at 1 and clears the lock once it (and the window) has expired', async () => {
    await recordAttempt(db, ['k']);
    await db.query(
      `UPDATE login_attempts SET locked_until = now() - interval '1 second', updated_at = now() - interval '16 minutes' WHERE key=$1`,
      ['k'],
    );
    const r = await recordAttempt(db, ['k']);
    expect(r.failures).toBe(1);
    expect(r.lockedUntil).toBeNull();
  });

  // Exactly MAX_FAILURES concurrent attempts must all land — zero headroom below
  // the threshold, so a lost increment (a real risk if the UPSERT weren't atomic) would show up
  // immediately as failures < MAX_FAILURES, and none of them should trip the lock.
  it('records every one of exactly MAX_FAILURES concurrent attempts, with no lock', async () => {
    await Promise.all(Array.from({ length: MAX_FAILURES }, () => recordAttempt(db, ['k'])));
    const row = (await db.query<{ failures: number; locked_until: Date | null }>(
      'SELECT failures, locked_until FROM login_attempts WHERE key=$1', ['k'],
    ))[0]!;
    expect(row.failures).toBe(MAX_FAILURES);
    expect(row.locked_until).toBeNull();
  });

  it('locks atomically under a concurrent burst, and stops counting once locked', async () => {
    await Promise.all(Array.from({ length: 10 }, () => recordAttempt(db, ['k'])));
    const row = (await db.query<{ failures: number; locked_until: Date | null }>(
      'SELECT failures, locked_until FROM login_attempts WHERE key=$1', ['k'],
    ))[0]!;
    // Postgres serializes the conflicting UPSERTs one at a time, so this is deterministic: the
    // count stops at MAX_FAILURES+1 (the attempt that engages the lock) rather than reaching 10 —
    // that is the fix. Failures cannot land above that, and never below it either.
    expect(row.failures).toBe(MAX_FAILURES + 1);
    expect(row.locked_until).not.toBeNull();
    expect(row.locked_until!.getTime()).toBeGreaterThan(Date.now());
  });
});
