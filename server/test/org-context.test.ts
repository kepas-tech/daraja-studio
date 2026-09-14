import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { withOrg, withSystem, createAdminPool, type Db } from '../src/db/pool.js';
import { hashPassword } from '../src/auth/password.js';
import { makeApp, resetTables, loginAsOwner, deleteOrg, TEST_ORG_ID, TEST_SECRET } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const ORG_B = '00000000-0000-4000-8000-0000000000b6';
const admin: Db = createAdminPool(url);
const { app, deps, close } = makeApp();

afterAll(async () => {
  // Not a bare DELETE: this file writes audit rows into ORG_B, audit_log.org_id cascades, and the
  // append-only trigger fires on the cascade. deleteOrg is the privileged path (helpers.ts).
  await deleteOrg(ORG_B);
  await admin.end();
  await close();
});

beforeEach(async () => {
  await resetTables();
  await withSystem(() =>
    admin.query(
      `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ($1,'org-context-b','Second organisation','verified',false,'hash-b6','unset',gen_random_bytes(32))
       ON CONFLICT (id) DO NOTHING`,
      [ORG_B],
    ),
  );
});

/** A person in the second organisation, so a session can be pointed anywhere. */
async function personInOrgB() {
  const hash = await hashPassword('correct horse battery');
  const [p] = await withOrg(ORG_B, () =>
    deps.db.query<{ id: string }>(
      `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('other','Other',$1,true) RETURNING id`,
      [hash],
    ),
  );
  return p.id;
}

describe('orgContext', () => {
  it('puts an authenticated request inside its own organisation', async () => {
    const { cookie, csrf } = await loginAsOwner(app, deps);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.person.username).toBe('owner');
    expect(csrf).toBeTruthy();

    // Settings written through the API belong to organisation #1 and nobody else.
    // requireStepUp (unchanged by this task) needs the owner's own password alongside the body
    // the org schema requires (name, nominatedNumber, notificationPhone) — the literal
    // `{ name: 'Mine' }` 403s against the landed settings/routes.ts before ever reaching the
    // store, so this adapts the request body to what that already-landed route actually needs.
    const put = await request(app)
      .put('/api/settings/org')
      .set('Cookie', cookie)
      .set('x-csrf-token', csrf)
      .send({ name: 'Mine', nominatedNumber: '254712345678', notificationPhone: '254712345678', password: 'correct horse' });
    expect(put.status).toBe(204);
    const mine = await withOrg(TEST_ORG_ID, () => deps.db.query<{ value: string }>(`SELECT value FROM settings WHERE key='org.name'`));
    const theirs = await withOrg(ORG_B, () => deps.db.query(`SELECT value FROM settings WHERE key='org.name'`));
    expect(mine[0]?.value).toBe('Mine');
    expect(theirs).toEqual([]);
  });

  it('logs a person in to their own organisation, not organisation #1', async () => {
    await resetTables();
    const personId = await personInOrgB();
    const r = await request(app).post('/api/auth/login').send({ username: 'other', password: 'correct horse battery' });
    expect(r.status).toBe(200);
    const [session] = await withSystem(() =>
      deps.db.query<{ org_id: string; person_id: string }>('SELECT org_id, person_id FROM sessions'),
    );
    expect(session.person_id).toBe(personId);
    expect(session.org_id).toBe(ORG_B);
  });

  it('a session pointed at another organisation still only sees its person\'s organisation', async () => {
    const { cookie } = await loginAsOwner(app, deps);
    const sessionId = cookie.split('=')[1].split(';')[0];
    // Tamper with the session row the way a stolen-and-edited row would look.
    await withSystem(() => deps.db.query('UPDATE sessions SET org_id = $2 WHERE id = $1', [sessionId, ORG_B]));
    await withOrg(ORG_B, () => deps.db.query(`INSERT INTO settings(key, value) VALUES ('org.name','Not yours')`));

    const r = await request(app).get('/api/settings').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('Not yours');
  });

  it('answers 401 with the right sentence for no cookie, a dead session and a suspended person', async () => {
    // errorMiddleware (src/util/errors.ts, unchanged by this task) nests the message under
    // `error.message`, not top-level `message` — `.body.message` never matches.
    const none = await request(app).get('/api/auth/me');
    expect(none.status).toBe(401);
    expect(none.body.error.message).toBe('Please log in.');

    const { cookie } = await loginAsOwner(app, deps);
    await withSystem(() => deps.db.query('DELETE FROM sessions'));
    const dead = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(dead.status).toBe(401);
    expect(dead.body.error.message).toBe('Your session has ended. Please log in again.');

    const { cookie: live } = await loginAsOwner(app, deps);
    await withOrg(TEST_ORG_ID, () => deps.db.query(`UPDATE people SET status='suspended'`));
    const off = await request(app).get('/api/auth/me').set('Cookie', live);
    expect(off.status).toBe(401);
    expect(off.body.error.message).toBe('This account is not active.');
  });

  it('a failed login for an unknown username writes no audit row and still counts the attempt', async () => {
    await resetTables();
    // audit_log is append-only and resetTables() never truncates it (helpers.ts), so other tests
    // in this file leave rows behind — compare before/after instead of assuming it starts empty.
    const before = await withSystem(() => deps.db.query('SELECT id FROM audit_log'));
    const r = await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'nope' });
    expect(r.status).toBe(401);
    expect(await withSystem(() => deps.db.query('SELECT id FROM audit_log'))).toEqual(before);
    const [att] = await deps.db.query<{ failures: number }>(`SELECT failures FROM login_attempts WHERE key='u:ghost'`);
    expect(att.failures).toBe(1);
  });

  it('a failed login for a known username is audited inside that person\'s organisation', async () => {
    await resetTables();
    await personInOrgB();
    await request(app).post('/api/auth/login').send({ username: 'other', password: 'wrong' });
    // Scoped to this test's own target, for the same reason as above (operators.test.ts's
    // "rotate on a nonexistent operator" test establishes the same pattern).
    const rows = await withSystem(() =>
      deps.db.query<{ org_id: string; action: string }>(`SELECT org_id, action FROM audit_log WHERE action='auth.login_failed' AND target='other'`),
    );
    expect(rows).toEqual([{ org_id: ORG_B, action: 'auth.login_failed' }]);
  });
});

describe('organisation service', () => {
  it('finds an organisation by the hash of its callback secret, and nothing by a wrong hash', async () => {
    const found = await deps.orgs.bySecretHash('hash-b6');
    expect(found).toMatchObject({ id: ORG_B, slug: 'org-context-b', status: 'verified', isHost: false });
    expect(await deps.orgs.bySecretHash('not-a-hash')).toBeNull();
  });

  it('reveals an organisation\'s own callback secret, and another organisation\'s is neither visible nor readable', async () => {
    const { encryptForOrg, decryptForOrg } = await import('../src/crypto/secrets.js');
    const mine = 'a-secret-value';
    const theirs = 'the-other-organisations-secret';
    // Both organisations get a *real* v2 ciphertext. Leaving ORG_B on the literal 'unset' made the
    // old assertion pass on `bad ciphertext format`, proving nothing about isolation (pre-flight
    // R1/S4). What has to fail here is the key and the policy, not the parse.
    const encMine = await withOrg(TEST_ORG_ID, () => encryptForOrg(deps.keyring, mine));
    const encTheirs = await withOrg(ORG_B, () => encryptForOrg(deps.keyring, theirs));
    // `orgs` is never truncated by resetTables(), so organisation #1's row is shared with every
    // other test file in the same run, and ensureTestOrg() only repairs a literal 'unset'
    // ciphertext, not a wrong one — try/finally restores the real secret even if an assertion below
    // throws, so a failure here can never corrupt every other file that derives callback URLs from
    // this row.
    try {
      await withSystem(async () => {
        await admin.query('UPDATE orgs SET callback_secret_enc=$2 WHERE id=$1', [TEST_ORG_ID, encMine]);
        await admin.query('UPDATE orgs SET callback_secret_enc=$2 WHERE id=$1', [ORG_B, encTheirs]);
      });

      expect(await deps.orgs.revealSecret(TEST_ORG_ID)).toBe(mine);

      // Inside organisation #1, ORG_B's row does not exist…
      expect(
        await withOrg(TEST_ORG_ID, () => deps.db.query('SELECT callback_secret_enc FROM orgs WHERE id=$1', [ORG_B])),
      ).toEqual([]);
      // …and even holding its ciphertext, organisation #1's key does not open it.
      await expect(withOrg(TEST_ORG_ID, () => decryptForOrg(deps.keyring, encTheirs))).rejects.toThrow();
    } finally {
      const restored = await withOrg(TEST_ORG_ID, () => encryptForOrg(deps.keyring, TEST_SECRET));
      await withSystem(() => admin.query('UPDATE orgs SET callback_secret_enc=$2 WHERE id=$1', [TEST_ORG_ID, restored]));
    }
  });

  it('refuses to reveal another organisation\'s secret from outside it', async () => {
    // No withOrg/withSystem wrapper: currentOrgId() falls back to TEST_ORG_ID, which is not ORG_B.
    await expect(deps.orgs.revealSecret(ORG_B)).rejects.toThrow('organisation mismatch');
  });
});
