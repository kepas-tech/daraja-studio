import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { DarajaAPIError, DarajaAuthError } from '@kepas/daraja-js';
import { makeApp, loginAsOwner, resetTables } from './helpers.js';
import { encrypt } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';

// What the SDK's hakikisha.lookup answers next. Replaced per test.
let lookup: (input: { phone: string }) => Promise<{ displayName: string }> = async () => ({ displayName: 'JANE D****** O******' });
const factory: DarajaFactory = {
  get: async () => ({ hakikisha: { lookup: (i: { phone: string }) => lookup(i) } }) as never,
  getForOperator: async () => ({ hakikisha: { lookup: (i: { phone: string }) => lookup(i) } }) as never,
  invalidate: () => {},
  stkEnabled: async () => false,
} as unknown as DarajaFactory;

describe('POST /api/send/name-check', () => {
  const { app, deps, close } = makeApp({ daraja: factory });
  afterAll(close);
  let s: { cookie: string; csrf: string };
  const ready = async () => {
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
  };
  beforeEach(async () => {
    await resetTables(deps.db);
    s = await loginAsOwner(app, deps);
    lookup = async () => ({ displayName: 'JANE D****** O******' });
  });
  const ask = (phone: string) => request(app).post('/api/send/name-check').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({ phone });

  it('answers the registered name, sending the number in Safaricom form', async () => {
    await ready();
    let sent = '';
    lookup = async (i) => { sent = i.phone; return { displayName: 'JANE D****** O******' }; };
    const r = await ask('0700 123 456');
    expect(r.status).toBe(200);
    // Phase D-4: paidBefore rides on every answer; this number has never been paid here.
    expect(r.body).toEqual({ available: true, name: 'JANE D****** O******', paidBefore: false });
    expect(sent).toBe('254700123456');
  });

  it('a 401 from Safaricom means the check is not switched on for this shortcode, not a bad key', async () => {
    await ready();
    lookup = async () => { throw new DarajaAuthError('authentication failed (HTTP 401): Invalid Access Token'); };
    const r = await ask('0700123456');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ available: false, reason: 'not_enabled', said: null, paidBefore: false });
  });

  it("Safaricom's own 'does not exist' is not_found, whichever shape it arrives in", async () => {
    await ready();
    // HTTP 400: the SDK's message is generic and the reason sits in the body.
    lookup = async () => { throw new DarajaAPIError('Daraja request failed (HTTP 400)', { raw: { header: { status: '400' }, body: { message: 'The customer does not exist.' } } }); };
    let r = await ask('0700123456');
    expect(r.body).toEqual({ available: false, reason: 'not_found', said: 'The customer does not exist.', paidBefore: false });
    // HTTP 200 with header.status 400: the SDK already put body.message in the message.
    lookup = async () => { throw new DarajaAPIError('The customer does not exist.'); };
    r = await ask('0700123456');
    expect(r.body).toEqual({ available: false, reason: 'not_found', said: 'The customer does not exist.', paidBefore: false });
  });

  it('anything else Safaricom says is "unavailable", with its line; a dropped line has none', async () => {
    await ready();
    lookup = async () => { throw new DarajaAPIError('Service unavailable'); };
    expect((await ask('0700123456')).body).toEqual({ available: false, reason: 'unavailable', said: 'Service unavailable', paidBefore: false });
    lookup = async () => { throw new Error('socket hang up'); };
    expect((await ask('0700123456')).body).toEqual({ available: false, reason: 'unavailable', said: null, paidBefore: false });
  });

  it('refuses a number that is not a Kenyan mobile, and is gated like a send', async () => {
    await ready();
    expect((await ask('12345')).status).toBe(400);
    await resetTables(deps.db);
    s = await loginAsOwner(app, deps);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    const r = await ask('0700123456'); // no operator → same 409 the send gives
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error).toBeDefined();
  });

  // Round 3, phase D-4: the first payment to a number is the one worth pausing over.
  it('says whether this studio has paid the number before', async () => {
    await ready();
    await deps.db.query(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, recipient_value, amount_cents) VALUES
        ('b2c','BusinessPayment','oc-paid','completed','254700123456',10000),
        ('b2c','BusinessPayment','oc-failed','failed','254700123457',10000),
        ('b2c','BusinessPayment','oc-pending','pending','254700123458',10000),
        ('b2c','BusinessPayment','oc-cancelled','cancelled','254700123459',10000)`);
    expect((await ask('0700123456')).body.paidBefore).toBe(true);
    // A payout that failed paid nobody, a pending one never left Studio, and a cancelled one never
    // happened: all three are still a first payment.
    expect((await ask('0700123457')).body.paidBefore).toBe(false);
    expect((await ask('0700123458')).body.paidBefore).toBe(false);
    expect((await ask('0700123459')).body.paidBefore).toBe(false);
    // The answer survives Safaricom not being able to name the number.
    lookup = async () => { throw new DarajaAuthError('authentication failed (HTTP 401)'); };
    expect((await ask('0700123456')).body).toMatchObject({ available: false, reason: 'not_enabled', paidBefore: true });
  });
});
