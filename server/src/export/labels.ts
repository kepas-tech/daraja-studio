/**
 * Feature 3: the words the exported spreadsheets use for a request type, a payment kind and a
 * status. They are the same words the History and Invoices pages show (web/src/copy/en.ts), copied
 * here because the server and the web bundle are built apart and the server cannot import the
 * page's copy file. `server/test/export.test.ts` asserts every type and status the app can store
 * has a label, so the two lists drifting apart fails a test instead of shipping a file an
 * accountant cannot read.
 */
export const TYPE_LABELS: Record<string, string> = {
  b2c: 'Sent to a phone',
  c2b: 'Paid in',
  invoice_payment: 'Invoice paid',
  ratiba: 'Standing order',
  express: 'Asked a business to pay',
  bonga: 'Paid with Bonga points',
  stk: 'Asked for payment',
  reversal: 'Reversal',
  balance: 'Balance check',
  status_query: 'Payment lookup',
};

export const SUBTYPE_LABELS: Record<string, string> = {
  BusinessPayment: 'Business payment',
  SalaryPayment: 'Salary',
  PromotionPayment: 'Promotion',
  refresh: 'Balance refresh',
  lookup: 'Lookup',
  sweep: 'Safaricom check',
};

export const STATUS_LABELS: Record<string, string> = {
  pending: 'Preparing',
  sent: 'Waiting',
  completed: 'Paid',
  failed: 'Failed',
  unknown: 'Needs a check',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
  awaiting_approval: 'Waiting for approval',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  sent: 'Sent',
  partly_paid: 'Partly paid',
  paid: 'Paid',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
};

/** The same order the History page reads: the owner's own category first, then the kind, then the type. */
export function whatLabel(row: { category: string | null; subtype: string | null; type: string }): string {
  return row.category ?? SUBTYPE_LABELS[row.subtype ?? ''] ?? TYPE_LABELS[row.type] ?? row.type;
}

export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status;
export const invoiceStatusLabel = (status: string): string => INVOICE_STATUS_LABELS[status] ?? status;
