import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { createPool, createAdminPool, withOrg, withSystem, currentOrgId, resetContextForTests, type Db } from '../src/db/pool.js';
import { ensureStudioAppRole } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const pools: Db[] = [];
function track(db: Db) {
  pools.push(db);
  return db;
}
afterAll(async () => {
  for (const p of pools) await p.end();
});

beforeAll(async () => {
  const admin = track(createAdminPool(url));
  await ensureStudioAppRole(admin);
});

describe('pool', () => {
  it('an emitted pool error does not crash the process and the pool keeps answering queries', async () => {
    const db = track(createPool(url));
    expect(() => db.pool.emit('error', new Error('boom'))).not.toThrow();
    const rows = await db.query<{ '?column?': number }>('SELECT 1');
    expect(rows[0]).toBeTruthy();
  });

  it('the app pool assumes studio_app on every connection', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    const a = await db.query<{ cur: string; login: string }>('SELECT current_user AS cur, session_user AS login');
    expect(a[0].cur).toBe('studio_app');
    expect(a[0].login).not.toBe('studio_app');
    // A second checkout gets a second connection from the same pool; it must be just as limited.
    const [b, c] = await Promise.all([
      db.query<{ cur: string }>('SELECT current_user AS cur'),
      db.query<{ cur: string }>('SELECT current_user AS cur'),
    ]);
    expect(b[0].cur).toBe('studio_app');
    expect(c[0].cur).toBe('studio_app');
  });

  it('the app pool keeps the role inside a transaction', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    const cur = await db.tx(async (c) => (await c.query('SELECT current_user AS cur')).rows[0].cur as string);
    expect(cur).toBe('studio_app');
  });

  it('the admin pool does not assume the role', async () => {
    const db = track(createAdminPool(url));
    const rows = await db.query<{ cur: string }>('SELECT current_user AS cur');
    expect(rows[0].cur).not.toBe('studio_app');
  });

  it('a SET ROLE failure on checkout rejects the caller, does not kill the process, and leaves a role-less pool usable', async () => {
    // The local test user is a superuser, so revoking the grant would not stop it assuming the
    // role; renaming the role away is what makes SET ROLE fail regardless of privilege. Migration
    // 007 grants studio_app real table/sequence privileges, so DROP ROLE now fails ("some objects
    // depend on it") — a rename is a no-op for every grant (Postgres tracks role membership and
    // ACLs by OID, not name) and renaming back restores the role exactly as it was.
    const admin = track(createAdminPool(url));
    await admin.query('ALTER ROLE studio_app RENAME TO studio_app_disabled');
    try {
      const db = track(createPool(url, { role: 'studio_app' }));
      await expect(db.query('SELECT 1')).rejects.toThrow();
      // The process is still here to run this assertion, and a role-less pool is unaffected.
      const plain = track(createPool(url));
      const rows = await plain.query<{ '?column?': number }>('SELECT 1');
      expect(rows[0]).toBeTruthy();
    } finally {
      await admin.query('ALTER ROLE studio_app_disabled RENAME TO studio_app');
    }
  });

  it('a stray RESET ROLE inside tx is caught on the next statement, and the connection is evicted rather than reused', async () => {
    // max: 1 pins the pool to one physical connection, so the RESET ROLE really is still there
    // when the next call checks out a connection.
    const db = track(createPool(url, { role: 'studio_app', max: 1 }));
    await db.tx(async (c) => { await c.query('RESET ROLE'); });
    await expect(db.query('SELECT 1')).rejects.toThrow('connection lost its application role');
    // The broken connection was evicted, not returned to the pool: the next checkout is a fresh
    // connection that gets SET ROLE studio_app applied again.
    const rows = await db.query<{ cur: string }>('SELECT current_user AS cur');
    expect(rows[0].cur).toBe('studio_app');
  });
});

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

async function guc(db: Db) {
  const rows = await db.query<{ org: string; role: string }>(
    `SELECT current_setting('app.org_id', true) AS org, current_setting('app.role', true) AS role`,
  );
  return rows[0];
}

describe('organisation context', () => {
  afterEach(() => resetContextForTests());

  it('withOrg puts the organisation on every statement it issues', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    await withOrg(ORG_A, async () => {
      expect(currentOrgId()).toBe(ORG_A);
      expect(await guc(db)).toEqual({ org: ORG_A, role: '' });
      // Nested asynchronous work keeps the context.
      await Promise.all([
        (async () => expect((await guc(db)).org).toBe(ORG_A))(),
        (async () => expect((await guc(db)).org).toBe(ORG_A))(),
      ]);
    });
  });

  it('two organisations running concurrently never see each other\'s context', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    const [a, b] = await Promise.all([
      withOrg(ORG_A, async () => (await guc(db)).org),
      withOrg(ORG_B, async () => (await guc(db)).org),
    ]);
    expect(a).toBe(ORG_A);
    expect(b).toBe(ORG_B);
  });

  it('withSystem sets app.role and no organisation', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    await withSystem(async () => {
      expect(currentOrgId()).toBeNull();
      expect(await guc(db)).toEqual({ org: '', role: 'system' });
    });
  });

  it('the innermost context wins, in both directions', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    await withSystem(async () => {
      await withOrg(ORG_A, async () => expect(await guc(db)).toEqual({ org: ORG_A, role: '' }));
      expect(await guc(db)).toEqual({ org: '', role: 'system' });
    });
    await withOrg(ORG_A, async () => {
      await withSystem(async () => expect(await guc(db)).toEqual({ org: '', role: 'system' }));
      expect(await guc(db)).toEqual({ org: ORG_A, role: '' });
    });
  });

  it('outside any context, and with no fallback, there is no organisation', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    expect(currentOrgId()).toBeNull();
    expect(await guc(db)).toEqual({ org: '', role: '' });
  });

  it('the fallback covers code that never entered a context, and only that code', async () => {
    const db = track(createPool(url, { role: 'studio_app' }));
    db.setFallbackOrg(ORG_A);
    expect(currentOrgId()).toBe(ORG_A);
    expect((await guc(db)).org).toBe(ORG_A);
    // An explicit context always beats the fallback.
    await withOrg(ORG_B, async () => expect((await guc(db)).org).toBe(ORG_B));
    // withSystem is never turned into an organisation by the fallback.
    await withSystem(async () => {
      expect(currentOrgId()).toBeNull();
      expect(await guc(db)).toEqual({ org: '', role: 'system' });
    });
    db.setFallbackOrg(null);
    expect((await guc(db)).org).toBe('');
  });

  it('the fallback belongs to the pool it was set on, so a hosted pool beside it still sees nothing', async () => {
    const one = track(createPool(url, { role: 'studio_app' }));
    const two = track(createPool(url, { role: 'studio_app' }));
    one.setFallbackOrg(ORG_A);
    expect((await guc(one)).org).toBe(ORG_A);
    // `two` is the shape hosted mode builds: nobody set a fallback on it, so its statements carry
    // no organisation even though another pool in this process has one.
    expect((await guc(two)).org).toBe('');
    // currentOrgId() has no pool of its own, so it answers with the fallback that was last set —
    // the value single mode's boot pass installs, and what encryptForOrg and enqueue read.
    expect(currentOrgId()).toBe(ORG_A);
  });

  it('tx sets the organisation for the transaction only', async () => {
    // max: 1 pins the pool to one physical connection, so what survives COMMIT is observable.
    const db = track(createPool(url, { role: 'studio_app', max: 1 }));
    const inside = await withOrg(ORG_A, () =>
      db.tx(async (c) => (await c.query(`SELECT current_setting('app.org_id', true) AS v`)).rows[0].v as string),
    );
    expect(inside).toBe(ORG_A);
    // Read the same connection behind the wrapper's back: a transaction-local setting is gone.
    const raw = await db.pool.query(`SELECT current_setting('app.org_id', true) AS v`);
    expect(raw.rows[0].v).toBe('');
  });

  it('a transaction that rolls back does not leave its organisation behind', async () => {
    const db = track(createPool(url, { role: 'studio_app', max: 1 }));
    await expect(
      withOrg(ORG_A, () =>
        db.tx(async () => {
          throw new Error('deliberate');
        }),
      ),
    ).rejects.toThrow('deliberate');
    const raw = await db.pool.query(`SELECT current_setting('app.org_id', true) AS v`);
    expect(raw.rows[0].v).toBe('');
  });

  it('a later statement in a different context overwrites the previous one on a reused connection', async () => {
    const db = track(createPool(url, { role: 'studio_app', max: 1 }));
    await withOrg(ORG_A, async () => expect((await guc(db)).org).toBe(ORG_A));
    await withOrg(ORG_B, async () => expect((await guc(db)).org).toBe(ORG_B));
    await withSystem(async () => expect(await guc(db)).toEqual({ org: '', role: 'system' }));
  });

  it('the admin pool carries the context too', async () => {
    const db = track(createAdminPool(url));
    await withOrg(ORG_A, async () => expect((await guc(db)).org).toBe(ORG_A));
  });

  it('a stale session-level context left by an earlier query is overwritten by the next tx or query, whatever it left behind', async () => {
    // max: 1 pins the pool to one physical connection, so what a prior call left on it is observable.
    const db = track(createPool(url, { role: 'studio_app', max: 1 }));
    await withSystem(() => db.query('SELECT 1'));
    // Pin the invariant: read the raw connection behind the wrapper's back and see the stale
    // 'system' role really is still there — this is what makes the rest of the test worth anything.
    const raw = await db.pool.query(`SELECT current_setting('app.role', true) AS r`);
    expect(raw.rows[0].r).toBe('system');
    // On the same connection, with no context at all: a tx sees none of the stale 'system' role...
    const inTx = await db.tx(async (c) => (await c.query(`SELECT current_setting('app.org_id', true) AS org, current_setting('app.role', true) AS role`)).rows[0]);
    expect(inTx).toEqual({ org: '', role: '' });
    // ...and neither does a plain query after it.
    expect(await guc(db)).toEqual({ org: '', role: '' });
  });

  it('tx honours a context change inside the callback: a nested withOrg reapplies before its own statement, and the outer context resumes after', async () => {
    const db = track(createPool(url, { role: 'studio_app', max: 1 }));
    await withOrg(ORG_A, () =>
      db.tx(async (c) => {
        const inner = await withOrg(ORG_B, () => c.query(`SELECT current_setting('app.org_id', true) AS v`));
        expect(inner.rows[0].v).toBe(ORG_B);
        const after = await c.query(`SELECT current_setting('app.org_id', true) AS v`);
        expect(after.rows[0].v).toBe(ORG_A);
      }),
    );
  });

  it('withSystem nested inside withOrg inside tx sets app.role for that statement only', async () => {
    const db = track(createPool(url, { role: 'studio_app', max: 1 }));
    await withOrg(ORG_A, () =>
      db.tx(async (c) => {
        const sys = await withSystem(() =>
          c.query(`SELECT current_setting('app.org_id', true) AS org, current_setting('app.role', true) AS role`),
        );
        expect(sys.rows[0]).toEqual({ org: '', role: 'system' });
        const after = await c.query(`SELECT current_setting('app.org_id', true) AS org, current_setting('app.role', true) AS role`);
        expect(after.rows[0]).toEqual({ org: ORG_A, role: '' });
      }),
    );
  });

  it('concurrent statements on a tx client are serialised so a sibling statement never lands between a re-apply and its own statement', async () => {
    const db = track(createPool(url, { role: 'studio_app', max: 1 }));
    for (let i = 0; i < 20; i++) {
      const [nested, outer] = await withOrg(ORG_A, () =>
        db.tx((c) =>
          Promise.all([
            withOrg(ORG_B, () => c.query(`SELECT current_setting('app.org_id', true) AS o`)),
            c.query(`SELECT current_setting('app.org_id', true) AS o`),
          ]),
        ),
      );
      expect(nested.rows[0].o).toBe(ORG_B);
      expect(outer.rows[0].o).toBe(ORG_A);
    }
  });
});
