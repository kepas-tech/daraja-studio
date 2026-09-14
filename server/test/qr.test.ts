import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, loginAs, makePerson, seedOrg, deleteOrg, TEST_ORG_ID } from './helpers.js';
import { createAdminPool, withOrg, withSystem } from '../src/db/pool.js';
import { createQrService } from '../src/qr/service.js';

// A small valid PNG; this transport never contacts a provider, including for OAuth.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
let responseBody: unknown;
let status = 200;
let brokenJson = false;
const sent: Record<string, unknown>[] = [];
const fake: typeof fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  if (path.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'fake-qr-token', expires_in: '3600' }));
  // Asserts the SDK called the QR endpoint and nothing else. Written as a suffix rather than the
  // full path because the commit gate refuses a Safaricom endpoint literal outside oauthCheck.ts,
  // and that rule is worth more than the extra few characters it costs here.
  if (!path.endsWith('/qrcode/v1/generate')) throw new Error('Unexpected fake transport endpoint');
  sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  return new Response(brokenJson ? '<html>unreadable</html>' : JSON.stringify(responseBody), { status });
};
const { app, deps, close } = makeApp({ fetchImpl: fake });
const admin = createAdminPool(deps.config.databaseUrl);
const otherOrg = '00000000-0000-4000-8000-000000009906';
let cookie: string;
let csrf: string;
const body = { accountReference: 'ORDER-QR', amountCents: 12550, trxCode: 'PB' };
const post = (value: object = body) => request(app).post('/api/qr').set('Cookie', cookie).set('x-csrf-token', csrf).send(value);
async function slot(shortcode: string) {
  await deps.settings.set('daraja.environment', 'sandbox');
  await deps.settings.set('env.sandbox.shortcode', shortcode);
  await deps.settings.set('env.sandbox.consumerKey', 'fake-qr-key');
  await deps.settings.set('env.sandbox.consumerSecret', 'fake-qr-secret');
  await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
}
beforeEach(async () => {
  ({ cookie, csrf } = await loginAsOwner(app, deps));
  deps.daraja.invalidate();
  await slot('600001');
  sent.length = 0; status = 200; brokenJson = false;
  responseBody = { ResponseCode: '00', ResponseDescription: 'Success', QRCode: png };
});
afterAll(async () => { await deleteOrg(otherOrg); await admin.end(); await close(); });

describe('QR API with real PostgreSQL and the SDK fake transport', () => {
  it('generates a downloadable QR through the mounted route without an operator, callback or payment row', async () => {
    const [before] = await deps.db.query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE action='qr.generated'");
    const details = await request(app).get('/api/qr').set('Cookie', cookie);
    expect(details.status).toBe(200);
    expect(sent).toHaveLength(0);
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ imageUrl: `data:image/png;base64,${png}`, shortcode: '600001', environment: 'sandbox', ...body });
    expect(sent).toEqual([{ MerchantName: details.body.merchantName, RefNo: 'ORDER-QR', Amount: 125.5, TrxCode: 'PB', CPI: '600001', Size: '400' }]);
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await deps.db.query('SELECT id FROM requests')).length).toBe(0);
    expect((await deps.db.query('SELECT id FROM jobs')).length).toBe(0);
    const [after] = await deps.db.query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE action='qr.generated'");
    expect(Number(after.n) - Number(before.n)).toBe(1);
  });
  it('supports a Buy Goods code with an amount chosen by the customer', async () => {
    expect((await post({ ...body, trxCode: 'BG', amountCents: 0 })).status).toBe(200);
    expect(sent[0]).toMatchObject({ TrxCode: 'BG', Amount: 0 });
  });
  it('requires login, CSRF and the qr.generate permission, then admits a permitted staff member', async () => {
    expect((await request(app).post('/api/qr').send(body)).status).toBe(401);
    expect((await request(app).post('/api/qr').set('Cookie', cookie).send(body)).status).toBe(403);
    const id = await makePerson(deps.db, TEST_ORG_ID, { username: 'qr-staff', password: 'qr-test-password' });
    const staff = await loginAs(app, 'qr-staff', 'qr-test-password');
    const send = () => request(app).post('/api/qr').set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf).send(body);
    expect((await send()).status).toBe(403);
    expect(sent).toHaveLength(0);
    await deps.db.query("INSERT INTO permissions(person_id, permission) VALUES ($1,'qr.generate')", [id]);
    expect((await send()).status).toBe(200);
  });
  it.each([{ ...body, shortcode: '600999' }, { ...body, merchantName: 'Other payee' }, { ...body, trxCode: 'SM' },
    { ...body, accountReference: '' }, { ...body, amountCents: -1 }, { ...body, amountCents: 1.5 }])('refuses invalid input before the SDK is called (%#)', async (value) => {
    expect((await post(value)).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
  it('returns a provider refusal as three separate lines without exposing its raw body', async () => {
    responseBody = { ResponseCode: '400.001.01', ResponseDescription: 'Invalid transaction type', secret: 'never-return-raw' };
    const r = await post();
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('safaricom_rejected');
    expect(r.body.error.details).toEqual({ safaricomSaid: 'Invalid transaction type', meaning: expect.any(String), whatToDo: expect.any(String) });
    expect(JSON.stringify(r.body)).not.toContain('never-return-raw');
  });
  it.each([{}, { ResponseCode: '00' }, { ResponseCode: '00', QRCode: '' }, { ResponseCode: '00', QRCode: 'not-an-image' },
    { ResponseCode: '00', QRCode: Buffer.from('<svg onload="alert(1)"/>').toString('base64') }])('rejects malformed responses without an image or a success audit (%#)', async (value) => {
    const [before] = await deps.db.query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE action='qr.generated'");
    responseBody = value;
    const r = await post();
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('qr_bad_response');
    expect(r.body.error.details).toEqual({ safaricomSaid: expect.any(String), meaning: expect.any(String), whatToDo: expect.any(String) });
    expect(r.body.imageUrl).toBeUndefined();
    const [after] = await deps.db.query<{ n: string }>("SELECT count(*) AS n FROM audit_log WHERE action='qr.generated'");
    expect(after.n).toBe(before.n);
  });
  it('rejects a non-JSON provider response', async () => {
    brokenJson = true;
    expect((await post()).body.error.code).toBe('qr_bad_response');
  });
  it('does not generate with unverified app credentials', async () => {
    await deps.settings.set('env.sandbox.credsVerifiedAt', ''); deps.daraja.invalidate();
    expect((await post()).status).toBe(409);
    expect(sent).toHaveLength(0);
  });
  it('refuses generation for a suspended organisation', async () => {
    await withSystem(() => admin.query("UPDATE orgs SET status='suspended', suspend_reason='host' WHERE id=$1", [TEST_ORG_ID]));
    try {
      expect((await post()).status).toBe(409);
      expect(sent).toHaveLength(0);
    } finally {
      await withSystem(() => admin.query("UPDATE orgs SET status='verified', suspend_reason=NULL WHERE id=$1", [TEST_ORG_ID]));
    }
  });
  it('requires HTTPS in production before contacting Safaricom', async () => {
    deps.config.nodeEnv = 'production';
    try {
      expect((await post()).status).toBe(403);
      expect(sent).toHaveLength(0);
    } finally { deps.config.nodeEnv = 'test'; }
  });
  it('keeps the payee and shortcode inside the current organisation', async () => {
    await seedOrg(admin, { id: otherOrg, slug: 'qr-other', name: 'Second QR business', secret: 'fake-qr-callback' });
    const otherPerson = await makePerson(deps.db, otherOrg, { username: 'qr-other-owner', password: 'qr-test-password', isOwner: true });
    await withOrg(otherOrg, () => slot('600002'));
    const service = createQrService(deps);
    const [owner] = await deps.db.query<{ id: string }>('SELECT id FROM people WHERE is_owner');
    const [first, second] = await Promise.all([
      withOrg(TEST_ORG_ID, () => service.generate(body, { personId: owner.id, ip: '127.0.0.1' })),
      withOrg(otherOrg, () => service.generate(body, { personId: otherPerson, ip: '127.0.0.1' })),
    ]);
    expect(first.shortcode).toBe('600001');
    expect(second).toMatchObject({ shortcode: '600002', merchantName: 'Second QR business' });
    expect(sent.map((v) => v.CPI).sort()).toEqual(['600001', '600002']);
  });
});
