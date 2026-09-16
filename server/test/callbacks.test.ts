import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { makeApp, resetTables } from './helpers.js';
import { inAllowlist, parseAllowlist } from '../src/callbacks/allowlist.js';
import { callbackErrorHandler, callbackRoutes } from '../src/callbacks/router.js';
import type { Db } from '../src/db/pool.js';
import type { EventHub } from '../src/events/hub.js';
import { encrypt } from '../src/crypto/secrets.js';

const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });

const SAF_IP = '196.201.214.200';
function balanceBody(originator: string, code = 0) {
  return { Result: { ResultType: 0, ResultCode: code, ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'The initiator information is invalid.',
    OriginatorConversationID: originator, ConversationID: 'AG_1', TransactionID: 'X',
    ResultParameters: { ResultParameter: [{ Key: 'AccountBalance', Value: 'Working Account|KES|14.00|14.00|0.00|0.00&Utility Account|KES|34392.00|34392.00|0.00|0.00&Charges Paid Account|KES|0.00|0.00|0.00|0.00' }] } } };
}
function balanceBodyUtilityOnly(originator: string) {
  return { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
    OriginatorConversationID: originator, ConversationID: 'AG_1', TransactionID: 'X',
    ResultParameters: { ResultParameter: [{ Key: 'AccountBalance', Value: 'Utility Account|KES|34392.00|34392.00|0.00|0.00' }] } } };
}

describe('callbacks', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
  });

  /** The real pool with only the raw-intake write failing: an outage at exactly the wrong moment. */
  const failingRawInsert = (): Db => ({
    ...deps.db,
    query: ((sql: string, params?: unknown[]) => (/INSERT INTO callbacks_raw/i.test(String(sql))
      ? Promise.reject(new Error('storage down'))
      : deps.db.query(sql, params))) as unknown as Db['query'],
  });

  it('allowlist helpers', () => {
    expect(parseAllowlist(null).length).toBeGreaterThan(5);
    expect(inAllowlist('196.201.214.200', parseAllowlist(null))).toBe(true);
    expect(inAllowlist('1.2.3.4', parseAllowlist('9.9.9.9, 1.2.3.4'))).toBe(true);
  });

  it('wrong secret → 404 and nothing stored', async () => {
    const r = await request(app).post('/cb/nope/balance').send({});
    expect(r.status).toBe(404);
    expect((await deps.db.query('SELECT 1 FROM callbacks_raw')).length).toBe(0);
  });

  it('off-range ip is stored but not applied in production', async () => {
    await deps.settings.set('daraja.environment', 'production');
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OC1','sent')`);
    const r = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', '1.2.3.4').send(balanceBody('OC1'));
    expect(r.status).toBe(200);
    const raw = await deps.db.query<{ verdict: string; in_allowlist: boolean }>('SELECT verdict, in_allowlist FROM callbacks_raw');
    expect(raw[0].verdict).toBe('off_range');
    expect(raw[0].in_allowlist).toBe(false);
    const req = await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC1'`);
    expect(req[0].status).toBe('sent');
  });

  it('off-range ip is dispatched and applied in sandbox, flagged, with an alert', async () => {
    await deps.settings.set('daraja.environment', 'sandbox');
    const seen: string[] = [];
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') seen.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OC1S','sent')`);
      const r = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', '1.2.3.4').send(balanceBody('OC1S'));
      expect(r.status).toBe(200);
      const raw = (await deps.db.query<{ verdict: string; in_allowlist: boolean }>('SELECT verdict, in_allowlist FROM callbacks_raw'))[0];
      expect(raw.verdict).toBe('applied');
      expect(raw.in_allowlist).toBe(false);
      const req = (await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC1S'`))[0];
      expect(req.status).toBe('completed');
      await new Promise((r) => setTimeout(r, 200));
      expect(seen).toContain('callback_off_range_applied');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('matched balance callback completes request, stores balances, verifies operator', async () => {
    const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('APIONE', $1, 'pending') RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, operator_id) VALUES ('balance','operator_probe','OC2','sent',$1)`, [op.id]);
    const r = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC2'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    const req = (await deps.db.query<{ id: string; status: string; result_source: string }>(`SELECT id, status, result_source FROM requests WHERE originator_conversation_id='OC2'`))[0];
    expect(req.status).toBe('completed');
    expect(req.result_source).toBe('callback');
    const bal = (await deps.db.query<{ utility_cents: string }>('SELECT utility_cents FROM balances'))[0];
    expect(Number(bal.utility_cents)).toBe(3439200);
    const o = (await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [op.id]))[0];
    expect(o.status).toBe('verified');
    const raw = (await deps.db.query<{ matched_request_id: string }>(`SELECT matched_request_id FROM callbacks_raw`))[0];
    expect(raw.matched_request_id).toBe(req.id);
  });

  it('an ordinary refresh and a successful operator probe mint no recovery ticket', async () => {
    const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS2', $1, 'pending') RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status) VALUES ('balance','refresh','OC-REFRESH','sent')`);
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, operator_id) VALUES ('balance','operator_probe','OC-PROBE','sent',$1)`, [op.id]);
    await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC-REFRESH'));
    await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC-PROBE'));
    const keys = await deps.db.query<{ key: string }>(`SELECT key FROM cache WHERE key LIKE '%recovery:%'`);
    expect(keys).toEqual([]);
  });

  it('a failed probe drops an operator that was never verified, keeping the request', async () => {
    const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status) VALUES ('APITWO', $1, 'pending') RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, operator_id) VALUES ('balance','operator_probe','OC3','sent',$1)`, [op.id]);
    await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC3', 2001));
    expect((await deps.db.query('SELECT 1 FROM operators WHERE id=$1', [op.id])).length).toBe(0);
    const [req] = await deps.db.query<{ status: string; operator_id: string | null; result_desc: string }>(`SELECT status, operator_id, result_desc FROM requests WHERE originator_conversation_id='OC3'`);
    expect(req).toEqual({ status: 'failed', operator_id: null, result_desc: 'The initiator information is invalid.' });
  });

  it('a failed probe keeps an operator that once worked, marked failed with the Safaricom text', async () => {
    const [op] = await deps.db.query<{ id: string }>(`INSERT INTO operators(name, credential_enc, status, verified_at) VALUES ('APITWO', $1, 'pending', now()) RETURNING id`, [encrypt(deps.config.secretKey, 'c')]);
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, operator_id) VALUES ('balance','operator_probe','OC3','sent',$1)`, [op.id]);
    await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC3', 2001));
    const o = (await deps.db.query<{ status: string; last_error: string }>('SELECT status, last_error FROM operators WHERE id=$1', [op.id]))[0];
    expect(o.status).toBe('failed');
    expect(o.last_error).toMatch(/initiator information is invalid/);
  });

  it('duplicate callback is stored as duplicate', async () => {
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OC4','sent')`);
    await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC4'));
    await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC4'));
    const verdicts = (await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw ORDER BY received_at')).map((r) => r.verdict);
    expect(verdicts).toEqual(['applied', 'duplicate']);
  });

  it('selftest stores the nonce in cache from any ip', async () => {
    const r = await request(app).post('/cb/sekret/selftest').set('X-Forwarded-For', '8.8.8.8').send({ nonce: 'n-1' });
    expect(r.status).toBe(200);
    expect(await deps.cache.get('selftest:n-1')).toEqual({ ok: true });
  });

  // A body-parse failure (malformed JSON, or an oversized payload) must never 500 —
  // it is stored as best-effort and always acked 200, same as every other callback outcome.
  it('a malformed JSON body is stored as unparsed and still acked, without touching the request', async () => {
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OC7','sent')`);
    const r = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP)
      .set('Content-Type', 'application/json').send('MSISDN=254712345678');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    const raw = (await deps.db.query<{ verdict: string; body_json: { error: string; unparsed: string | null } }>(
      'SELECT verdict, body_json FROM callbacks_raw'))[0];
    expect(raw.verdict).toBe('unmatched');
    expect(raw.body_json.error).toBe('body_parse_failed');
    expect(raw.body_json.unparsed).toBe('MSISDN=254712345678');
    const req = (await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC7'`))[0];
    expect(req.status).toBe('sent');
  });

  it('a malformed JSON body with the wrong secret → 404 and nothing stored', async () => {
    const r = await request(app).post('/cb/nope/balance').set('Content-Type', 'application/json').send('MSISDN=254712345678');
    expect(r.status).toBe(404);
    expect((await deps.db.query('SELECT 1 FROM callbacks_raw')).length).toBe(0);
  });

  // Two identical callbacks racing for the same originator_conversation_id must apply
  // exactly once — the loser sees zero rows affected by its conditional UPDATE and reports
  // 'duplicate', never inserting a second balances row.
  it('two identical callbacks racing concurrently apply exactly once', async () => {
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OC6','sent')`);
    const [r1, r2] = await Promise.all([
      request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC6')),
      request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC6')),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const verdicts = (await deps.db.query<{ verdict: string }>(`SELECT verdict FROM callbacks_raw WHERE path='balance' ORDER BY verdict`)).map((row) => row.verdict);
    expect(verdicts).toEqual(['applied', 'duplicate']);
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(1);
    const req = (await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC6'`))[0];
    expect(req.status).toBe('completed');
  });

  // A handler that throws must never lose the ack, and must raise an alert so a human
  // can see the callback was dropped instead of silently vanishing into a log line.
  it('a thrown handler is caught, verdict stays unmatched, and an alert is published', async () => {
    const published: { type: string; payload: unknown }[] = [];
    const fakeEvents: EventHub = {
      async start() {},
      async stop() {},
      async publish(type, payload) { published.push({ type, payload }); },
      subscribe() { return () => {}; },
    };
    const boomApp = express();
    boomApp.set('trust proxy', deps.config.trustProxy);
    boomApp.use(express.json());
    boomApp.use('/cb', callbackRoutes({
      db: deps.db, settings: deps.settings, cache: deps.cache, events: fakeEvents, orgs: deps.orgs,
      handlers: { boom: async () => { throw new Error('x'); } },
    }));
    const r = await request(boomApp).post('/cb/sekret/boom').set('X-Forwarded-For', SAF_IP).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    const raw = (await deps.db.query<{ verdict: string }>(`SELECT verdict FROM callbacks_raw WHERE path='boom'`))[0];
    expect(raw.verdict).toBe('unmatched');
    expect(published.some((e) => e.type === 'alert' && (e.payload as { kind?: string }).kind === 'callback_handler_failed')).toBe(true);
  });

  // A7: `deps.handlers[sub]` on a plain object resolves 'constructor' to Object on the prototype
  // chain — treated as a real handler it gets invoked and blows up. It must be looked up with
  // Object.hasOwn and treated exactly like any other unrecognised path: stored, no alert, no throw.
  it('a callback for the "constructor" sub-path is treated as no matching handler', async () => {
    const published: { type: string; payload: unknown }[] = [];
    const fakeEvents: EventHub = {
      async start() {},
      async stop() {},
      async publish(type, payload) { published.push({ type, payload }); },
      subscribe() { return () => {}; },
    };
    const ctorApp = express();
    ctorApp.set('trust proxy', deps.config.trustProxy);
    ctorApp.use(express.json());
    ctorApp.use('/cb', callbackRoutes({
      db: deps.db, settings: deps.settings, cache: deps.cache, events: fakeEvents, orgs: deps.orgs,
      handlers: { selftest: async () => ({ verdict: 'applied' as const }) },
    }));
    const r = await request(ctorApp).post('/cb/sekret/constructor').set('X-Forwarded-For', SAF_IP).send({ some: 'body' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    const raw = (await deps.db.query<{ verdict: string }>(`SELECT verdict FROM callbacks_raw WHERE path='constructor'`))[0];
    expect(raw.verdict).toBe('unmatched');
    expect(published.length).toBe(0);
  });

  // An account absent from the AccountBalance string means "we don't know", not zero.
  it('a balance body missing an account stores null for that account, not zero', async () => {
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OC5','sent')`);
    await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBodyUtilityOnly('OC5'));
    const bal = (await deps.db.query<{ working_cents: string | null; utility_cents: string; charges_paid_cents: string | null }>(
      'SELECT working_cents, utility_cents, charges_paid_cents FROM balances'))[0];
    expect(bal.working_cents).toBeNull();
    expect(bal.charges_paid_cents).toBeNull();
    expect(Number(bal.utility_cents)).toBe(3439200);
  });

  it('a late callback for a cancelled probe is stored as duplicate and does not raise', async () => {
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status) VALUES ('balance','operator_probe','OC-CANCELLED','cancelled')`);
    const r = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC-CANCELLED'));
    expect(r.status).toBe(200);
    const [raw] = await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw');
    expect(raw.verdict).toBe('duplicate');
    const [req] = await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC-CANCELLED'`);
    expect(req.status).toBe('cancelled');
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(0);
  });

  // Lead ruling 2026-09-13: a 200 means the raw body is already durable. If the intake write fails,
  // the provider must see a retryable status; if the parse failure cannot be stored, the same.
  it('answers 503 and stores nothing when the raw insert fails, then a redelivery settles once', async () => {
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OC-INSERT-FAIL','sent')`);
    const failApp = express();
    failApp.set('trust proxy', deps.config.trustProxy);
    failApp.use(express.json());
    failApp.use('/cb', callbackRoutes({ db: failingRawInsert(), settings: deps.settings, cache: deps.cache, events: deps.events, orgs: deps.orgs, handlers: {} }));

    const r = await request(failApp).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC-INSERT-FAIL'));
    expect(r.status).toBe(503);
    expect((await deps.db.query('SELECT 1 FROM callbacks_raw')).length).toBe(0);
    expect((await deps.db.query(`SELECT status FROM requests WHERE originator_conversation_id='OC-INSERT-FAIL'`))[0].status).toBe('sent');

    // The provider redelivers the same body; the real stack stores it once and settles once.
    const retry = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC-INSERT-FAIL'));
    expect(retry.status).toBe(200);
    expect((await deps.db.query(`SELECT status FROM requests WHERE originator_conversation_id='OC-INSERT-FAIL'`))[0].status).toBe('completed');
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(1);
    expect((await deps.db.query("SELECT verdict FROM callbacks_raw WHERE path='balance'")).length).toBe(1);
  });

  it('acks 200 once the raw row exists, and a later pass settles a failed apply exactly once', async () => {
    await deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status) VALUES ('balance','OC-APPLY-FAIL','sent')`);
    const published: { type: string; payload: unknown }[] = [];
    const fakeEvents: EventHub = {
      async start() {}, async stop() {},
      async publish(type, payload) { published.push({ type, payload }); },
      subscribe() { return () => {}; },
    };
    const boomApp = express();
    boomApp.set('trust proxy', deps.config.trustProxy);
    boomApp.use(express.json());
    boomApp.use('/cb', callbackRoutes({ db: deps.db, settings: deps.settings, cache: deps.cache, events: fakeEvents, orgs: deps.orgs, handlers: { balance: async () => { throw new Error('apply failed'); } } }));

    const r = await request(boomApp).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC-APPLY-FAIL'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect((await deps.db.query("SELECT count(*)::int AS n FROM callbacks_raw WHERE path='balance'"))[0].n).toBe(1);
    expect((await deps.db.query(`SELECT status FROM requests WHERE originator_conversation_id='OC-APPLY-FAIL'`))[0].status).toBe('sent');
    expect(published.some((e) => e.type === 'alert' && (e.payload as { kind?: string }).kind === 'callback_handler_failed')).toBe(true);

    // The stored body is still a real result: the next pass applies it, exactly once.
    const again = await request(app).post('/cb/sekret/balance').set('X-Forwarded-For', SAF_IP).send(balanceBody('OC-APPLY-FAIL'));
    expect(again.status).toBe(200);
    expect((await deps.db.query(`SELECT status FROM requests WHERE originator_conversation_id='OC-APPLY-FAIL'`))[0].status).toBe('completed');
    expect((await deps.db.query('SELECT 1 FROM balances')).length).toBe(1);
  });

  it('answers 503 when a malformed body cannot be stored', async () => {
    const failApp = express();
    failApp.set('trust proxy', deps.config.trustProxy);
    // The same mount shape as app.ts: the parser, the routes and the parse-error handler under /cb.
    failApp.use('/cb',
      express.json({ limit: '256kb', verify: (req, _res, buf) => { (req as { rawBody?: string }).rawBody = buf.toString('utf8'); } }),
      callbackRoutes({ db: failingRawInsert(), settings: deps.settings, cache: deps.cache, events: deps.events, orgs: deps.orgs, handlers: {} }),
      callbackErrorHandler({ db: failingRawInsert(), settings: deps.settings, events: deps.events, orgs: deps.orgs }));
    const r = await request(failApp).post('/cb/sekret/balance').set('Content-Type', 'application/json').send('MSISDN=254712345678');
    expect(r.status).toBe(503);
    expect((await deps.db.query('SELECT 1 FROM callbacks_raw')).length).toBe(0);
  });
});
