import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, resetTables } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(close);
const SAF_IP = '196.201.214.200';
const body = (transId = 'RKT1234567') => ({
  TransactionType: 'Pay Bill', TransID: transId, TransTime: '20260916101530', TransAmount: '250.00', BusinessShortCode: '600999', BillRefNumber: 'ACC-9',
  InvoiceNumber: '', OrgAccountBalance: '1000.00', ThirdPartyTransID: '', MSISDN: '254700123456', FirstName: 'Jane', MiddleName: '', LastName: 'Doe',
});

describe('C2B callbacks', () => {
  beforeEach(async () => { await resetTables(deps.db); await deps.settings.set('daraja.environment', 'sandbox'); });

  it('validation answers 200 with ResultCode 0 and stores the raw body only', async () => {
    const r = await request(app).post('/cb/sekret/c2b/validate').set('X-Forwarded-For', SAF_IP).send(body());
    expect(r.status).toBe(200);
    expect(r.body.ResultCode).toBe(0);
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(0);
    expect((await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'))[0].verdict).toBe('applied_direct');
  });

  it('confirmation inserts one row; a repeat is a duplicate; both answer 200', async () => {
    const a = await request(app).post('/cb/sekret/c2b/confirm').set('X-Forwarded-For', SAF_IP).send(body());
    expect(a.status).toBe(200);
    const b = await request(app).post('/cb/sekret/c2b/confirm').set('X-Forwarded-For', SAF_IP).send(body());
    expect(b.status).toBe(200);
    expect((await deps.db.query('SELECT 1 FROM requests WHERE type=$1', ['c2b'])).length).toBe(1);
    const verdicts = (await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw ORDER BY received_at')).map((r) => r.verdict);
    expect(verdicts).toEqual(['applied', 'duplicate']);
  });

  it('a body that is not a payment answers 200, keeps the raw and inserts nothing', async () => {
    const r = await request(app).post('/cb/sekret/c2b/confirm').set('X-Forwarded-For', SAF_IP).send({ hello: 'world' });
    expect(r.status).toBe(200);
    expect((await deps.db.query('SELECT 1 FROM requests')).length).toBe(0);
    expect((await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'))[0].verdict).toBe('unmatched');
  });
});
