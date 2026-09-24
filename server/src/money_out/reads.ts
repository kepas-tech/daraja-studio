import type { Db } from '../db/pool.js';
import { explain, type DarajaScope } from '../sdk/meaning.js';
import { HttpError } from '../util/errors.js';
import { COLLECT_KINDS, directionOf, KINDS, LEDGER_TYPES, MONEY_TYPES, type RequestRow } from './registry.js';
import { AUTH_FAILED_MEANING } from './service.js';
import { isPhoneToken, personName } from '../util/names.js';

export interface RequestView {
  id: string; type: string; subtype: string | null; status: string; amountCents: number | null; currency: 'KES';
  /** The caller's own reference, exactly as it was sent, and null when it sent none. Opaque to
   *  Studio: it is stored and echoed back, and nothing routes on it. */
  callerRef: string | null;
  /** Safaricom's own name for an STK request, which is what its callback carries back and what a
   *  caller reconciles against. Only an STK request has one; on every other kind `originator_
   *  conversation_id` holds Studio's own identifier, so it is reported as null rather than handed
   *  over as something it is not. */
  checkoutRequestId: string | null;
  recipient: { kind: string | null; value: string | null; name: string | null }; remarks: string | null; receipt: string | null;
  /** The business's own payment category name, when the send was made with one. */
  category: string | null;
  /** The account number the payer typed on a money-in row (Safaricom's billRefNumber); null on a
   * money-out row, which has no account number. Feature 2 reads the business code out of it. */
  accountReference: string | null;
  createdAt: string; sentAt: string | null; resultAt: string | null; resultSource: 'callback' | 'poll' | 'ack' | 'feed' | null;
  safaricomSaid: string | null; meaning: string | null; whatToDo: string | null; retriable: boolean; pollAttempts: number;
  checked: { by: { id: string; displayName: string } | null; at: string; note: string } | null;
  createdBy: { id: string; displayName: string } | null;
  /**
   * Step six, part five: the API key that asked for this payment, when a machine asked rather than a
   * person. A notice for this row goes to that key's own webhook address when it has one.
   */
  apiKeyId: string | null;
  /**
   * Migration 049: a prompt and the confirmation Safaricom posted for the same money are linked.
   * The confirmation is the row that counts; the prompt names it.
   */
  /** Migration 050: the business's code, and the app's own reference for the user this account is. */
  businessCode?: string | null;
  accountExternalRef?: string | null;
  promptId: string | null;
  confirmationId: string | null;
  /** M4: who released or refused a held send. */
  approvedBy: { id: string; displayName: string } | null;
  /** M5: the batch this send was part of. */
  bulkPlanId: string | null;
  /** Feature 1: the name the owner saved for this recipient, when the send named a contact. Shown
   * beside the name on the row; see `party.savedName`. */
  contactName: string | null;
  /**
   * Round 3, phase A: which way this row's money moved — `in`, `out`, or null for a row that moves
   * none at all (a status query, a balance check).
   */
  direction: 'in' | 'out' | null;
  /**
   * Round 3, phase A: the person on the other side of this row, named by the direction.
   * `requests.recipient_name` is one column holding two different people — the payer when money
   * came in, the person paid when it went out — so the read layer names it here, once, and no screen
   * has to ask what type it is reading. The stored value is read through the same helper that wrote
   * it, so a row recorded before phase A (Safaricom's `"254700123456 - Jane Doe"`, the Pull API's
   * `MPESA`) reads exactly like a new one.
   */
  party: {
    /** The best name Studio holds: Safaricom's own, else the customer account this row names, else
     * the owner's saved contact for that number. */
    name: string | null;
    /** What to show under the name. Null when Safaricom sent only its hashed stand-in for a
     * number, never a number to print. */
    number: string | null;
    /** The owner's own label for that number. The screens show it beside the name when the two
     * differ, because that mismatch is what a person needs to see. */
    savedName: string | null;
  };
  /** Brief 2, item 1: the business this row belongs to, and the account whose number it named —
   * either level. The ids are the raw columns, so Money in can link to History filtered by either
   * one, and the full number is what the payer typed. */
  businessId: string | null;
  accountId: string | null;
  businessName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  /** Brief 2, item 1b: the account is gone, and these are the holder the digits came from. */
  deletedAccountName: string | null;
  deletedAccountAt: string | null;
  /** The live account's number was somebody else's until this date, within the last year. */
  previousHolderName: string | null;
  previousHolderUntil: string | null;
  /** Feature 11: what Safaricom's band said this row costs, in cents. Null on a row written
   * before the feature, and on an amount no band covers — never a zero standing in for unknown. */
  chargeCents: number | null;
}

export type ViewRow = RequestRow & {
  created_by_name?: string | null; checked_by_name?: string | null; approved_by_name?: string | null; approved_by?: string | null;
  contact_name?: string | null; business_name?: string | null; account_name?: string | null; account_number?: string | null; business_code?: string | null; account_external_ref?: string | null; created_cursor?: string;
  /** Brief 2, item 1b: the two history lines, from number_history. */
  deleted_name?: string | null; deleted_at_text?: string | null; previous_name?: string | null; previous_until_text?: string | null;
  /** Brief 2, item 1: columns selected by r.* that the base RequestRow predates. */
  account_reference?: string | null; business_id?: string | null; account_id?: string | null;
  /** Feature 11: the same, for the charge stored on the row. */
  charge_cents?: string | number | null;
};

/** Every column the view needs, with the two display-name joins, plus a microsecond-exact text
 * rendering of created_at for cursor paging — a JS Date only holds milliseconds, so the
 * cursor must be built from this text column, never from row.created_at. Append WHERE/ORDER/LIMIT. */
export const VIEW_SELECT = `SELECT r.*, p.display_name AS created_by_name, c.display_name AS checked_by_name, a.display_name AS approved_by_name, COALESCE(ct.name, pc.name) AS contact_name,
  bz.name AS business_name, bz.code AS business_code, ac.name AS account_name, ac.full_number AS account_number, ac.external_ref AS account_external_ref,
  dh.name AS deleted_name, dh.deleted_text AS deleted_at_text, ph.name AS previous_name, ph.until_text AS previous_until_text,
  to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor
  FROM requests r LEFT JOIN people p ON p.id = r.created_by LEFT JOIN people c ON c.id = r.checked_by LEFT JOIN people a ON a.id = r.approved_by
  LEFT JOIN contacts ct ON ct.id = r.contact_id
  -- Round 3, phase A: a row written before the contact link existed, or one that arrived without a
  -- request of ours at all (money in never names a contact), still belongs to a number the owner has
  -- saved. The name the owner gave that number is its saved name there too, so a payment from a known
  -- phone shows the person rather than a number alone. A deliberately retired contact is not matched:
  -- the row keeps whatever its own link already holds.
  LEFT JOIN LATERAL (
    SELECT c2.name FROM contacts c2
     WHERE c2.kind = 'phone' AND c2.phone = r.recipient_value AND c2.deleted_at IS NULL
     ORDER BY c2.created_at ASC LIMIT 1
  ) pc ON true
  LEFT JOIN businesses bz ON bz.id = r.business_id LEFT JOIN accounts ac ON ac.id = r.account_id
  -- Brief 2, item 1b, the two places the record shows on a money row. The digits the payer typed are
  -- on the row for ever; when the account they named has been deleted, the newest holder of those
  -- digits explains who it was. When the account is live but its number was handed out again inside
  -- the last year, the previous holder explains why the digits look familiar.
  LEFT JOIN LATERAL (
    SELECT h.name, to_char(h.deleted_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') AS deleted_text
      FROM number_history h WHERE r.account_id IS NULL AND h.full_number = r.account_reference
      ORDER BY h.deleted_at DESC LIMIT 1
  ) dh ON true
  LEFT JOIN LATERAL (
    SELECT h.name, to_char(h.deleted_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM-DD') AS until_text
      FROM number_history h
     WHERE r.account_id IS NOT NULL AND h.full_number = ac.full_number
       AND h.deleted_at <= ac.created_at AND h.deleted_at > now() - interval '12 months'
     ORDER BY h.deleted_at DESC LIMIT 1
  ) ph ON true`;

export const UNKNOWN_WHAT_TO_DO = 'Do not send it again yet. Studio is checking with Safaricom; if it stays unknown, check the Safaricom portal, then Mark as checked.';
export const POLL_FAILED_WHAT_TO_DO = "Safaricom's record is final. Send again if the money did not arrive; contact Safaricom API support if the portal statement disagrees.";
export const AUTH_FAILED_WHAT_TO_DO = 'Open Settings › Daraja app and re-enter the consumer key and secret, then try again.';

// null when the request's type is neither a money-out kind nor one of the two lookup types —
// never guess a catalog scope for a type we don't recognise.
const scopeOf = (type: string): DarajaScope | null => {
  // M1: both directions. A payment request is an ordinary row here, so its Safaricom result text
  // must be explained from the `stk` catalog rather than falling through to null and showing the
  // operator a bare code with no meaning.
  const kind = KINDS[type] ?? COLLECT_KINDS[type];
  if (kind) return kind.scope;
  if (type === 'status_query') return 'status';
  if (type === 'balance') return 'balance';
  if (type === 'c2b') return 'c2b';
  if (type === 'invoice_payment') return 'billmanager';
  return null;
};

/**
 * `egressIps` is the hosted service's own outgoing addresses; they only ever change the "what to do
 * now" line for 403.002.1001 (spec 4.6). Single mode passes none and reads exactly as it always has.
 */
export function toView(row: ViewRow, egressIps: string[] = []): RequestView {
  // whatToDo is derived at read time so copy changes apply to old rows; the stored `meaning`
  // (Safaricom's catalog text or the studio note for unknown/connection cases) is kept as is.
  const scope = scopeOf(row.type);
  // b2cApiUsed (recorded on every b2c send) picks the v3-specific 403.002.1001 copy over the
  // general one — read at view time, same as the rest of `ex`, so copy changes still apply to old
  // rows.
  const b2cApiUsed = scope === 'b2c' ? (row.payload_json as { b2cApiUsed?: 'v1' | 'v3' }).b2cApiUsed : undefined;
  const ex = row.result_code !== null && scope !== null ? explain(scope, row.result_code, row.result_desc ?? '', { b2cApiUsed, egressIps }) : null;
  // Phase A: the readable person and number for this row, decided once. A value Safaricom sent as
  // its hashed stand-in for a phone number is no number at all, so it is left out rather than
  // printed where a person expects to read a phone.
  const number = isPhoneToken(row.recipient_value) ? null : row.recipient_value;
  const storedName = personName(row.recipient_name);
  return {
    id: row.id, type: row.type, subtype: row.subtype, status: row.status,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents), currency: 'KES',
    recipient: { kind: row.recipient_kind, value: number, name: storedName },
    direction: directionOf(row.type),
    party: { name: storedName ?? row.account_name ?? row.contact_name ?? null, number, savedName: row.contact_name ?? null },
    remarks: row.remarks, receipt: row.receipt,
    callerRef: row.caller_ref ?? null,
    // The same coalesce the callback path uses to find this row: Safaricom's id when we recorded
    // one, else the identifier the row was created with, which for a send is our own.
    checkoutRequestId: row.type === 'stk'
      ? ((row.payload_json as { ackOriginatorConversationId?: string }).ackOriginatorConversationId ?? null)
      : null,
    category: typeof (row.payload_json as { category?: unknown }).category === 'string' ? (row.payload_json as { category: string }).category : null,
    // A business payment carries the account number it quoted to the paybill. Only B2B reads it from
    // the payload: a payment request keeps its own Daraja reference there, which is not an account.
    accountReference: row.account_reference ?? (row.type === 'b2b' && typeof (row.payload_json as { accountReference?: unknown }).accountReference === 'string' ? (row.payload_json as { accountReference: string }).accountReference : null),
    createdAt: row.created_at.toISOString(), sentAt: row.sent_at?.toISOString() ?? null, resultAt: row.result_at?.toISOString() ?? null, resultSource: row.result_source,
    safaricomSaid: row.result_desc, meaning: row.meaning ?? ex?.meaning ?? null,
    whatToDo: row.status === 'failed'
      ? (ex?.whatToDo ?? (row.result_source === 'poll' ? POLL_FAILED_WHAT_TO_DO
          : row.result_code === null && row.meaning === AUTH_FAILED_MEANING ? AUTH_FAILED_WHAT_TO_DO
          : null))
      // W4: once a human has checked it, studio is not going to check it itself (the sweep and its
      // expiry both exclude checked_at IS NOT NULL rows) — telling the operator "Studio is
      // checking with Safaricom" would be a lie.
      : row.status === 'unknown' ? (row.checked_at ? null : (ex?.whatToDo ?? UNKNOWN_WHAT_TO_DO)) : null,
    retriable: row.retriable ?? false, pollAttempts: row.poll_attempts,
    checked: row.checked_at ? { by: row.checked_by ? { id: row.checked_by, displayName: row.checked_by_name ?? '' } : null, at: row.checked_at.toISOString(), note: row.checked_note ?? '' } : null,
    createdBy: row.created_by ? { id: row.created_by, displayName: row.created_by_name ?? '' } : null,
    apiKeyId: row.api_key_id ?? null,
    promptId: row.prompt_id ?? null,
    confirmationId: row.confirmation_id ?? null,
    approvedBy: row.approved_by ? { id: row.approved_by, displayName: row.approved_by_name ?? '' } : null,
    bulkPlanId: row.bulk_plan_id ?? null,
    contactName: row.contact_name ?? null,
    businessId: row.business_id ?? null,
    accountId: row.account_id ?? null,
    businessName: row.business_name ?? null,
    accountName: row.account_name ?? null,
    accountNumber: row.account_number ?? null,
    businessCode: row.business_code ? String(row.business_code).trim() : null,
    accountExternalRef: row.account_external_ref ?? null,
    deletedAccountName: row.deleted_name ?? null,
    deletedAccountAt: row.deleted_at_text ?? null,
    previousHolderName: row.previous_name ?? null,
    previousHolderUntil: row.previous_until_text ?? null,
    chargeCents: row.charge_cents === null || row.charge_cents === undefined ? null : Number(row.charge_cents),
  };
}

export async function getRequest(db: Db, id: string, egressIps: string[] = []): Promise<RequestView | null> {
  const rows = await db.query<ViewRow>(`${VIEW_SELECT} WHERE r.id = $1`, [id]);
  return rows[0] ? toView(rows[0], egressIps) : null;
}

export interface ListQuery { type?: string[]; status?: string; from?: string; to?: string; q?: string; limit: number; cursor?: string; /** Brief 2, item 1: History and Money in filter by business, and an account link narrows to one account — naming a customer includes the accounts under it. */ businessId?: string; accountId?: string }
export interface Page<T> { items: T[]; nextCursor: string | null }

// Matches exactly what VIEW_SELECT's created_cursor column produces — a UTC, microsecond-exact
// text rendering of created_at. A cursor whose `at` half doesn't match this shape, or whose
// `id` half isn't a real uuid (the same strict shape routes.ts uses for path ids), is rejected
// before it ever reaches a SQL cast — a bad cast there would otherwise 500 and log the
// attacker-controlled literal.
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (createdCursor: string, id: string) => Buffer.from(`${createdCursor}|${id}`).toString('base64url');
function decodeCursor(c: string): { at: string; id: string } | null {
  let s: string;
  try { s = Buffer.from(c, 'base64url').toString('utf8'); } catch { return null; }
  const i = s.indexOf('|');
  if (i < 0) return null;
  const at = s.slice(0, i); const id = s.slice(i + 1);
  if (!CURSOR_AT_RE.test(at) || Number.isNaN(Date.parse(at)) || !CURSOR_ID_RE.test(id)) return null;
  return { at, id };
}

// LIKE metacharacters in the operator's own search text must stay literal — '%' or '_' typed
// into the search box should search for that character, not act as a wildcard.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** History hides operator probes, the sweep's own polls and a manual check's own status_query row
 * (subtype='manual', pollOne) — the operator sees the outcome on the target row, not a
 * separate History row for the check itself. */
export async function listRequests(db: Db, query: ListQuery, egressIps: string[] = []): Promise<Page<RequestView>> {
  const where: string[] = [`r.type = ANY($1)`, `(r.subtype IS NULL OR r.subtype NOT IN ('operator_probe','sweep','manual'))`];
  // M1: History is the one place the two directions are shown together — money sent and money
  // asked for. `MONEY_TYPES` stays money-out only because the send allowance and the sweep count
  // it; the ledger the operator reads is `LEDGER_TYPES`.
  const params: unknown[] = [query.type?.length ? query.type : LEDGER_TYPES];
  if (query.status) { params.push(query.status); where.push(`r.status = $${params.length}`); }
  if (query.businessId) { params.push(query.businessId); where.push(`r.business_id = $${params.length}`); }
  // Naming a customer account narrows to it and to the accounts under it: the operator asked about
  // Jane, and a room under Jane is Jane's money. Naming one of those accounts narrows to itself.
  if (query.accountId) {
    params.push(query.accountId);
    where.push(`(r.account_id = $${params.length} OR r.account_id IN (SELECT id FROM accounts WHERE parent_id = $${params.length}))`);
  }
  // Day bounds are the operator's own calendar day (Africa/Nairobi, M2), not the server's UTC day.
  if (query.from) { params.push(query.from); where.push(`(r.created_at AT TIME ZONE 'Africa/Nairobi')::date >= $${params.length}::date`); }
  if (query.to) { params.push(query.to); where.push(`(r.created_at AT TIME ZONE 'Africa/Nairobi')::date <= $${params.length}::date`); }
  if (query.q) {
    const like = `%${escapeLike(query.q)}%`;
    params.push(like, like, like, query.q);
    const n = params.length;
    const parts = [
      `r.recipient_value ILIKE $${n - 3} ESCAPE '\\'`,
      `r.recipient_name ILIKE $${n - 2} ESCAPE '\\'`,
      `r.receipt ILIKE $${n - 1} ESCAPE '\\'`,
      `r.originator_conversation_id = $${n}`,
    ];
    // W1: recipient_value stores the e.164 form (254…); the search box says "phone" and studio
    // itself displays "0700 123 456", so a query that is a Kenyan mobile number in any common
    // written form (0700123456, 0700 123 456, +254700123456, 700123456) must also match by its
    // normalised e.164 value, not only as a raw ILIKE substring of the stored digits.
    const digits = query.q.replace(/[\s()-]/g, '');
    const phoneMatch = /^\+?(?:254|0)?([17]\d{8})$/.exec(digits);
    if (phoneMatch) { params.push(`254${phoneMatch[1]}`); parts.push(`r.recipient_value = $${params.length}`); }
    where.push(`(${parts.join(' OR ')})`);
  }
  const cur = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cur) throw new HttpError(400, 'bad_cursor', 'That page link has expired. Reload History.');
  if (cur) {
    params.push(cur.at, cur.id);
    const n = params.length;
    where.push(`(r.created_at, r.id) < ($${n - 1}::timestamptz, $${n}::uuid)`);
  }
  params.push(query.limit + 1);
  const rows = await db.query<ViewRow>(`${VIEW_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`, params);
  const more = rows.length > query.limit;
  const page = more ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return { items: page.map((row) => toView(row, egressIps)), nextCursor: more && last && last.created_cursor ? encodeCursor(last.created_cursor, last.id) : null };
}

/** How many checks the History list shows. */
export const CHECKS_LIMIT = 20;

/**
 * Round 3, phase D-3: a check Studio made with Safaricom. Every one of these is already a
 * `requests` row of type `status_query` — the sweep's own polls, a person pressing Check on a
 * payment, and a receipt typed into History — written so the answer can be matched when it comes
 * back. Nothing listed them; this is that read. A health probe is not a check a person made, so it
 * is left out.
 */
export interface CheckView {
  id: string;
  /** How it was made: the sweep, a person pressing Check, or a receipt looked up. */
  kind: 'sweep' | 'manual' | 'lookup';
  /** What it was about. A lookup names only the receipt that was typed. */
  target: { requestId: string | null; receipt: string | null; name: string | null; number: string | null };
  status: string;
  /** Safaricom's own words, then Studio's reading of its code. */
  said: string | null;
  meaning: string | null;
  askedAt: string;
  resultAt: string | null;
  askedBy: { id: string; displayName: string } | null;
}

interface CheckRow {
  id: string; subtype: string | null; status: string; result_code: string | null; result_desc: string | null;
  created_at: Date; result_at: Date | null; recipient_value: string | null; created_by: string | null; asked_by_name: string | null;
  target_id: string | null; target_receipt: string | null; target_name: string | null; target_value: string | null;
}

export async function listChecks(db: Db, opts: { limit?: number } = {}): Promise<CheckView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), CHECKS_LIMIT);
  const rows = await db.query<CheckRow>(`
    SELECT q.id, q.subtype, q.status, q.result_code, q.result_desc, q.created_at, q.result_at, q.recipient_value,
           q.created_by, p.display_name AS asked_by_name,
           t.id AS target_id, t.receipt AS target_receipt, t.recipient_name AS target_name, t.recipient_value AS target_value
      FROM requests q
      LEFT JOIN people p ON p.id = q.created_by
      -- The payment a check was about is named in the check's own payload. Matching it as text
      -- never casts a value that an older or hand-written payload could break, and the list is
      -- only ever the newest few rows.
      LEFT JOIN requests t ON t.id::text = q.payload_json->>'targetRequestId'
     WHERE q.type = 'status_query' AND q.subtype IN ('sweep','manual','lookup')
     ORDER BY q.created_at DESC, q.id DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => {
    const ex = r.result_code !== null ? explain('status', r.result_code, r.result_desc ?? '') : null;
    const targetNumber = isPhoneToken(r.target_value) ? null : r.target_value;
    return {
      id: r.id,
      kind: (r.subtype ?? 'sweep') as CheckView['kind'],
      target: {
        requestId: r.target_id,
        receipt: r.target_id ? r.target_receipt : r.recipient_value,
        name: r.target_id ? personName(r.target_name) : null,
        number: r.target_id ? targetNumber : null,
      },
      status: r.status,
      said: r.result_desc,
      meaning: ex?.meaning ?? null,
      askedAt: r.created_at.toISOString(),
      resultAt: r.result_at?.toISOString() ?? null,
      askedBy: r.created_by ? { id: r.created_by, displayName: r.asked_by_name ?? '' } : null,
    };
  });
}

/** Feature 5: how many rows a Waiting section shows before it says it is cut off. */
export const WAITING_LIMIT = 100;

export interface WaitingSection { items: RequestView[]; count: number }
export interface WaitingView {
  /** Empty unless the caller may release or refuse; `canDecide` says which, so the page never
   * draws a button the release route would refuse. */
  approvals: { items: RequestView[]; canDecide: boolean };
  sent: WaitingSection;
  noAnswer: WaitingSection;
  badge: number;
}

/**
 * Feature 5: everything that has not finished, for the Waiting page. The type list is
 * `MONEY_TYPES`, the sweep's own universe (money out): a row only appears here while the existing
 * rules could still move it, and every row's "Check with Safaricom" names a type that route
 * accepts. A row a person has already checked leaves the page, exactly as it leaves the sweep.
 * Order and `count` are separate: the page shows the newest `limit` and the true total, so a
 * cut-off section can say so.
 */
export async function listWaiting(db: Db, opts: { canDecide: boolean; egressIps: string[]; limit?: number }): Promise<WaitingView> {
  const limit = opts.limit ?? WAITING_LIMIT;
  // A pending row has no sent_at yet (a crash between the INSERT and Safaricom's ack), hence the
  // same COALESCE the sweep uses for its age.
  const live = `r.type = ANY($1) AND r.checked_at IS NULL`;
  const newestFirst = `ORDER BY COALESCE(r.sent_at, r.created_at) DESC, r.id DESC`;
  const [sentRows, noAnswerRows, sentCount, noAnswerCount, approvalCount] = await Promise.all([
    db.query<ViewRow>(`${VIEW_SELECT} WHERE ${live} AND r.status IN ('sent','pending') ${newestFirst} LIMIT $2`, [MONEY_TYPES, limit]),
    db.query<ViewRow>(`${VIEW_SELECT} WHERE ${live} AND r.status = 'unknown' ${newestFirst} LIMIT $2`, [MONEY_TYPES, limit]),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM requests r WHERE ${live} AND r.status IN ('sent','pending')`, [MONEY_TYPES]),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM requests r WHERE ${live} AND r.status = 'unknown'`, [MONEY_TYPES]),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM requests r WHERE r.status = 'awaiting_approval'`, []),
  ]);
  // The held section keeps the approvals route's own gate and shape, so Release and Refuse are
  // handed exactly what they had before this page existed.
  const held = opts.canDecide ? (await listRequests(db, { status: 'awaiting_approval', limit }, opts.egressIps)).items : [];
  return {
    approvals: { items: held, canDecide: opts.canDecide },
    sent: { items: sentRows.map((row) => toView(row, opts.egressIps)), count: sentCount[0]?.n ?? 0 },
    noAnswer: { items: noAnswerRows.map((row) => toView(row, opts.egressIps)), count: noAnswerCount[0]?.n ?? 0 },
    badge: (approvalCount[0]?.n ?? 0) + (noAnswerCount[0]?.n ?? 0),
  };
}

/**
 * Feature 5: what the menu badge counts — held sends plus sends Safaricom never answered. A row
 * that is merely sent is not a badge: it needs no person yet.
 */
export async function waitingBadge(db: Db): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM requests r
      WHERE r.status = 'awaiting_approval' OR (r.status = 'unknown' AND r.checked_at IS NULL AND r.type = ANY($1))`,
    [MONEY_TYPES]);
  return row?.n ?? 0;
}

