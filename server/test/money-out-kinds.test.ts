import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeApp, resetTables } from './helpers.js';
import { KINDS, type RequestKind } from '../src/money_out/registry.js';
import { applyResult } from '../src/callbacks/apply.js';

/**
 * B0's generality, proved against kinds that exist only in this file.
 *
 * Codex's scope check (C-002, finding 8) was right: production `KINDS` holds one entry today, so a
 * test that loops over `KINDS` exercises phone sends and calls that generality. The two kinds below
 * are the cases the real registry does not contain yet — one sharing the B2C callback address with
 * the phone send (B1's pochi shape), and one answering elsewhere with no recipient at all (B3's
 * float shape). They are registered for this file only, never reach the production registry, and no
 * route serves them.
 */

const { deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });

const result = (ocid: string, code: number, desc: string) => ({
  originatorConversationId: ocid, conversationId: `AG_${ocid}`, resultCode: code, resultDesc: desc,
  success: code === 0, receipt: code === 0 ? 'RI6BZTPXNM' : undefined, recipientName: undefined,
  completedAt: undefined, utilityCents: null, workingCents: null,
});
const readBody = (body: unknown) => body as { ocid: string; code: number; desc: string };

const sharesB2cPath: RequestKind = {
  type: 'test_shares_b2c', permission: 'send.phone', scope: 'b2c', callbackPath: 'b2c',
  debits: 'utility', wholeShillings: true, recipient: 'phone',
  dupKey: (row) => `${row.recipient_value ?? ''}|${row.amount_cents ?? ''}|test_shares_b2c`,
  send: async () => { throw new Error('never dispatched here'); },
  parseResult: (body) => { const b = readBody(body); return result(b.ocid, b.code, b.desc); },
};

const otherPathNoRecipient: RequestKind = {
  type: 'test_other_path', permission: 'send.phone', scope: 'b2b', callbackPath: 'b2b',
  debits: 'working', wholeShillings: true, recipient: 'none',
  dupKey: (row) => `none|${row.amount_cents ?? ''}|test_other_path`,
  send: async () => { throw new Error('never dispatched here'); },
  parseResult: (body) => { const b = readBody(body); return result(b.ocid, b.code, b.desc); },
};

beforeAll(() => {
  KINDS[sharesB2cPath.type] = sharesB2cPath;
  KINDS[otherPathNoRecipient.type] = otherPathNoRecipient;
});
afterAll(() => {
  delete KINDS[sharesB2cPath.type];
  delete KINDS[otherPathNoRecipient.type];
});
beforeEach(async () => { await resetTables(); });

async function sent(type: string, ocid: string, recipient: string | null, amountCents = 100) {
  const [r] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, sent_at)
     VALUES ($1,$2,'sent',$3,$4,$5, now()) RETURNING id`,
    [type, ocid, amountCents, recipient === null ? 'none' : 'phone', recipient]);
  return r!.id;
}
const statusOf = async (id: string) => (await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [id]))[0]!.status;
const descOf = async (id: string) => (await deps.db.query<{ result_desc: string | null }>('SELECT result_desc FROM requests WHERE id=$1', [id]))[0]!.result_desc;

describe('B0: one result path serves every kind', () => {
  it('applies a result to the row of the kind that owns it when two kinds share one address', async () => {
    const mine = await sent(sharesB2cPath.type, 'ocid-shared-1', '254700123456');
    const phone = await sent('b2c', 'ocid-shared-2', '254700123456');

    const verdict = await applyResult({ db: deps.db, events: deps.events }, 'b2c', { ocid: 'ocid-shared-1', code: 0, desc: 'The service request is processed successfully.' });

    expect(verdict.verdict).toBe('applied');
    expect(await statusOf(mine)).toBe('completed');
    // The phone send sharing that address is untouched: an address is not a kind.
    expect(await statusOf(phone)).toBe('sent');
  });

  it('never applies a result that arrived at an address its kind does not answer on', async () => {
    const row = await sent(otherPathNoRecipient.type, 'ocid-wrong-path', null);

    const verdict = await applyResult({ db: deps.db, events: deps.events }, 'b2c', { ocid: 'ocid-wrong-path', code: 0, desc: 'ok' });

    expect(verdict.verdict).toBe('unmatched');
    expect(await statusOf(row)).toBe('sent');
  });

  it('records a failure as a failure, in Safaricom’s own words', async () => {
    const row = await sent(sharesB2cPath.type, 'ocid-failed', '254700123456');

    const verdict = await applyResult({ db: deps.db, events: deps.events }, 'b2c', { ocid: 'ocid-failed', code: 2001, desc: 'The initiator information is invalid.' });

    expect(verdict.verdict).toBe('applied');
    expect(await statusOf(row)).toBe('failed');
    expect(await descOf(row)).toBe('The initiator information is invalid.');
  });

  it('applies one result once however many times it is delivered', async () => {
    const row = await sent(sharesB2cPath.type, 'ocid-twice', '254700123456');
    const body = { ocid: 'ocid-twice', code: 0, desc: 'ok' };

    const first = await applyResult({ db: deps.db, events: deps.events }, 'b2c', body);
    const second = await applyResult({ db: deps.db, events: deps.events }, 'b2c', body);

    expect(first.verdict).toBe('applied');
    expect(second.verdict).toBe('duplicate');
    expect(await statusOf(row)).toBe('completed');
  });
});

describe('B0: a kind with no recipient still has a duplicate identity', () => {
  it('keys on the kind and the amount, not on a recipient it does not have', () => {
    const key = otherPathNoRecipient.dupKey({ type: otherPathNoRecipient.type, recipient_value: null, amount_cents: '5000', payload_json: {} });
    expect(key).toBe('none|5000|test_other_path');
    expect(otherPathNoRecipient.dupKey({ type: otherPathNoRecipient.type, recipient_value: null, amount_cents: '6000', payload_json: {} })).not.toBe(key);
  });

  it('finds its own earlier row even though the recipient is NULL', async () => {
    await sent(otherPathNoRecipient.type, 'ocid-dup-1', null, 5000);

    // This is the comparison the send path makes. `=` returns nothing against NULL, which was the
    // defect: a no-recipient kind would have looked protected while never detecting a duplicate.
    const withEquals = await deps.db.query(
      'SELECT id FROM requests WHERE type=$1 AND recipient_value = $2 AND amount_cents=$3', [otherPathNoRecipient.type, null, 5000]);
    const nullSafe = await deps.db.query(
      'SELECT id FROM requests WHERE type=$1 AND recipient_value IS NOT DISTINCT FROM $2 AND amount_cents=$3', [otherPathNoRecipient.type, null, 5000]);

    expect(withEquals.length).toBe(0);
    expect(nullSafe.length).toBe(1);
  });
});

describe('B0: version negotiation belongs only to the kind that has versions', () => {
  it('is claimed by the phone send and by nothing else', () => {
    expect(KINDS.b2c!.versionFallback).toBe(true);
    expect(sharesB2cPath.versionFallback).toBeUndefined();
    expect(otherPathNoRecipient.versionFallback).toBeUndefined();
  });
});
