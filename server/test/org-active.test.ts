import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { withSystem, resetContextForTests } from '../src/db/pool.js';
import { ORG_CLOSED, ORG_SUSPENDED } from '../src/http/orgActive.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { makeApp, makePerson, loginAs, resetTables, ensureTestOrg, TEST_ORG_ID } from './helpers.js';

// This file's whole point is a guard that stops a request before it can move money. If one of
// those guards ever regresses, the request must still fail safe rather than reach Safaricom —
// same fake used the same way in egress.test.ts's refusalDaraja.
const NEVER_SAFARICOM: DarajaFactory = {
  get: async () => { throw new Error('org-active.test.ts must never reach Safaricom'); },
  getForOperator: async () => { throw new Error('org-active.test.ts must never reach Safaricom'); },
  invalidate: () => {},
  stkEnabled: async () => false,
};

const single = makeApp({ daraja: NEVER_SAFARICOM });

afterAll(async () => {
  await single.close();
  resetContextForTests();
});

beforeEach(async () => {
  await resetTables();
  await ensureTestOrg();
  await makePerson(single.deps.db, TEST_ORG_ID, { username: 'owner', password: 'correct horse', displayName: 'Owner', isOwner: true, role: 'owner' });
});

describe('a suspended organisation', () => {
  it('can read everything and change nothing, and can still log out', async () => {
    const { cookie, csrf } = await loginAs(single.app, 'owner', 'correct horse');
    await withSystem(() => single.deps.db.query(`UPDATE orgs SET status='suspended' WHERE id=$1`, [TEST_ORG_ID]));
    const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);

    expect((await h(request(single.app).get('/api/requests'))).status).toBe(200);
    const lookup = await h(request(single.app).post('/api/lookup')).send({ receipt: 'RI6BZTPXNM' });
    expect(lookup.status).toBe(409);
    expect(lookup.body.error).toMatchObject({ code: 'org_suspended', message: ORG_SUSPENDED });
    // Express is not case-sensitive-routing (buildApp never enables it), so a caller reaching the
    // same route by an upper-cased path must be exempted the same way — matched against the
    // lower-cased `req.path` ALWAYS_OPEN's own regex compares against.
    expect((await h(request(single.app).post('/API/AUTH/logout'))).status).toBe(204);
  });
});

describe('a closed organisation', () => {
  it('is refused everything but its own account routes', async () => {
    const { cookie, csrf } = await loginAs(single.app, 'owner', 'correct horse');
    await withSystem(() => single.deps.db.query(`UPDATE orgs SET status='closed' WHERE id=$1`, [TEST_ORG_ID]));
    const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
    const read = await h(request(single.app).get('/api/requests'));
    expect(read.status).toBe(409);
    expect(read.body.error).toMatchObject({ code: 'org_closed', message: ORG_CLOSED });
    expect((await h(request(single.app).post('/api/auth/logout'))).status).toBe(204);
  });
});

describe('an organisation still setting up', () => {
  it('is not gated by pending, and never reports org_unverified — this install has no such gate', async () => {
    const { cookie, csrf } = await loginAs(single.app, 'owner', 'correct horse');
    await withSystem(() => single.deps.db.query(`UPDATE orgs SET status='pending' WHERE id=$1`, [TEST_ORG_ID]));
    try {
      expect((await request(single.app).get('/api/settings').set('Cookie', cookie).set('x-csrf-token', csrf)).status).toBe(200);
      const send = await request(single.app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf)
        .send({ phone: '254700000000', amountCents: 1000 });
      // Blocked for the reasons it has always been blocked by, never for an org-status gate.
      expect(send.body.error.code).not.toBe('org_unverified');
    } finally {
      await withSystem(() => single.deps.db.query(`UPDATE orgs SET status='verified' WHERE id=$1`, [TEST_ORG_ID]));
    }
  });

  it('never reports a host admin: there is no host console to point anyone at', async () => {
    // Migration 008 sets is_host_admin on this install's owner — this must still read false, or a
    // self-hoster would be pointed at a screen that does not exist.
    await withSystem(() => single.deps.db.query(`UPDATE people SET is_host_admin=true WHERE org_id=$1`, [TEST_ORG_ID]));
    const login = await request(single.app).post('/api/auth/login').send({ username: 'owner', password: 'correct horse' });
    expect(login.body.person.is_host_admin).toBe(false);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0];
    const r = await request(single.app).get('/api/auth/me').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.hostAdmin).toBe(false);
    expect(r.body.person.is_host_admin).toBe(false);
  });
});

describe('GET /api/setup/status', () => {
  it('needs no mode field: there is only one product now', async () => {
    const r = await request(single.app).get('/api/setup/status');
    expect(r.body).toEqual({
      needsOwner: false, completed: false, step: null, uses: null, passkeyProven: false,
      // Step two: the paybill question has not been asked, and the sign-up address is served.
      paybill: null, signupUrl: 'https://kepas.darajastudio.com',
    });
  });
});

describe('POST /api/setup/owner', () => {
  it('refuses once the owner exists', async () => {
    const r = await request(single.app).post('/api/setup/owner').send({ displayName: 'X', username: 'x', password: 'correct horse battery' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('owner_exists');
  });
});

describe('GET /api/auth/me', () => {
  it('names the organisation and its environment', async () => {
    const { cookie } = await loginAs(single.app, 'owner', 'correct horse');
    await single.deps.settings.set('daraja.environment', 'sandbox');
    const r = await request(single.app).get('/api/auth/me').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(r.body.org).toMatchObject({ id: TEST_ORG_ID, environment: 'sandbox', isHost: true });
    expect(r.body.hostAdmin).toBe(false);
    expect(r.body.person).toMatchObject({ username: 'owner', role: 'owner', is_host_admin: false });
  });

  it('reports why an organisation is read-only', async () => {
    const { cookie } = await loginAs(single.app, 'owner', 'correct horse');
    await withSystem(() => single.deps.db.query(`UPDATE orgs SET status='suspended', suspend_reason='host', suspended_at=now() WHERE id=$1`, [TEST_ORG_ID]));
    const r = await request(single.app).get('/api/auth/me').set('Cookie', cookie);
    expect(r.body.org).toMatchObject({ status: 'suspended', suspendReason: 'host' });
  });
});
