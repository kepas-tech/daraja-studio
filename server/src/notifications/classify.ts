import type { RequestView } from '../money_out/reads.js';

export type Severity = 'info' | 'success' | 'warning' | 'critical';
export type NotificationCategory = 'money_out' | 'money_in' | 'approvals' | 'operators' | 'invoices' | 'accounts';

export interface Classified {
  severity: Severity;
  category: NotificationCategory;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  dedupeKey: string;
}

/**
 * Feature 4. The event alone cannot say what happened: a `request.updated` payload carries an id
 * and a status, and the amount, the name and the receipt live on the row. The writer loads the
 * request view first and hands it in here, so this file stays a pure function with no database and
 * its lines are tested on their own.
 */
export interface ClassifyInput { type: string; payload: unknown; request?: RequestView | null }

/** Everything a customer starts, plus the invoice push: money arriving, not leaving. */
const MONEY_IN_TYPES = new Set(['c2b', 'stk', 'ratiba', 'express', 'bonga']);

/** KES 300, or KES 300.50 when the cents matter. */
function kes(cents: number | null): string {
  if (cents === null) return 'KES';
  return 'KES ' + (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
}

/**
 * The owner's own name for the payee first (the contact or the customer), then the name Safaricom
 * returned. Never the phone number: the inbox is a record, and a number in it is a number that
 * leaks into a screenshot.
 */
function nameOf(r: RequestView): string | null {
  return r.contactName ?? r.accountName ?? r.recipient.name ?? null;
}

/** " to Joseph" / " from Joseph" / nothing at all when no name is known. */
function withName(name: string | null, word: 'to' | 'from'): string {
  return name ? ' ' + word + ' ' + name : '';
}

/** The receipt is the proof the owner may need later, so it goes in the line when there is one. */
function withReceipt(r: RequestView, sentence: string): string {
  return r.receipt ? sentence + ' Receipt ' + r.receipt + '.' : sentence;
}

const req = (r: RequestView, over: Partial<Classified>): Classified => ({
  severity: 'info', category: 'money_out', type: 'request.updated', title: 'Payment update',
  body: '', data: { requestId: r.id }, dedupeKey: 'request:' + r.id + ':' + r.status, ...over,
});

/** The line for one request row, chosen by the status the event named. */
function lineFor(r: RequestView, status: string): Classified | null {
  const moneyIn = MONEY_IN_TYPES.has(r.type);
  const invoice = r.type === 'invoice_payment';
  const name = nameOf(r);
  const amount = kes(r.amountCents);

  if (status === 'completed') {
    if (invoice) {
      return req(r, { severity: 'success', category: 'invoices', type: 'request.completed', title: 'Invoice paid', dedupeKey: 'request:' + r.id + ':completed',
        body: withReceipt(r, 'An invoice was paid: ' + amount + withName(name, 'from') + '.') });
    }
    if (moneyIn) {
      return req(r, { severity: 'success', category: 'money_in', type: 'request.completed', title: 'Money received', dedupeKey: 'request:' + r.id + ':completed',
        body: withReceipt(r, 'Received ' + amount + withName(name, 'from') + '.') });
    }
    return req(r, { severity: 'success', category: 'money_out', type: 'request.completed', title: 'Money sent', dedupeKey: 'request:' + r.id + ':completed',
      body: withReceipt(r, 'Sent ' + amount + withName(name, 'to') + '. They received it.') });
  }

  if (status === 'failed') {
    const said = r.safaricomSaid ? ' Safaricom said: ' + r.safaricomSaid : '';
    const line = moneyIn
      ? amount + withName(name, 'from') + ' did not arrive.'
      : amount + withName(name, 'to') + ' did not go out.';
    return req(r, { severity: 'warning', category: invoice ? 'invoices' : moneyIn ? 'money_in' : 'money_out',
      type: 'request.failed', title: moneyIn ? 'Money in failed' : 'Send failed', dedupeKey: 'request:' + r.id + ':failed', body: line + said });
  }

  if (status === 'unknown') {
    return req(r, { severity: 'warning', category: moneyIn ? 'money_in' : 'money_out', type: 'request.unknown', title: 'No answer yet',
      dedupeKey: 'request:' + r.id + ':unknown',
      body: 'No answer from Safaricom for ' + amount + withName(name, moneyIn ? 'from' : 'to') + ' yet.' });
  }

  if (status === 'awaiting_approval') {
    return req(r, { severity: 'info', category: 'approvals', type: 'request.awaiting_approval', title: 'Waiting for approval',
      dedupeKey: 'request:' + r.id + ':awaiting_approval',
      body: amount + withName(name, 'to') + ' is waiting for a second person.' });
  }

  if (status === 'rejected') {
    return req(r, { severity: 'warning', category: 'approvals', type: 'request.rejected', title: 'Send refused',
      dedupeKey: 'request:' + r.id + ':rejected',
      body: amount + withName(name, 'to') + ' was refused.' });
  }

  // pending and sent are the ordinary steps of every send; a line for each would bury the ones that matter.
  return null;
}

/**
 * One event in, one line out, or null when the event is not worth telling anybody about. The
 * writer drops nulls; nothing else filters.
 */
export function classify(e: ClassifyInput): Classified | null {
  const payload = (e.payload ?? {}) as Record<string, unknown>;

  if (e.type === 'operator.updated') {
    if (payload.status !== 'failed') return null;
    const operatorId = typeof payload.operatorId === 'string' ? payload.operatorId : 'unknown';
    return {
      severity: 'critical', category: 'operators', type: 'operator.failed', title: 'Operator problem',
      body: 'The operator stopped working. Sends will fail until it is fixed. Open Organisation to see it.',
      data: { operatorId }, dedupeKey: 'operator:' + operatorId + ':failed',
    };
  }

  // Brief 2, item 1: a scope's numbers ran out and the next width opened. The owner should hear it:
  // the numbers their payers are told grow by a digit, and nothing else about them changes.
  if (e.type === 'accounts.width_grew') {
    const width = typeof payload.width === 'number' ? payload.width : null;
    if (width === null) return null;
    const businessId = typeof payload.businessId === 'string' ? payload.businessId : null;
    const accountId = typeof payload.accountId === 'string' ? payload.accountId : null;
    const who = payload.scope === 'sub_accounts'
      ? 'Sub-accounts under ' + (typeof payload.accountName === 'string' ? payload.accountName : 'an account')
      : 'Account numbers for ' + (typeof payload.businessName === 'string' ? payload.businessName : 'a business');
    return {
      severity: 'info', category: 'accounts', type: 'accounts.width_grew', title: 'Longer account numbers',
      body: who + ' now have ' + width + ' digits. All 900 shorter numbers are used.',
      data: { businessId, accountId, width },
      dedupeKey: 'accounts:width:' + (accountId ?? businessId ?? 'unknown') + ':' + width,
    };
  }

  const r = e.request ?? null;
  if (!r) return null;
  // request.updated names the new status in its payload; the alert for a swept row carries only the
  // id, so the row's own status is what it means.
  const status = typeof payload.status === 'string' ? payload.status : r.status;
  if (e.type === 'request.updated') return lineFor(r, status);
  if (e.type === 'alert' && payload.kind === 'request_unknown') return lineFor(r, 'unknown');
  return null;
}
