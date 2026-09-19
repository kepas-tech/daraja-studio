import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, makePerson, loginAs, TEST_ORG_ID } from './helpers.js';

/**
 * Round 5: register, or be fed.
 *
 * Another system owns this paybill's C2B addresses, so it posts each confirmation through
 * untouched. Safaricom's own field names, the same parser the callback uses, the payer's name where
 * a confirmation's would be, and the receipt as the identity so nothing is ever counted twice.
 */
const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });

let n = 0;
/** Safaricom's own C2B confirmation body, exactly as the forwarder would post it. */
function body(over: Record<string, unknown> = {}) {
  n += 1;
  return {
    TransactionType: 'Pay Bill', TransID: 'RC' + String(n).padStart(8, '0'),
    TransTime: '20260919121530', TransAmount: '250.00', BusinessShortCode: '600999',
    BillRefNumber: '000-KEPAS-1', InvoiceNumber: '', OrgAccountBalance: '12345.00',
    ThirdPartyTransID: '', MSISDN: '254712345678',
    FirstName: 'SAMWEL', MiddleName: 'NGUGI', LastName: 'IRUNGU', ...over,
  };
}

describe('the money-in feed', () => {
  let cookie: string; let csrf: string; let secret: string;
  beforeEach(async () => {
    ({ cookie, csrf } = await loginAsOwner(app, deps));
    const made = await request(app).post('/api/keys').set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'KEPAS Pay forwarder', role: 'forwarder' });
    expect(made.status).toBe(201);
    secret = made.body.secret;
  });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);
  const feed = (b: unknown) => request(app).post('/api/money-in/feed').set('Authorization', `Bearer ${secret}`).send(b as object);

  it('takes Safaricom’s own confirmation body and records it the way the callback would', async () => {
    const r = await feed(body());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ verdict: 'applied', receipt: 'RC00000001' });

    const [row] = await deps.db.query<{ type: string; status: string; amount_cents: string; recipient_value: string; recipient_name: string; account_reference: string; receipt: string; result_source: string; payload_json: Record<string, unknown> }>(
      'SELECT type, status, amount_cents, recipient_value, recipient_name, account_reference, receipt, result_source, payload_json FROM requests WHERE receipt=$1', ['RC00000001']);
    expect(row).toMatchObject({
      type: 'c2b', status: 'completed', amount_cents: '25000', recipient_value: '254712345678',
      recipient_name: 'SAMWEL NGUGI IRUNGU', account_reference: '000-KEPAS-1', result_source: 'feed',
    });
    // The raw name parts are kept exactly as Safaricom sent them, the way a confirmation keeps them.
    expect(row!.payload_json).toMatchObject({ firstName: 'SAMWEL', middleName: 'NGUGI', lastName: 'IRUNGU', shortCode: '600999' });

    // Every screen reads the name from the same place a confirmation's would be read from.
    const view = await h(request(app).get('/api/requests/' + r.body.requestId));
    expect(view.status).toBe(200);
    expect(view.body.party.name).toBe('SAMWEL NGUGI IRUNGU');
    expect(view.body.direction).toBe('in');
    expect(view.body.receipt).toBe('RC00000001');
    // The audit row names the key, never its secret.
    const audit = await deps.db.query<{ action: string; after_json: Record<string, unknown> }>(`SELECT action, after_json FROM audit_log WHERE action='money_in.fed'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after_json).toMatchObject({ receipt: 'RC00000001', verdict: 'applied' });
    // Everything after the prefix is the secret: the random part may itself hold an underscore,
    // and a one-character fragment would match by luck.
    expect(JSON.stringify(audit[0]!.after_json)).not.toContain(secret.split('_').slice(2).join('_'));
  });

  it('counts a payment once, whichever way it arrives', async () => {
    const b = body();
    const first = await feed(b);
    expect(first.status).toBe(201);
    // The same body again: a duplicate, the same row, nothing changed.
    const again = await feed(b);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ verdict: 'duplicate', requestId: first.body.requestId });
    expect(await deps.db.query('SELECT 1 FROM requests WHERE receipt=$1', [b.TransID])).toHaveLength(1);

    // And the other way round: a payment Studio already recorded from the pull is a duplicate to the
    // feed, which is what makes leaving the feed on through a changeover safe.
    const pulled = body();
    const { recordC2b } = await import('../src/money_in/record.js');
    const done = await recordC2b({ db: deps.db, events: deps.events }, { transactionType: 'Pay Bill', transId: pulled.TransID, transTime: '20260919121530', amount: 250, shortCode: '600999', billRefNumber: '000-KEPAS-1', invoiceNumber: '', thirdPartyTransId: '', msisdn: '254712345678', firstName: '', middleName: '', lastName: '' }, 'poll');
    expect(done.verdict).toBe('applied');
    const fed = await feed(pulled);
    expect(fed.body).toMatchObject({ verdict: 'duplicate', requestId: done.requestId });
    expect(await deps.db.query('SELECT 1 FROM requests WHERE receipt=$1', [pulled.TransID])).toHaveLength(1);
  });

  it('is a key that may feed money in and nothing else', async () => {
    // The forwarder key may post a confirmation…
    expect((await feed(body())).status).toBe(201);
    // …and may not read a payment, list history, send, or manage keys.
    const key = { Authorization: `Bearer ${secret}` };
    expect((await request(app).get('/api/requests?limit=1').set(key)).status).toBe(403);
    expect((await request(app).get('/api/keys').set(key)).status).toBe(403);
    expect((await request(app).post('/api/send/phone').set(key).send({ phone: '0700123456', amountCents: 100 })).status).toBe(403);
    // A viewer key, the other way round, may not feed.
    const viewer = await request(app).post('/api/keys').set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'Reporting', role: 'viewer' });
    const refused = await request(app).post('/api/money-in/feed').set('Authorization', `Bearer ${viewer.body.secret}`).send(body());
    expect(refused.status).toBe(403);
    // And no key at all is a plain 401.
    expect((await request(app).post('/api/money-in/feed').send(body())).status).toBe(401);
  });

  it('refuses a body that is not a confirmation, and writes nothing', async () => {
    const r = await feed({ hello: 'world' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_body');
    expect(await deps.db.query('SELECT 1 FROM requests')).toHaveLength(0);
  });

  it('proves the path with a test before the first real payment, and leaves nothing behind', async () => {
    const before = (await deps.db.query('SELECT 1 FROM requests')).length;
    const r = await h(request(app).post('/api/money-in/feed/test')).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, first: 'applied', idempotent: true, named: true, removed: true });
    expect(r.body.receipt).toMatch(/^TEST[0-9A-F]{6}$/);
    expect(r.body.said).toContain('The path works');
    // The test payment is gone, and nothing was announced: no notification, no webhook delivery.
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(before);
    expect(await deps.db.query('SELECT 1 FROM notifications')).toHaveLength(0);
    expect(await deps.db.query('SELECT 1 FROM webhook_deliveries')).toHaveLength(0);
  });

  it('records the owner’s answer to where payments arrive, and shows it on Money in', async () => {
    const state = await h(request(app).get('/api/money-in/status'));
    expect(state.body).toMatchObject({ arrival: null, lastFedAt: null, feedKeys: 1 });

    const set = await h(request(app).post('/api/money-in/arrival')).send({ arrival: 'forwarder' });
    expect(set.status).toBe(200);
    expect(set.body.arrival).toBe('forwarder');
    const bad = await h(request(app).post('/api/money-in/arrival')).send({ arrival: 'somewhere' });
    expect(bad.status).toBe(400);

    await feed(body());
    const after = await h(request(app).get('/api/money-in/status'));
    expect(after.body.arrival).toBe('forwarder');
    expect(after.body.lastFedAt).toBeTruthy();

    // Only the owner answers it.
    await makePerson(deps.db, TEST_ORG_ID, { username: 'staff', password: 'correct horse', role: 'custom' });
    const staff = await loginAs(app, 'staff', 'correct horse');
    const refused = await request(app).post('/api/money-in/arrival').set('Cookie', staff.cookie).set('x-csrf-token', staff.csrf).send({ arrival: 'studio' });
    expect(refused.status).toBe(403);
  });
});
