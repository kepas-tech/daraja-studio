import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import type { C2bPayment } from '@kepas/daraja-js';
import { createEventHub } from '../src/events/hub.js';
import { createCollectService } from '../src/collect/service.js';
import { applyResult } from '../src/callbacks/apply.js';
import { recordC2b } from '../src/money_in/record.js';
import { countedIn } from '../src/money_in/link.js';
import { INCOMING_TYPES } from '../src/money_out/registry.js';
import { testDeps, resetTables } from './helpers.js';
import type { DarajaFactory } from '../src/sdk/client.js';

/**
 * Migration 049: a prompt and the confirmation Safaricom posts for the same money are linked, the
 * confirmation takes what only the prompt knew (whose payment it is), and the money counts once in
 * every reader, whichever of the two arrives first. Real PostgreSQL; no Safaricom at all.
 */
const deps = testDeps();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(() => deps.db.end());

const ACTOR = { personId: '', ip: '1.1.1.1' };
let n = 0;
let sinro = '';

function collect(checkoutId: string) {
  const factory = {
    get: async () => ({ collect: { stkPush: async () => ({ merchantRequestId: 'MR_' + checkoutId, checkoutRequestId: checkoutId, responseCode: '0', responseDescription: 'Accepted', customerMessage: 'Success' }) } }) as never,
    getForOperator: async () => { throw new Error('no operator for a prompt'); },
    invalidate: () => {},
    stkEnabled: async () => true,
  } as unknown as DarajaFactory;
  return createCollectService({ ...deps, daraja: factory, events });
}

/** Ask sinro's payer for KES 10 the way sinro does: its business code, and its own reference. */
async function ask(checkoutId: string, callerRef: string) {
  return collect(checkoutId).askToPay({ phone: '0700123456', amountCents: 1000, accountReference: '003', callerRef, confirmDuplicate: true }, ACTOR);
}
const paid = (checkoutId: string, receipt: string) => applyResult({ db: deps.db, events }, 'stk', { Body: { stkCallback: {
  MerchantRequestID: 'MR_' + checkoutId, CheckoutRequestID: checkoutId, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
  CallbackMetadata: { Item: [{ Name: 'Amount', Value: 10 }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'TransactionDate', Value: 20260924201742 }, { Name: 'PhoneNumber', Value: 254700123456 }] },
} } });
const confirmation = (receipt: string, billRef = '003') => recordC2b({ db: deps.db, events }, {
  transactionType: 'Pay Bill', transId: receipt, transTime: '20260924201742', amount: 10, shortCode: '600999', billRefNumber: billRef,
  invoiceNumber: '', orgAccountBalance: '', thirdPartyTransId: '', msisdn: '254700123456', firstName: 'NELSON', middleName: '', lastName: '',
} as unknown as C2bPayment, 'callback', { silent: true });

async function rowsFor(receipt: string) {
  return deps.db.query<{ id: string; type: string; prompt_id: string | null; confirmation_id: string | null; business_id: string | null; caller_ref: string | null }>(
    `SELECT id, type, prompt_id, confirmation_id, business_id, caller_ref FROM requests WHERE receipt=$1 ORDER BY type`, [receipt]);
}
/** What sweep, statements, reports and reconcile all add up now: money in that counts. */
async function countedFor(businessId: string): Promise<number> {
  const [r] = await deps.db.query<{ cents: string }>(
    `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM requests WHERE business_id=$1 AND status='completed' AND type = ANY($2) AND ${countedIn('')}`,
    [businessId, INCOMING_TYPES]);
  return Number(r!.cents);
}

describe('a prompt and its confirmation', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','x',true) RETURNING id`);
    ACTOR.personId = p.id;
    await deps.db.query(`INSERT INTO businesses(code, name) VALUES ('000','KEPAS')`);
    sinro = (await deps.db.query<{ id: string }>(`INSERT INTO businesses(code, name) VALUES ('003','SINRO') RETURNING id`))[0]!.id;
  });

  it('a prompt that names a business code is filed under it from the start', async () => {
    const v = await ask('ws_CO_A', 'user-1:wallet_topup');
    const [row] = await deps.db.query<{ business_id: string; account_reference: string }>(`SELECT business_id, account_reference FROM requests WHERE id=$1`, [v.id]);
    expect(row).toEqual({ business_id: sinro, account_reference: '003' });
  });

  it('prompt answered first, then the confirmation: linked, the payer known, counted once', async () => {
    await ask('ws_CO_1', 'user-1:wallet_topup');
    await paid('ws_CO_1', 'UIO0000001');
    expect(await countedFor(sinro)).toBe(1000);
    await confirmation('UIO0000001');
    const [c2b, stk] = await rowsFor('UIO0000001');
    expect(c2b!.type).toBe('c2b');
    expect(c2b!.prompt_id).toBe(stk!.id);
    expect(stk!.confirmation_id).toBe(c2b!.id);
    // Whose payment it is, on the row that counts.
    expect(c2b!.caller_ref).toBe('user-1:wallet_topup');
    expect(c2b!.business_id).toBe(sinro);
    expect(await countedFor(sinro)).toBe(1000);
  });

  it('confirmation first, then the prompt answered: the same link, the same single count', async () => {
    await ask('ws_CO_2', 'user-2:wallet_topup');
    await confirmation('UIO0000002');
    await paid('ws_CO_2', 'UIO0000002');
    const [c2b, stk] = await rowsFor('UIO0000002');
    expect(c2b!.prompt_id).toBe(stk!.id);
    expect(c2b!.caller_ref).toBe('user-2:wallet_topup');
    expect(await countedFor(sinro)).toBe(1000);
  });

  it('a prompt alone, or a confirmation alone, counts once and links to nothing', async () => {
    await ask('ws_CO_3', 'user-3:wallet_topup');
    await paid('ws_CO_3', 'UIO0000003');
    await confirmation('UIO0000004');
    expect(await countedFor(sinro)).toBe(2000);
    expect((await rowsFor('UIO0000003'))[0]!.confirmation_id).toBeNull();
    expect((await rowsFor('UIO0000004'))[0]!.prompt_id).toBeNull();
  });

  it('the two writers racing on one receipt always make exactly one link, and never deadlock', async () => {
    for (let i = 0; i < 50; i++) {
      const checkout = 'ws_CO_RACE_' + (++n);
      const receipt = 'UIR' + String(n).padStart(7, '0');
      await ask(checkout, `user-${n}:wallet_topup`);
      await Promise.all([paid(checkout, receipt), confirmation(receipt)]);
      const rows = await rowsFor(receipt);
      expect(rows).toHaveLength(2);
      const [c2b, stk] = rows;
      expect(c2b!.prompt_id).toBe(stk!.id);
      expect(stk!.confirmation_id).toBe(c2b!.id);
    }
    expect(await countedFor(sinro)).toBe(50 * 1000);
  });

  it('a prompt whose answer never came is linked by inference to the one confirmation for its reference and amount', async () => {
    await ask('ws_CO_LOST', 'user-5:wallet_topup');
    await confirmation('UIO0000005');
    const [c2b] = await rowsFor('UIO0000005');
    const [prompt] = await deps.db.query<{ id: string; confirmation_id: string; link_method: string }>(`SELECT id, confirmation_id, link_method FROM requests WHERE type='stk'`);
    expect(c2b!.prompt_id).toBe(prompt!.id);
    expect(prompt!.link_method).toBe('inferred');
    expect(c2b!.caller_ref).toBe('user-5:wallet_topup');
    expect(await countedFor(sinro)).toBe(1000);
  });

  it('two prompts that could be the one link nothing: a person decides', async () => {
    await ask('ws_CO_TWIN1', 'user-6:a');
    await ask('ws_CO_TWIN2', 'user-6:b');
    await confirmation('UIO0000006');
    expect((await rowsFor('UIO0000006'))[0]!.prompt_id).toBeNull();
  });

  it('an inference the prompt\'s own receipt contradicts is undone, and the true link made', async () => {
    await ask('ws_CO_WRONG', 'user-8:wallet_topup');
    await confirmation('UIO0000008');                  // inferred onto the waiting prompt
    await confirmation('UIO0000009');                  // the prompt's real payment, not yet known as such
    await paid('ws_CO_WRONG', 'UIO0000009');           // its answer names 09, so 08 was not it
    const [wrong] = await rowsFor('UIO0000008');
    expect(wrong!.prompt_id).toBeNull();
    expect(wrong!.caller_ref).toBeNull();
    const [right, stk] = await rowsFor('UIO0000009');
    expect(right!.prompt_id).toBe(stk!.id);
    expect(right!.caller_ref).toBe('user-8:wallet_topup');
  });
});
