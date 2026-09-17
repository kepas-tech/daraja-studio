import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { encrypt } from '../src/crypto/secrets.js';

const SAF_IP = '196.201.214.200';
// eslint-disable-next-line prefer-const -- forward-referenced by fake's post closure below, assigned once makeApp returns
let app: express.Express;
const fake = createFakeSafaricom({ post: async (path, body) => { await request(app).post(path).set('X-Forwarded-For', SAF_IP).send(body as object); } });
const made = makeApp({ fetchImpl: fake.fetchImpl });
app = made.app;
const { deps, close } = made;
afterAll(close);

async function ready() {
  await deps.settings.set('env.sandbox.shortcode', '600999');
  await deps.settings.set('daraja.environment', 'sandbox');
  await deps.settings.set('env.sandbox.consumerKey', 'k');
  await deps.settings.set('env.sandbox.consumerSecret', 's');
  await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('testapi',$1,'verified')`, [encrypt(deps.config.secretKey, 'Y3JlZA==')]);
}
const SEND = { phone: '0700123456', amountCents: 100, commandId: 'BusinessPayment', password: 'correct horse' };
const view = async (cookie: string, id: string) => (await request(app).get(`/api/requests/${id}`).set('Cookie', cookie)).body;
const status = async (id: string) => (await deps.db.query<{ status: string; receipt: string | null; result_source: string | null }>('SELECT status, receipt, result_source FROM requests WHERE id=$1', [id]))[0];

describe('fake safaricom scenarios', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); await ready(); fake.reset(); });
  const send = (extra: Record<string, unknown> = {}) => request(app).post('/api/send/phone').set('Cookie', cookie).set('x-csrf-token', csrf).send({ ...SEND, ...extra });

  it('completes: sent → callback → completed with receipt, balances row, request.updated', async () => {
    fake.completes();
    const r = await send();
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('sent');
    expect(fake.calls.map((c) => c.path.split('/').slice(-3).join('/'))).toEqual(['b2c/v3/paymentrequest']);
    expect(fake.calls[0].body.OriginatorConversationID).toBeTruthy();
    expect(fake.calls[0].body.PartyB).toBe(254700123456);
    expect(fake.calls[0].body.Amount).toBe(1);
    await fake.settle();
    const v = await view(cookie, r.body.id);
    expect(v.status).toBe('completed');
    expect(v.receipt).toMatch(/^RI/);
    expect(v.resultSource).toBe('callback');
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(1);
  });

  it('loses the callback: the sweep asks by OriginatorConversationID and the status result completes it (source poll)', async () => {
    fake.losesCallback();
    const r = await send();
    await fake.settle();
    expect((await status(r.body.id)).status).toBe('sent');
    await deps.db.query(`UPDATE requests SET sent_at = now() - interval '3 minutes' WHERE id=$1`, [r.body.id]);
    expect((await deps.moneyOut.sweep()).polled).toBe(1);
    const q = fake.calls.find((c) => c.path.endsWith('/transactionstatus/v1/query'))!;
    expect(q.body.OriginatorConversationID).toBe(fake.calls[0].body.OriginatorConversationID);
    expect(q.body.TransactionID).toBe('');
    await fake.settle();
    const s = await status(r.body.id);
    expect(s.status).toBe('completed');
    expect(s.result_source).toBe('poll');
    expect(s.receipt).toMatch(/^RI/);
  });

  // The landed pollOne (server/src/money_out/service.ts) refuses to check
  // a request that is not 'sent'/'pending'/'unknown' (409 not_pending), so the manual check must
  // land before the b2c result does — the same real-world race this scenario models (a human
  // clicks Check while Safaricom's async result is still in flight). fake.settle() drains its
  // queue strictly in call order (never by timer), so this stays deterministic: the b2c callback
  // (queued first, by send()) completes the payment before the status result (queued second, by
  // the check) is processed and disagrees with it.
  it('disagrees: a status result overrides the callback outcome and raises an alert', async () => {
    fake.disagrees();
    const alerts: string[] = [];
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      const r = await send();
      const chk = await request(app).post(`/api/requests/${r.body.id}/check`).set('Cookie', cookie).set('x-csrf-token', csrf).send({});
      expect(chk.status).toBe(202);
      await fake.settle();
      expect((await status(r.body.id)).status).toBe('failed');
      await new Promise((r2) => setTimeout(r2, 200));
      expect(alerts).toContain('result_disagreement');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('duplicates the callback: applied once, second stored as duplicate', async () => {
    fake.duplicatesCallback();
    const r = await send();
    await fake.settle();
    expect((await deps.db.query<{ verdict: string }>(`SELECT verdict FROM callbacks_raw WHERE path='b2c' ORDER BY received_at`)).map((x) => x.verdict)).toEqual(['applied', 'duplicate']);
    expect((await status(r.body.id)).status).toBe('completed');
  });

  it('never answers: five polls then unknown with an alert; mark as checked works', async () => {
    fake.neverAnswers();
    const r = await send();
    for (let i = 0; i < 5; i++) {
      await deps.db.query(`UPDATE requests SET sent_at = now() - interval '3 minutes', last_poll_at = CASE WHEN last_poll_at IS NULL THEN NULL ELSE now() - interval '3 minutes' END WHERE id=$1`, [r.body.id]);
      expect((await deps.moneyOut.sweep()).polled).toBe(1);
    }
    await fake.settle();
    await deps.db.query(`UPDATE requests SET last_poll_at = now() - interval '3 minutes' WHERE id=$1`, [r.body.id]);
    expect((await deps.moneyOut.sweep()).expired).toBe(1);
    expect((await status(r.body.id)).status).toBe('unknown');
    const m = await request(app).post(`/api/requests/${r.body.id}/checked`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ note: 'Portal shows it paid', password: 'correct horse' });
    expect(m.status).toBe(200);
    expect(m.body.checked.note).toBe('Portal shows it paid');
  });

  it('rejects synchronously with a credential code: failed with three lines, operator down on the second try, next send blocked', async () => {
    fake.rejectsSync('2001', 'The initiator information is invalid.');
    const r = await send();
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('failed');
    expect(r.body.safaricomSaid).toBe('The initiator information is invalid.');
    expect(r.body.meaning).toBeTruthy();
    expect(r.body.whatToDo).toMatch(/operator/i);
    // Feature 8: one refusal only counts. The operator stays active until a second one lands
    // inside the window, so a stale password the next call survives does not stop every send.
    expect((await deps.db.query<{ status: string; consecutive_failures: number }>('SELECT status, consecutive_failures FROM operators'))[0])
      .toMatchObject({ status: 'verified', consecutive_failures: 1 });
    // rejectsSync is one-shot, so the fake is armed again for the second try.
    fake.rejectsSync('2001', 'The initiator information is invalid.');
    const second = await send({ confirmDuplicate: true });
    expect(second.body.status).toBe('failed');
    expect((await deps.db.query<{ status: string; consecutive_failures: number }>('SELECT status, consecutive_failures FROM operators'))[0])
      .toMatchObject({ status: 'failed', consecutive_failures: 2 });
    const again = await send({ confirmDuplicate: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('no_operator');
  });

  it('credential error in the result callback: failed, and the operator down on the second try', async () => {
    fake.credentialError();
    const r = await send();
    await fake.settle();
    expect((await status(r.body.id)).status).toBe('failed');
    expect((await deps.db.query<{ status: string; consecutive_failures: number }>('SELECT status, consecutive_failures FROM operators'))[0])
      .toMatchObject({ status: 'verified', consecutive_failures: 1 });
    const second = await send({ confirmDuplicate: true });
    await fake.settle();
    expect((await status(second.body.id)).status).toBe('failed');
    expect((await deps.db.query<{ status: string; consecutive_failures: number }>('SELECT status, consecutive_failures FROM operators'))[0])
      .toMatchObject({ status: 'failed', consecutive_failures: 2 });
  });

  // 'auto' (the default) tries v3 first; a synchronous 403.002.1001 gateway refusal is
  // retried once on v1 within the same send() call, and the choice is remembered.
  it('auto + refusesV3: completes on v1 within one send() call, detects v1, alerts, and the next send skips v3', async () => {
    fake.refusesV3();
    fake.completes();
    const alerts: string[] = [];
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      const r = await send();
      expect(r.status).toBe(201);
      expect(r.body.status).toBe('sent');
      expect(fake.calls.map((c) => c.path.split('/').slice(-3).join('/'))).toEqual(['b2c/v3/paymentrequest', 'b2c/v1/paymentrequest']);
      expect(fake.calls[0].body.OriginatorConversationID).toBeTruthy();
      expect(fake.calls[1].body.OriginatorConversationID).toBeUndefined();
      await fake.settle();
      const v = await view(cookie, r.body.id);
      expect(v.status).toBe('completed');

      const settingsView = await request(app).get('/api/settings').set('Cookie', cookie);
      expect(settingsView.body.environments.sandbox.b2cApi.detected).toBe('v1');
      expect(settingsView.body.environments.sandbox.b2cApi.detectedAt).toBeTruthy();
      await new Promise((r2) => setTimeout(r2, 200));
      expect(alerts).toContain('b2c_api_detected');

      // Next send: goes straight to v1, no v3 attempt (even though the fake would still refuse it).
      fake.reset();
      fake.refusesV3();
      fake.completes();
      const r2 = await send({ confirmDuplicate: true });
      expect(r2.body.status).toBe('sent');
      expect(fake.calls.map((c) => c.path.split('/').slice(-3).join('/'))).toEqual(['b2c/v1/paymentrequest']);
    } finally { unsub(); await deps.events.stop(); }
  });

  it('explicit v1: never calls v3 even when the fake would refuse it', async () => {
    fake.refusesV3();
    await request(app).put('/api/settings/environments/sandbox/b2c-api').set('Cookie', cookie).set('x-csrf-token', csrf).send({ version: 'v1', password: 'correct horse' });
    const r = await send();
    expect(r.body.status).toBe('sent');
    expect(fake.calls.map((c) => c.path.split('/').slice(-3).join('/'))).toEqual(['b2c/v1/paymentrequest']);
  });

  it('explicit v3 + refusesV3: fails synchronously pointing at the setting, and never attempts v1', async () => {
    fake.refusesV3();
    await request(app).put('/api/settings/environments/sandbox/b2c-api').set('Cookie', cookie).set('x-csrf-token', csrf).send({ version: 'v3', password: 'correct horse' });
    const r = await send();
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('failed');
    expect(r.body.whatToDo).toContain('set the B2C API version to v1');
    expect(fake.calls.map((c) => c.path.split('/').slice(-3).join('/'))).toEqual(['b2c/v3/paymentrequest']);
  });

  it('loses the callback under auto + refusesV3: the sweep asks by the ack OriginatorConversationID and completes it (source poll)', async () => {
    fake.refusesV3();
    fake.losesCallback();
    const r = await send();
    await fake.settle();
    expect((await status(r.body.id)).status).toBe('sent');
    const [row] = await deps.db.query<{ payload_json: { ackOriginatorConversationId?: string } }>('SELECT payload_json FROM requests WHERE id=$1', [r.body.id]);
    expect(row.payload_json.ackOriginatorConversationId).toBeTruthy();
    await deps.db.query(`UPDATE requests SET sent_at = now() - interval '3 minutes' WHERE id=$1`, [r.body.id]);
    expect((await deps.moneyOut.sweep()).polled).toBe(1);
    const q = fake.calls.find((c) => c.path.endsWith('/transactionstatus/v1/query'))!;
    expect(q.body.OriginatorConversationID).toBe(row.payload_json.ackOriginatorConversationId);
    await fake.settle();
    const s = await status(r.body.id);
    expect(s.status).toBe('completed');
    expect(s.result_source).toBe('poll');
    expect(s.receipt).toMatch(/^RI/);
  });

  it('balance refresh and receipt lookup round-trip through the fake', async () => {
    fake.completes();
    const b = await request(app).post('/api/balances/refresh').set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect(b.status).toBe(202);
    await fake.settle();
    const latest = await request(app).get('/api/balances/latest').set('Cookie', cookie);
    expect(latest.body.utilityCents).toBe(3439200);
    const l = await request(app).post('/api/lookup').set('Cookie', cookie).set('x-csrf-token', csrf).send({ receipt: 'RI6BZTPXNM' });
    expect(l.status).toBe(202);
    await fake.settle();
    const v = await view(cookie, l.body.requestId);
    expect(v.status).toBe('completed');
    expect(v.receipt).toBe('RI6BZTPXNM');
    expect(v.meaning).toMatch(/Completed/);
  });
});
