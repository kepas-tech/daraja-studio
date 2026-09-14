import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { withOrg, withSystem, resetContextForTests } from '../src/db/pool.js';
import { ROLE_PRESETS } from '../src/permissions/roles.js';
import { makeApp, makePerson, loginAs, resetTables, ensureTestOrg, TEST_ORG_ID } from './helpers.js';

const PASSWORD = 'correct horse battery';
const TEMP = 'temporary horse 12';

const single = makeApp();

afterAll(async () => {
  await single.close();
  resetContextForTests();
});

beforeEach(async () => {
  await resetTables();
  await ensureTestOrg();
  await makePerson(single.deps.db, TEST_ORG_ID, { username: 'owner', password: PASSWORD, displayName: 'Owner', isOwner: true, role: 'owner' });
});

describe('login', () => {
  it('is not case-sensitive about the username', async () => {
    const r = await request(single.app).post('/api/auth/login').send({ username: 'OWNER', password: PASSWORD });
    expect(r.status).toBe(200);
  });

  it('answers a closed organisation exactly like a wrong password, and audits nothing', async () => {
    // audit_log is insert-only and shared with every other test file's runs against this
    // install's one organisation, so the real assertion is "no new row", not "no rows at all".
    const before = (await withOrg(TEST_ORG_ID, () => single.deps.db.query('SELECT id FROM audit_log'))).length;
    await withSystem(() => single.deps.db.query(`UPDATE orgs SET status='closed' WHERE id=$1`, [TEST_ORG_ID]));
    const closed = await request(single.app).post('/api/auth/login').send({ username: 'owner', password: PASSWORD });
    const wrong = await request(single.app).post('/api/auth/login').send({ username: 'owner', password: 'not the password' });
    expect(closed.status).toBe(wrong.status);
    expect(closed.body).toEqual(wrong.body);
    expect(closed.body.error).toMatchObject({ code: 'bad_login', message: 'Wrong username or password.' });
    const after = (await withOrg(TEST_ORG_ID, () => single.deps.db.query('SELECT id FROM audit_log'))).length;
    expect(after).toBe(before);
  });

  it('logs in with any case and still finds the one person', async () => {
    const r = await request(single.app).post('/api/auth/login').send({ username: 'OWNER', password: PASSWORD });
    expect(r.status).toBe(200);
  });
});

describe('GET /api/people', () => {
  it('is the owner\'s page only', async () => {
    await makePerson(single.deps.db, TEST_ORG_ID, { username: 'staff', password: PASSWORD, role: 'viewer' });
    const { cookie, csrf } = await loginAs(single.app, 'staff', PASSWORD);
    const r = await request(single.app).get('/api/people').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('owner_only');
  });

  // Migration 008 sets is_host_admin on this install's owner, but there is no host console for it
  // to mean anything — it must never read true, and it grants no extra access either.
  it('never reports a host admin, and the flag grants no extra access, even when the column is set', async () => {
    await withOrg(TEST_ORG_ID, () => single.deps.db.query(`UPDATE people SET is_host_admin = true WHERE username = 'owner'`));
    const { cookie, csrf } = await loginAs(single.app, 'owner', PASSWORD);
    const r = await request(single.app).get('/api/people').set('Cookie', cookie).set('x-csrf-token', csrf);
    expect(r.status).toBe(200);
    expect(r.body[0].isHostAdmin).toBe(false);

    await makePerson(single.deps.db, TEST_ORG_ID, { username: 'solo', password: PASSWORD, role: 'viewer', hostAdmin: true });
    const solo = await loginAs(single.app, 'solo', PASSWORD);
    const denied = await request(single.app).get('/api/people').set('Cookie', solo.cookie).set('x-csrf-token', solo.csrf);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('owner_only');
  });
});

describe('POST /api/people', () => {
  it('adds a viewer with exactly the viewer permissions, who must change the password first', async () => {
    const { cookie, csrf } = await loginAs(single.app, 'owner', PASSWORD);
    const r = await request(single.app).post('/api/people').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ displayName: 'Grace', username: 'grace', role: 'viewer', temporaryPassword: TEMP, password: PASSWORD });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ username: 'grace', email: null, role: 'viewer', mustChangePassword: true, isOwner: false });
    // PersonView's contract says this key always exists; a newly added person is never a host admin.
    expect(r.body.isHostAdmin).toBe(false);

    const perms = await withOrg(TEST_ORG_ID, () =>
      single.deps.db.query<{ permission: string }>('SELECT permission FROM permissions WHERE person_id=$1 ORDER BY permission', [r.body.id]),
    );
    expect(perms.map((p) => p.permission)).toEqual([...ROLE_PRESETS.viewer].sort());
  });

  it('gives the new person exactly what their role allows and nothing else', async () => {
    const owner = await loginAs(single.app, 'owner', PASSWORD);
    await request(single.app).post('/api/people').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf)
      .send({ displayName: 'Grace', username: 'grace', role: 'viewer', temporaryPassword: TEMP, password: PASSWORD });

    const viewer = await loginAs(single.app, 'grace', TEMP);
    const changed = await request(single.app).post('/api/auth/change-password').set('Cookie', viewer.cookie).set('x-csrf-token', viewer.csrf)
      .send({ currentPassword: TEMP, newPassword: PASSWORD });
    expect(changed.status).toBe(204);
    const send = await request(single.app).post('/api/send/phone').set('Cookie', viewer.cookie).set('x-csrf-token', viewer.csrf)
      .send({ phone: '254700000000', amountCents: 1000, password: TEMP });
    expect(send.status).toBe(403);
    expect(send.body.error.code).toBe('no_permission');

    const history = await request(single.app).get('/api/requests').set('Cookie', viewer.cookie).set('x-csrf-token', viewer.csrf);
    expect(history.status).toBe(200);
    expect(history.body.items).toEqual([]);
  });

  it('needs the owner\'s own password', async () => {
    const { cookie, csrf } = await loginAs(single.app, 'owner', PASSWORD);
    const r = await request(single.app).post('/api/people').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ displayName: 'Grace', username: 'grace', role: 'viewer', temporaryPassword: TEMP });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('step_up_required');
  });

  it('refuses a new person whose username differs from an existing one only by case', async () => {
    const { cookie, csrf } = await loginAs(single.app, 'owner', PASSWORD);
    const r = await request(single.app).post('/api/people').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ displayName: 'Impostor', username: 'OWNER', role: 'operator', temporaryPassword: TEMP, password: PASSWORD });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('username_taken');
  });
});

describe('changing what somebody can do', () => {
  async function withViewer() {
    const owner = await loginAs(single.app, 'owner', PASSWORD);
    const made = await request(single.app).post('/api/people').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf)
      .send({ displayName: 'Grace', username: 'grace', role: 'viewer', temporaryPassword: TEMP, password: PASSWORD });
    return { owner, id: made.body.id as string };
  }

  it('replaces the permissions when the role changes', async () => {
    const { owner, id } = await withViewer();
    const r = await request(single.app).put(`/api/people/${id}/role`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf)
      .send({ role: 'operator', password: PASSWORD });
    expect(r.status).toBe(200);
    const perms = await withOrg(TEST_ORG_ID, () =>
      single.deps.db.query<{ permission: string }>('SELECT permission FROM permissions WHERE person_id=$1 ORDER BY permission', [id]),
    );
    expect(perms.map((p) => p.permission)).toEqual([...ROLE_PRESETS.operator].sort());
  });

  it('will not make anybody an owner', async () => {
    const { owner, id } = await withViewer();
    const r = await request(single.app).put(`/api/people/${id}/role`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf)
      .send({ role: 'owner', password: PASSWORD });
    expect(r.status).toBe(400);
  });

  it('resets a password, forces a change and ends their sessions', async () => {
    const { owner, id } = await withViewer();
    const viewer = await loginAs(single.app, 'grace', TEMP);
    const r = await request(single.app).post(`/api/people/${id}/reset-password`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf)
      .send({ temporaryPassword: 'another horse 34', password: PASSWORD });
    expect(r.status).toBe(204);
    expect((await request(single.app).get('/api/auth/me').set('Cookie', viewer.cookie)).status).toBe(401);
    const again = await loginAs(single.app, 'grace', 'another horse 34');
    const me = await request(single.app).get('/api/auth/me').set('Cookie', again.cookie);
    expect(me.body.person.must_change_password).toBe(true);
  });

  it('suspends and resumes, and a suspended person cannot log in', async () => {
    const { owner, id } = await withViewer();
    const viewer = await loginAs(single.app, 'grace', TEMP);
    expect((await request(single.app).post(`/api/people/${id}/suspend`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).send({ password: PASSWORD })).status).toBe(204);
    expect((await request(single.app).get('/api/auth/me').set('Cookie', viewer.cookie)).status).toBe(401);
    expect((await request(single.app).post('/api/auth/login').send({ username: 'grace', password: TEMP })).status).toBe(401);

    expect((await request(single.app).post(`/api/people/${id}/resume`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).send({ password: PASSWORD })).status).toBe(204);
    expect((await request(single.app).post('/api/auth/login').send({ username: 'grace', password: TEMP })).status).toBe(200);
  });

  it('refuses to touch the owner', async () => {
    const owner = await loginAs(single.app, 'owner', PASSWORD);
    const [me] = await withOrg(TEST_ORG_ID, () => single.deps.db.query<{ id: string }>('SELECT id FROM people WHERE is_owner'));
    const r = await request(single.app).post(`/api/people/${me.id}/suspend`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf).send({ password: PASSWORD });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('not_the_owner');
  });

  it('leaves a custom person\'s existing permissions alone when their role is set to custom again', async () => {
    const { owner, id } = await withViewer();
    await request(single.app).put(`/api/people/${id}/role`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf)
      .send({ role: 'operator', password: PASSWORD });
    const r = await request(single.app).put(`/api/people/${id}/role`).set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf)
      .send({ role: 'custom', password: PASSWORD });
    expect(r.status).toBe(200);
    const perms = await withOrg(TEST_ORG_ID, () =>
      single.deps.db.query<{ permission: string }>('SELECT permission FROM permissions WHERE person_id=$1 ORDER BY permission', [id]),
    );
    expect(perms.map((p) => p.permission)).toEqual([...ROLE_PRESETS.operator].sort());
  });

  it('has the People page too, with a plain username', async () => {
    const { cookie, csrf } = await loginAs(single.app, 'owner', PASSWORD);
    const r = await request(single.app).post('/api/people').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ displayName: 'Grace', username: 'grace2', role: 'operator', temporaryPassword: TEMP, password: PASSWORD });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ username: 'grace2', email: null, role: 'operator' });
  });
});
