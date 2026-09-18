import type { Daraja, DarajaScope } from '@kepas/daraja-js';
import type { PermissionKey } from '../permissions/catalog.js';
import type { callbackUrls } from '../sdk/callbackUrls.js';
import { b2c } from './kinds/b2c.js';
import { reversal } from './kinds/reversal.js';
import { stk } from './kinds/stk.js';
import { ratiba } from './kinds/ratiba.js';
import { express } from './kinds/express.js';
import { bonga } from './kinds/bonga.js';

export { toCents } from './amounts.js';

export type CallbackUrls = ReturnType<typeof callbackUrls>;

export interface RequestRow {
  id: string; type: string; subtype: string | null; originator_conversation_id: string; conversation_id: string | null; status: string;
  amount_cents: string | null; recipient_kind: string | null; recipient_value: string | null; recipient_name: string | null; remarks: string | null;
  payload_json: Record<string, unknown>; operator_id: string | null; created_by: string | null; created_at: Date; sent_at: Date | null;
  result_at: Date | null; result_source: 'callback' | 'poll' | 'ack' | null; result_code: string | null; result_desc: string | null; meaning: string | null;
  retriable: boolean | null; receipt: string | null; raw_result_json: unknown; poll_attempts: number; last_poll_at: Date | null;
  checked_by: string | null; checked_at: Date | null; checked_note: string | null;
  bulk_plan_id?: string | null;
}

export interface ParsedResult {
  originatorConversationId: string; conversationId: string; resultCode: number; resultDesc: string; success: boolean;
  receipt?: string; recipientName?: string; completedAt?: string; utilityCents?: number | null; workingCents?: number | null;
}

/** What a caller must supply for a kind, and what the row's `recipient_value` then holds. */
export type RecipientShape = 'phone' | 'shortcode' | 'receipt' | 'none';

export interface RequestKind {
  type: string;
  permission: PermissionKey;
  scope: DarajaScope;
  callbackPath: 'b2c' | 'b2b' | 'reversal' | 'status' | 'stk' | 'ratiba' | 'express' | 'c2b/confirm';
  /** `none` is money coming in: a payment request credits the shortcode, it debits no account. */
  debits: 'utility' | 'working' | 'none';
  wholeShillings: boolean;
  /**
   * Does one of these consume the tenant's monthly *send* allowance?
   *
   * Required, not defaulted, because guessing it wrong costs a tenant money either way. A phone
   * send is what the plan sells, so it counts. A reversal is money going back to a customer who
   * should not have paid: charging the allowance for it would penalise a business for correcting
   * its own mistake, and could leave it unable to pay a supplier because it issued refunds.
   */
  countsAsSend: boolean;
  /**
   * B0: what this kind sends to. `none` is a real case (a float transfer moves money between the
   * organisation's own two accounts), and it is why the duplicate guard cannot compare
   * `recipient_value` with `=`: SQL equality against NULL is never true, so a no-recipient kind
   * would silently never detect a duplicate. Every guard goes through `dupKey` instead.
   */
  recipient: RecipientShape;
  /**
   * The canonical duplicate identity for one request of this kind. It is both the advisory lock
   * key and what the guard compares, so the lock and the lookup can never disagree.
   */
  dupKey(row: Pick<RequestRow, 'type' | 'recipient_value' | 'amount_cents' | 'payload_json'>): string;
  /** Only B2C has two live API versions to negotiate; no other kind may retry on a refusal. */
  versionFallback?: boolean;
  send(client: Daraja, row: RequestRow, urls: CallbackUrls, opts?: { b2cVersion?: 'v1' | 'v3' }): Promise<{ conversationId: string; originatorConversationId: string; responseCode: string; responseDescription: string }>;
  parseResult(body: unknown): ParsedResult;
}

// Kinds live one per file under ./kinds and are registered here. Adding a send type is a new file
// plus one line in this map; nothing in the send path, the callback path or the sweep is edited.
export const KINDS: Record<string, RequestKind> = { b2c, reversal };
/**
 * Money OUT only, and deliberately so. This is what the sweep polls with `status.transaction`.
 * Money coming in must never appear here: asking a customer to pay would otherwise be polled with
 * the wrong status call.
 */
export const MONEY_TYPES: string[] = Object.keys(KINDS);

/**
 * What the plan actually charges for. `MONEY_TYPES` answers "which kinds does the result machinery
 * handle" — the sweep, the status callback, Mark as checked — and every money-out kind belongs to
 * it. Billing asks a different question, and the two answers are not the same list: a reversal must
 * be swept, because a lost callback leaves real money in limbo, but must not spend an allowance.
 *
 * These were one list until M3 added the first kind where they differ.
 */
export const BILLABLE_SEND_TYPES: string[] = Object.entries(KINDS).filter(([, k]) => k.countsAsSend).map(([type]) => type);

/**
 * Money IN. Separate map, same machinery: a request to Safaricom, an acknowledgement, then a
 * callback. Kept apart from `KINDS` so nothing that reasons about sending accidentally counts it.
 * History shows both, which is the one place the two lists are combined.
 */
export const COLLECT_KINDS: Record<string, RequestKind> = { stk, ratiba, express, bonga };
export const COLLECT_TYPES: string[] = Object.keys(COLLECT_KINDS);
/** Everything the tenant should see in History, whichever direction the money moved. */
/** Money that arrives without a request from us (M2): read by History, never polled, never a send. */
export const MONEY_IN_TYPES: string[] = ['c2b', 'invoice_payment'];
/**
 * Round 3, phase A: everything that arrives rather than leaves — a payment request the payer
 * answered, and money that landed without one. The one list the read layer needs to tell which way a
 * row's money moved, so no screen has to work it out from type strings of its own.
 */
export const INCOMING_TYPES: string[] = [...COLLECT_TYPES, ...MONEY_IN_TYPES];
/** Which way one row's money moves: `in`, `out`, or null for a row that moves none at all —
 * a status query, a balance check. */
export function directionOf(type: string): 'in' | 'out' | null {
  if (INCOMING_TYPES.includes(type)) return 'in';
  return MONEY_TYPES.includes(type) ? 'out' : null;
}
export const LEDGER_TYPES: string[] = [...MONEY_TYPES, ...COLLECT_TYPES, ...MONEY_IN_TYPES];

/** Every kind that answers on one callback path, in either direction. The callback resolves the row
 * first, then checks the row's kind is actually one of these — a result posted to the wrong path is
 * never applied. */
export const kindsForPath = (path: RequestKind['callbackPath']): RequestKind[] =>
  [...Object.values(KINDS), ...Object.values(COLLECT_KINDS)].filter((k) => k.callbackPath === path);

/** Safaricom result codes that mean the API operator credential itself is bad or locked. 2001 and
 * 8006 come from Safaricom's own documents; TP40153 is KEPAS Pay's operator classification, and
 * @kepas/daraja-js 1.6.3 catalogues it on that same reading. */
export const CREDENTIAL_CODES: ReadonlySet<string> = new Set(['2001', '8006', 'TP40153']);
