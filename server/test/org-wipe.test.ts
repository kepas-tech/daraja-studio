import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, makePerson, loginAs } from './helpers.js';
import { withSystem } from '../src/db/pool.js';

const { app, deps, close } = makeApp();
afterAll(close);

describe('POST /api/org/wipe', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });
  const wipe = (body: Record<string, unknown>, c = cookie, x = csrf) => request(app).post('/api/org/wipe').set('Cookie', c).set('x-csrf-token', x).send(body);
  const orgName = async () => (await withSystem(() => deps.db.query<{ name: string; status: string }>('SELECT name, status FROM orgs LIMIT 1')))[0]!;

  it('refuses a wrong name, a wrong password, and anyone but the owner', async () => {
    await withSystem(() => deps.db.query(`UPDATE orgs SET name = 'ACME TRADERS', status = 'verified'`));
    let r = await wipe({ confirmName: 'APIONE', password: 'correct horse' });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe('confirm_name');
    r = await wipe({ confirmName: 'ACME TRADERS', password: 'nope' });
    expect(r.status).toBe(403);
    const orgId = (await withSystem(() => deps.db.query<{ id: string }>('SELECT id FROM orgs LIMIT 1')))[0]!.id;
    await makePerson(deps.db, orgId, { username: 'viewer', password: 'viewer-pass-123', role: 'viewer' });
    const v = await loginAs(app, 'viewer', 'viewer-pass-123');
    r = await wipe({ confirmName: 'ACME TRADERS', password: 'viewer-pass-123' }, v.cookie, v.csrf);
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('owner_only');
    expect((await orgName()).name).toBe('ACME TRADERS');
  });

  it('wipes everything but the audit trail and puts the install back to first-run setup', async () => {
    await withSystem(() => deps.db.query(`UPDATE orgs SET name = 'ACME TRADERS', status = 'verified'`));
    const orgId = (await withSystem(() => deps.db.query<{ id: string }>('SELECT id FROM orgs LIMIT 1')))[0]!.id;
    await deps.settings.set('setup.completedAt', new Date().toISOString());
    await deps.settings.set('env.production.shortcode', '700111');
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value) VALUES ('b2c','BusinessPayment','ocid-1','completed',100,'KES','phone','254700000000')`);
    const r = await wipe({ confirmName: 'ACME TRADERS', password: 'correct horse' });
    expect(r.status).toBe(204);
    const org = await orgName();
    expect(org.status).toBe('pending');
    expect((await withSystem(() => deps.db.query<{ id: string }>('SELECT id FROM orgs LIMIT 1')))[0]!.id).toBe(orgId);
    for (const t of ['people', 'requests', 'settings', 'operators', 'sessions']) {
      const [row] = await withSystem(() => deps.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t} WHERE org_id = $1`, [orgId]));
      expect(row!.n, t).toBe('0');
    }
    const audit = await withSystem(() => deps.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'org.wiped'`));
    expect(audit[0]!.n).toBe('1');
    const status = await request(app).get('/api/setup/status');
    expect(status.status).toBe(200);
    expect(status.body.needsOwner).toBe(true);
    // The wiper's own session went with the rest.
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});
