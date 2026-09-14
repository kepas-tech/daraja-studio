import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { DarajaAPIError, DarajaAuthError, DarajaConnectionError } from '@kepas/daraja-js';
import { createEventHub } from '../src/events/hub.js';
import { createCollectService, NO_CHECKOUT_ID, STK_OFF } from '../src/collect/service.js';
import { UNCONFIRMED } from '../src/money_out/service.js';
import { listRequests } from '../src/money_out/reads.js';
import { MONEY_TYPES, LEDGER_TYPES } from '../src/money_out/registry.js';
import { testDeps, resetTables } from './helpers.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { HttpError } from '../src/util/errors.js';

const deps = testDeps();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(() => deps.db.end());

const ACTOR = { personId: '', ip: '1.1.1.1' };
const PAYER = '254700123456';

function factory(stkPush: (input: unknown) => Promise<unknown>, opts: { stkEnabled?: boolean } = {}): DarajaFactory {
  return {
    get: async () => ({ collect: { stkPush } }) as never,
    getForOperator: async () => { throw new Error('an STK push must never need an initiator operator'); },
    invalidate: () => {},
    stkEnabled: async () => opts.stkEnabled !== false,
  } as unknown as DarajaFactory;
}

const ack = vi.fn(async () => ({ merchantRequestId: 'MR_1', checkoutRequestId: 'ws_CO_1', responseCode: '0', responseDescription: 'Success. Request accepted for processing', customerMessage: 'Success' }));
const svcWith = (push: (input: unknown) => Promise<unknown>, opts?: { stkEnabled?: boolean }) =>
  createCollectService({ ...deps, daraja: factory(push, opts ?? {}), events });

const ASK = { phone: '0700123456', amountCents: 100, accountReference: 'INV-7' };

describe('collect: ask a customer to pay', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','x',true) RETURNING id`);
    ACTOR.personId = p.id;
    ack.mockClear();
  });

  it('stores the request before Safaricom hears of it, then records the checkout reference', async () => {
    let statusAtPushTime = '';
    const push = vi.fn(async (input: unknown) => {
      const [r] = await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE type='stk'`);
      statusAtPushTime = r!.status;
      void input;
      return ack();
    });
    const v = await svcWith(push).askToPay(ASK, ACTOR);

    expect(statusAtPushTime).toBe('pending');
    expect(v.status).toBe('sent');
    expect(v.type).toBe('stk');
    expect(v.recipient.value).toBe(PAYER);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      phone: PAYER, amount: 1, accountReference: 'INV-7', description: 'Payment',
      callbackUrl: 'https://studio.example/cb/sekret/stk',
    }));
    // The callback carries only the checkout reference, so that is what the row must be findable by.
    const [row] = await deps.db.query<{ payload_json: Record<string, unknown>; conversation_id: string }>('SELECT payload_json, conversation_id FROM requests WHERE id=$1', [v.id]);
    expect(row!.payload_json.ackOriginatorConversationId).toBe('ws_CO_1');
    expect(row!.conversation_id).toBe('MR_1');
  });

  it('never asks for an initiator operator, and refuses plainly when the passkey is missing', async () => {
    // `factory` throws if getForOperator is touched at all: an STK push authenticates with the
    // passkey, so an organisation with no operator must still be able to collect.
    const v = await svcWith(async () => ack()).askToPay(ASK, ACTOR);
    expect(v.status).toBe('sent');

    const push = vi.fn(async () => ack());
    await expect(svcWith(push, { stkEnabled: false }).askToPay(ASK, ACTOR)).rejects.toMatchObject({ status: 409, code: 'stk_off', message: STK_OFF });
    expect(push).not.toHaveBeenCalled();
    // Refused before anything was written: no row to confuse the operator later.
    expect(await deps.db.query(`SELECT 1 FROM requests WHERE type='stk' AND created_at > now() - interval '1 second'`)).toHaveLength(1);
  });

  it('refuses cents, an empty reference and a number that is not Kenyan, before any call', async () => {
    const push = vi.fn(async () => ack());
    const svc = svcWith(push);
    await expect(svc.askToPay({ ...ASK, amountCents: 150 }, ACTOR)).rejects.toMatchObject({ code: 'whole_shillings' });
    await expect(svc.askToPay({ ...ASK, accountReference: '   ' }, ACTOR)).rejects.toMatchObject({ code: 'bad_reference' });
    await expect(svc.askToPay({ ...ASK, phone: 'not a phone' }, ACTOR)).rejects.toMatchObject({ code: 'bad_phone' });
    expect(push).not.toHaveBeenCalled();
  });

  it('refused: a synchronous rejection fails the row with Safaricom\'s own words and no retry', async () => {
    const push = vi.fn(async () => { throw new DarajaAPIError('Invalid Access Token', { resultCode: 404, resultDesc: 'Invalid Access Token', scope: 'stk' }); });
    const v = await svcWith(push).askToPay(ASK, ACTOR);
    expect(v.status).toBe('failed');
    expect(v.safaricomSaid).toBe('Invalid Access Token');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('timed out: a connection failure holds the row as unknown, because the prompt may already be showing', async () => {
    const push = vi.fn(async () => { throw new DarajaConnectionError('socket hang up'); });
    const v = await svcWith(push).askToPay(ASK, ACTOR);
    expect(v.status).toBe('unknown');
    expect(v.meaning).toBe(UNCONFIRMED);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('a 5xx is held, not failed: Safaricom may have queued the prompt before it broke', async () => {
    const push = vi.fn(async () => { throw Object.assign(new DarajaAPIError('upstream', { scope: 'stk' }), { httpStatus: 502 }); });
    const v = await svcWith(push).askToPay(ASK, ACTOR);
    expect(v.status).toBe('unknown');
  });

  it('an accepted push with no checkout reference is held, never called sent', async () => {
    // Nothing else in the callback identifies this row, so calling it sent would promise a result
    // that can never be matched — and inviting another ask could charge the customer twice.
    const push = vi.fn(async () => ({ merchantRequestId: 'MR_2', checkoutRequestId: '', responseCode: '0', responseDescription: 'Success', customerMessage: 'ok' }));
    const v = await svcWith(push).askToPay(ASK, ACTOR);
    expect(v.status).toBe('unknown');
    expect(v.meaning).toBe(NO_CHECKOUT_ID);
    const [row] = await deps.db.query<{ payload_json: Record<string, unknown> }>('SELECT payload_json FROM requests WHERE id=$1', [v.id]);
    expect(row!.payload_json.ackOriginatorConversationId).toBeUndefined();
  });

  it('a non-zero response code fails the row rather than calling it sent', async () => {
    const push = vi.fn(async () => ({ merchantRequestId: '', checkoutRequestId: '', responseCode: '1', responseDescription: 'The service request failed', customerMessage: '' }));
    const v = await svcWith(push).askToPay(ASK, ACTOR);
    expect(v.status).toBe('failed');
    expect(v.safaricomSaid).toBe('The service request failed');
  });

  it('a bad OAuth pair fails the row and says which setting to fix', async () => {
    const push = vi.fn(async () => { throw new DarajaAuthError('invalid client'); });
    const v = await svcWith(push).askToPay(ASK, ACTOR);
    expect(v.status).toBe('failed');
    expect(v.whatToDo).toContain('consumer key');
  });

  it('asked twice for the same payer and amount: the second is refused until it is confirmed', async () => {
    const svc = svcWith(async () => ack());
    const first = await svc.askToPay(ASK, ACTOR);
    await expect(svc.askToPay(ASK, ACTOR)).rejects.toMatchObject({ status: 409, code: 'duplicate_recent', details: { requestId: first.id } });
    const confirmed = await svc.askToPay({ ...ASK, confirmDuplicate: true }, ACTOR);
    expect(confirmed.id).not.toBe(first.id);
  });

  it('two simultaneous identical asks produce exactly one request', async () => {
    const svc = svcWith(async () => ack());
    const results = await Promise.allSettled([svc.askToPay(ASK, ACTOR), svc.askToPay(ASK, ACTOR)]);
    const refused = results.filter((r) => r.status === 'rejected' && (r.reason as HttpError).code === 'duplicate_recent');
    expect(refused).toHaveLength(1);
    expect(await deps.db.query(`SELECT 1 FROM requests WHERE type='stk'`)).toHaveLength(1);
  });

  it('is money in: never counted as a send, and always shown in History', async () => {
    const v = await svcWith(async () => ack()).askToPay(ASK, ACTOR);
    // The monthly send allowance and the money-out sweep both read MONEY_TYPES. A payment request
    // appearing there would spend a tenant's send quota on taking money, and would be polled with
    // the wrong status call.
    expect(MONEY_TYPES).not.toContain('stk');
    expect(LEDGER_TYPES).toContain('stk');
    const page = await listRequests(deps.db, { limit: 25 });
    expect(page.items.map((i) => i.id)).toContain(v.id);
  });
});

describe('proving the passkey', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());
    await deps.settings.set('daraja.environment', 'sandbox');
    const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner','x',true) RETURNING id`);
    ACTOR.personId = p.id;
  });

  // A passkey cannot be checked by any read-only Daraja call. The only proof it is right is
  // Safaricom accepting a push — which it refuses, at the acknowledgement, before any phone rings,
  // when the passkey is wrong. So the owner can prove theirs by asking their own number and
  // cancelling the prompt: no money moves and the acceptance is the evidence.
  it('an accepted push proves it, and the date is kept from the first proof', async () => {
    const svc = svcWith(async () => ack());
    expect(await deps.settings.get('env.sandbox.passkeyProvenAt')).toBeNull();

    await svc.askToPay(ASK, ACTOR);
    const first = await deps.settings.get('env.sandbox.passkeyProvenAt');
    expect(first).toBeTruthy();

    await svc.askToPay({ ...ASK, confirmDuplicate: true }, ACTOR);
    expect(await deps.settings.get('env.sandbox.passkeyProvenAt')).toBe(first);
  });

  it('a refused push proves nothing — this is exactly the wrong-passkey case', async () => {
    // Safaricom answers a wrong passkey with a non-zero response code (4999, "Wrong credentials"),
    // and no prompt is sent. Recording proof here would recreate the bug this exists to stop.
    const push = async () => ({ merchantRequestId: '', checkoutRequestId: '', responseCode: '4999', responseDescription: 'Wrong credentials', customerMessage: '' });
    const v = await svcWith(push).askToPay(ASK, ACTOR);
    expect(v.status).toBe('failed');
    expect(await deps.settings.get('env.sandbox.passkeyProvenAt')).toBeNull();
  });

  it('a held push proves nothing either, because Safaricom never answered', async () => {
    const push = async () => { throw new DarajaConnectionError('socket hang up'); };
    const v = await svcWith(push).askToPay(ASK, ACTOR);
    expect(v.status).toBe('unknown');
    expect(await deps.settings.get('env.sandbox.passkeyProvenAt')).toBeNull();
  });
});
