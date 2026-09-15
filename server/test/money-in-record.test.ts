import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { makeApp, resetTables } from './helpers.js';
import { recordC2b, transTimeToDate } from '../src/money_in/record.js';

const { deps, close } = makeApp();
afterAll(close);

const pay = (over: Partial<Parameters<typeof recordC2b>[1]> = {}) => ({
  transactionType: 'Pay Bill', transId: 'RKT1234567', transTime: '20260916101530', amount: 250, shortCode: '600999', billRefNumber: 'ACC-9',
  invoiceNumber: '', orgAccountBalance: 1000, thirdPartyTransId: '', msisdn: '254700123456', firstName: 'Jane', middleName: '', lastName: 'Doe', ...over,
});

describe('recordC2b', () => {
  beforeEach(() => resetTables(deps.db));

  it('inserts a completed c2b row once; the same receipt again is a duplicate', async () => {
    const a = await recordC2b(deps, pay(), 'callback');
    expect(a.verdict).toBe('applied');
    const b = await recordC2b(deps, pay(), 'callback');
    expect(b).toEqual({ verdict: 'duplicate', requestId: a.requestId });
    const [row] = await deps.db.query<{ type: string; status: string; amount_cents: string; receipt: string; account_reference: string; recipient_name: string; result_source: string }>(
      'SELECT type, status, amount_cents, receipt, account_reference, recipient_name, result_source FROM requests');
    expect(row).toEqual({ type: 'c2b', status: 'completed', amount_cents: '25000', receipt: 'RKT1234567', account_reference: 'ACC-9', recipient_name: 'Jane Doe', result_source: 'callback' });
  });

  it('a payment found by the pull check is marked as found by check', async () => {
    const r = await recordC2b(deps, pay({ transId: 'RKT7654321' }), 'poll');
    const [row] = await deps.db.query<{ result_source: string; payload_json: { foundByCheck?: boolean } }>('SELECT result_source, payload_json FROM requests WHERE id=$1', [r.requestId]);
    expect(row.result_source).toBe('poll');
    expect(row.payload_json.foundByCheck).toBe(true);
  });

  it('reads TransTime as East Africa Time', () => {
    expect(transTimeToDate('20260916101530')?.toISOString()).toBe('2026-09-16T07:15:30.000Z');
    expect(transTimeToDate('nonsense')).toBeNull();
  });
});
