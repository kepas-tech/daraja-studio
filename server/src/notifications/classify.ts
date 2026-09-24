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

/** KES 300, KES 2,057 when the figure is bigger, or KES 300.50 when the cents matter. Grouped the
 *  way the rest of Studio writes money, so the inbox and the page it links to read alike. */
function kes(cents: number | null): string {
  if (cents === null) return 'KES';
  const n = cents / 100;
  return 'KES ' + (cents % 100 === 0
    ? n.toLocaleString('en-KE')
    : n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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

  // Brief 2, item 7: the last verified operator just went down, so nothing can go out until one is
  // fixed. The link points at the cards the owner fixes it on (Organisation › the environment).
  if (e.type === 'alert' && payload.kind === 'operators_exhausted') {
    return {
      severity: 'critical', category: 'operators', type: 'operators.exhausted',
      title: 'No working operator left',
      body: 'Payments out cannot go until you fix one.',
      data: { href: '/account' },
      dedupeKey: 'operators:exhausted',
    };
  }

  // Step three of nine: a business's money could not leave — the float is short, nobody has read it,
  // or Studio has no charge for the amount. The money is safe and still owed, and the owner is the
  // one who can move float across, which is why this is a line in the inbox and not a log entry.
  // Scheduled payments: every run tells the owner afterwards, and a run the float refused or a date
  // Studio missed says so loudly, because people were not paid.
  if (e.type === 'alert' && (payload.kind === 'schedule_run' || payload.kind === 'schedule_refused' || payload.kind === 'schedule_missed')) {
    const name = typeof payload.scheduleName === 'string' ? payload.scheduleName : 'A schedule';
    const runId = typeof payload.runId === 'string' ? payload.runId : null;
    const data = { runId, scheduleId: typeof payload.scheduleId === 'string' ? payload.scheduleId : null, href: runId ? '/schedules/runs/' + runId : '/schedules' };
    const dedupeKey = 'schedule:' + (runId ?? 'run') + ':' + String(payload.kind) + ':' + String(payload.state ?? '');
    if (payload.kind === 'schedule_refused') {
      return { severity: 'critical', category: 'money_out', type: 'schedule.refused', title: 'Scheduled payment not sent',
        body: name + ': ' + (typeof payload.reason === 'string' ? payload.reason : 'nobody was paid.'), data, dedupeKey };
    }
    if (payload.kind === 'schedule_missed') {
      return { severity: 'critical', category: 'money_out', type: 'schedule.missed', title: 'Scheduled payment missed',
        body: name + ' was due on ' + String(payload.payOn ?? 'a past date') + ' while Studio was not running. Nobody was paid; pay it by hand if it is still owed.', data, dedupeKey };
    }
    const failed = typeof payload.failed === 'number' ? payload.failed : 0;
    const lines = typeof payload.lines === 'number' ? payload.lines : 0;
    const total = typeof payload.totalCents === 'number' ? payload.totalCents : null;
    return {
      severity: failed > 0 ? 'critical' : 'success', category: 'money_out', type: 'schedule.run',
      title: failed === 0 ? 'Scheduled payment done' : 'Scheduled payment: some failed',
      body: name + ': ' + kes(total) + ' to ' + lines + (lines === 1 ? ' payee' : ' payees') + (failed > 0 ? ', ' + failed + ' failed. Open the run to see why.' : ', all paid.'),
      data, dedupeKey,
    };
  }

  if (e.type === 'alert' && payload.kind === 'sweep_held') {
    const who = typeof payload.businessName === 'string' ? payload.businessName : 'A business';
    const owedCents = typeof payload.owedCents === 'number' ? payload.owedCents : null;
    const gapCents = typeof payload.gapCents === 'number' && payload.gapCents > 0 ? payload.gapCents : null;
    return {
      severity: gapCents === null ? 'warning' : 'critical', category: 'money_out', type: 'sweep.held', title: 'Sweep held',
      body: gapCents === null
        ? 'Nothing was sent for ' + who + '. ' + kes(owedCents) + ' is still owed and goes with the next sweep.'
        : 'The float is ' + kes(gapCents) + ' short, so nothing was sent for ' + who + '. ' + kes(owedCents) + ' is still owed and goes as one when the float covers it.',
      data: { businessId: typeof payload.businessId === 'string' ? payload.businessId : null, sweepId: typeof payload.sweepId === 'string' ? payload.sweepId : null },
      dedupeKey: 'sweep:' + (typeof payload.sweepId === 'string' ? payload.sweepId : 'held'),
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
