import { afterAll, beforeEach, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, makePerson, loginAs, resetTables, ensureTestOrg, TEST_ORG_ID } from './helpers.js';

const single = makeApp();
afterAll(async () => { await single.close(); });
beforeEach(async () => { await resetTables(); await ensureTestOrg(); });

it('limits a temporary-password session until a different password is chosen', async () => {
  const ownerPassword = 'correct owner password';
  const temporary = 'temporary password 123';
  await makePerson(single.deps.db, TEST_ORG_ID, { username: 'owner', password: ownerPassword, isOwner: true, role: 'owner' });
  const owner = await loginAs(single.app, 'owner', ownerPassword);
  const added = await request(single.app).post('/api/people').set('Cookie', owner.cookie).set('x-csrf-token', owner.csrf)
    .send({ displayName: 'Colleague', username: 'staff', role: 'viewer', temporaryPassword: temporary, password: ownerPassword });
  expect(added.status).toBe(201);
  const staff = await loginAs(single.app, 'staff', temporary);
  const h = (r: request.Test) => r.set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf);
  expect((await h(request(single.app).get('/api/auth/me'))).body.person.must_change_password).toBe(true);
  for (const url of ['/api/requests', '/api/balances/latest', '/API/REQUESTS/']) {
    const r = await h(request(single.app).get(url));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('password_change_required');
  }
  expect((await h(request(single.app).post('/api/send/phone')).send({})).body.error.code).toBe('password_change_required');
  expect((await h(request(single.app).post('/api/auth/change-password')).send({ currentPassword: temporary, newPassword: temporary })).status).toBe(400);
  expect((await h(request(single.app).post('/API/AUTH/change-password/')).send({ currentPassword: temporary, newPassword: 'my new private password' })).status).toBe(204);
  expect((await h(request(single.app).get('/api/auth/me'))).body.person.must_change_password).toBe(false);
  expect((await h(request(single.app).get('/api/requests'))).status).toBe(200);
});
