import { randomUUID } from 'node:crypto';
import { DarajaAPIError, DarajaAuthError, DarajaConnectionError, normalizePhone, type Daraja } from '@kepas/daraja-js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import type { Cache } from '../db/cache.js';
import type { Settings, Env } from '../settings/store.js';
import type { DarajaFactory } from '../sdk/client.js';
import type { EventHub } from '../events/hub.js';
import type { OrgService } from '../orgs/service.js';
import { currentCallbackSecret } from '../orgs/secret.js';
import { audit } from '../audit/log.js';
import { callbackUrls } from '../sdk/callbackUrls.js';
import { explain, type DarajaScope } from '../sdk/meaning.js';
import { HttpError } from '../util/errors.js';
import { parseCategories } from '../settings/categories.js';
import { enqueue } from '../db/jobs.js';
import { PUBLIC_URL_UNVERIFIED } from './ready.js';
import { KINDS, MONEY_TYPES, type CallbackUrls, type RequestKind, type RequestRow } from './registry.js';
import { recordOperatorRefusal } from './operatorHealth.js';
import { createOperatorLock } from './operatorLock.js';
import { createFeesService } from '../fees/service.js';
import { resolveAccount } from '../businesses/lookup.js';
import { personName } from '../util/names.js';
import { getRequest, listRequests, listWaiting, waitingBadge, type Page, type RequestView, type WaitingView } from './reads.js';

export interface SendInput { phone: string; amountCents: number; commandId: 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment'; category?: string; remarks?: string; occasion?: string; confirmDuplicate?: boolean; /** Feature 1: the saved phone contact this send is labelled with; checked below. */ contactId?: string; /** Feature 2: the business this send belongs to. Checked below; the last one used becomes the pickers' default. */ businessId?: string; /** Brief 2, item 1: the account this money is for. Checked below, and it carries its own business. */ accountId?: string; /** Round 3, phase A: the name the review screen confirmed with Safaricom, so the row is named while it waits rather than only once the result arrives. */ recipientName?: string; /** M5: the batch this row belongs to; never accepted from a client. */ bulk?: { planId: string; index: number } }
/** Pay another business: a paybill with the account number it asks for, or a till. */
export interface BusinessPayInput { to: 'paybill' | 'till'; shortcode: string; accountReference?: string; amountCents: number; remarks?: string; confirmDuplicate?: boolean; contactId?: string; businessId?: string; /** The name the review screen got from Safaricom for this number. */ recipientName?: string }
/** One new send, once its inputs are checked: what createAndDispatch writes and sends. */
interface NewSend {
  kind: RequestKind; subtype: string; amountCents: number; recipientKind: 'phone' | 'paybill' | 'till'; recipientValue: string;
  recipientName: string | null; remarks: string | null; payload: Record<string, unknown>; audit: Record<string, unknown>;
  contactId: string | null; businessId: string | null; accountId: string | null; chargeCents: number | null; bulkPlanId: string | null; confirmDuplicate: boolean;
}
/**
 * What Safaricom says a paybill or till is registered as, asked on the review before a business
 * payment. `not_found`: Safaricom answered and knows no such number of that kind. `unavailable`:
 * Studio could not ask (the lookup is not reliable in the sandbox), so the review says to check the
 * number instead.
 */
export type BusinessCheck = { available: true; name: string; paidBefore: boolean } | { available: false; reason: 'not_found' | 'unavailable'; paidBefore: boolean };
/**
 * Who is behind a send. `personId` is null for the one sender that is not a person: sweep-through
 * hands a business's own money to its own number on the timetable it chose, with nobody pressing
 * anything. The row records no author — because there is none — and the audit log says the same.
 */
export interface Actor { personId: string | null; ip: string }
/**
 * What Safaricom says about the person behind a phone number, asked before a send (B2C
 * Hakikisha). `not_enabled`: Safaricom has not switched the check on for this paybill or till
 * (it needs their approval), so the review falls back to "check the number". `not_found`: the
 * number is not an M-Pesa customer. `said` is Safaricom's own line, or null when it gave none.
 */
/**
 * Round 3, phase D-4: `paidBefore` answers "has this studio ever paid this number?" — asked on
 * the review screen beside the name, because the first payment to a number is the one worth
 * pausing over. It is answered from Studio's own rows even when Safaricom cannot name the
 * number, so it rides on every branch.
 */
export type NameCheck =
  | { available: true; name: string; paidBefore: boolean }
  | { available: false; reason: 'not_found' | 'not_enabled' | 'unavailable'; said: string | null; paidBefore: boolean };
export interface MoneyOutService {
  send(input: SendInput, actor: Actor): Promise<RequestView>;
  /** B2B: pay a paybill or a till. The same path as a phone send from the row onwards. */
  payBusiness(input: BusinessPayInput, actor: Actor): Promise<RequestView>;
  /** The registered name behind a paybill or till, asked on the business payment's review. */
  businessCheck(to: 'paybill' | 'till', shortcode: string): Promise<BusinessCheck>;
  /** The registered name behind a phone number, when Safaricom lets this shortcode ask. */
  nameCheck(phone: string): Promise<NameCheck>;
  sweep(): Promise<{ polled: number; expired: number }>;
  /** Round 3, phase D-3: `actor` is who pressed Check, recorded on the check's own row. */
  pollOne(requestId: string, actor?: { personId: string | null }): Promise<{ queryId: string }>;
  markChecked(requestId: string, note: string, actor: Actor): Promise<RequestView>;
  refreshBalance(actor: Actor | null): Promise<{ requestId: string }>;
  /** Round 4: `actor.personId` is null when Studio asked on its own, to fill a missing name. */
  lookup(receipt: string, actor: { personId: string | null; ip: string }, opts?: { subject?: string }): Promise<{ requestId: string }>;
  /** M4: a second person sends a held row down the ordinary path. */
  release(requestId: string, actor: Actor): Promise<RequestView>;
  /**
   * Brief 2, item 7: send a row that a credential-class refusal just failed again with the next
   * verified operator. True when it went out again, false when there was no other operator to use —
   * which is the caller's answer to "did anything change".
   */
  failover(requestId: string, failedOperatorId: string | null): Promise<boolean>;
  refuse(requestId: string, reason: string, actor: Actor): Promise<RequestView>;
  listAwaiting(): Promise<Page<RequestView>>;
  /** Feature 5: the Waiting page's three sections. `canDecide` is the release route's own gate. */
  listWaiting(canDecide: boolean): Promise<WaitingView>;
  /** Feature 5: held sends plus sends Safaricom never answered, for the menu badge. */
  waitingBadge(): Promise<number>;
  /** Held rows older than 24 hours are refused by the clock. Returns how many. */
  expireApprovals(): Promise<number>;
}

export const UNCONFIRMED = 'We could not confirm Safaricom received this. Studio will check.';
export const B2C_QUEUE_TIMEOUT = "Safaricom's queue timed out before this payment was processed. Studio will check whether it went through.";
export const NO_ANSWER_AFTER_POLLS = 'No answer from Safaricom after 5 checks. Check the Safaricom portal, then Mark as checked.';
export const AUTH_FAILED_MEANING = 'Safaricom did not accept the Daraja key and secret. Check them in Settings.';
const DUP_WINDOW = "interval '5 minutes'";
export const APPROVAL_EXPIRED = 'Not approved within 24 hours.';
export const NOT_HELD = 'This send is not waiting for approval.';
export const OWN_REQUEST = 'You cannot approve or refuse a send you made yourself.';
const DUPLICATE_ID = 'Duplicate OriginatorConversationID';
const MAX_POLLS = 5;

// Once a v1 send has assigned Safaricom's own OriginatorConversationID, everything that asks
// Safaricom about that payment again must use Safaricom's id, not ours — Safaricom itself never
// heard of ours. Falls back to our own id when no ack id was ever recorded (v3, or a send that
// never got an ack at all).
const SAFARICOM_OCID = "COALESCE(payload_json->>'ackOriginatorConversationId', originator_conversation_id)";

/** True ONLY for a synchronous HTTP 403 straight from the API gateway, before Safaricom's core
 * ever saw the request: no ConversationID, no ack, nothing queued or processed — so retrying the
 * SAME row on v1 cannot cause a double payment. `e.resultCode` is set only when the studio's own
 * code constructs the error AFTER already receiving an ack (the `ack.responseCode !== '0'` check
 * below) — that shape must never retry, ack or no ack, because Safaricom already saw the request.
 * The HTTP status must be checked too, not only the error code: a 5xx carrying this same
 * `errorCode` in its body is NOT the gateway's "nothing was queued" guarantee — it could mean the
 * request reached Safaricom before an upstream failure — so it must fall through to the existing
 * `maybeQueued` ("unknown") handling below instead of ever retrying.
 */
export function isV3GatewayRefusal(e: unknown): e is DarajaAPIError {
  if (!(e instanceof DarajaAPIError) || e.resultCode != null) return false;
  if ((e as { httpStatus?: unknown }).httpStatus !== 403) return false;
  const raw = (e as { raw?: unknown }).raw;
  const errorCode = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).errorCode : undefined;
  return errorCode === '403.002.1001';
}

/** Safaricom's own code and text from a synchronous rejection. The SDK's errorFromResponse only
 * sets resultCode/resultDesc when the caller passed them explicitly (our own ack.responseCode
 * check does); a real Daraja sync rejection carries them on the error's raw payload instead
 * (non-enumerable, never logged here). */
export function syncRejection(e: DarajaAPIError): { code: string | null; desc: string } {
  if (e.resultCode != null) return { code: String(e.resultCode), desc: e.resultDesc ?? e.message };
  const raw = (e as { raw?: unknown }).raw;
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const code = typeof o.ResponseCode === 'string' ? o.ResponseCode : typeof o.errorCode === 'string' ? o.errorCode : null;
  const desc = e.resultDesc ?? (typeof o.ResponseDescription === 'string' ? o.ResponseDescription : typeof o.errorMessage === 'string' ? o.errorMessage : e.message);
  return { code, desc };
}

/** Turn an SDK rejection from a balance/status call into the studio's three-line error shape.
 * Never touches `raw`. A `DarajaConnectionError`, or anything else reaching here (a bare network
 * failure, say), means the same thing from the operator's chair — the call to Safaricom did not
 * complete — so both collapse to the same `safaricom_unreachable` line rather than inventing a
 * meaning decision 4 never named. `details` carries the catalog meaning alongside Safaricom's own
 * text so a `safaricom_rejected` response still shows the house three lines, not only one. */
export function sdkCallError(e: unknown, scope: DarajaScope, egressIps: string[]): HttpError {
  if (e instanceof DarajaAuthError) return new HttpError(502, 'daraja_auth', e.message);
  if (e instanceof DarajaAPIError) {
    const { code, desc } = syncRejection(e);
    const ex = code !== null ? explain(scope, code, desc, { egressIps }) : null;
    return new HttpError(502, 'safaricom_rejected', desc, { safaricomSaid: desc, meaning: ex?.meaning ?? null, whatToDo: ex?.whatToDo ?? null });
  }
  if (e instanceof DarajaConnectionError) return new HttpError(502, 'safaricom_unreachable', 'Safaricom did not answer. Try again in a moment.');
  throw e;
}

/**
 * RLS already scopes every one of the statements below that touches `requests`, but the admin pool
 * (a superuser) bypasses RLS entirely, and the runtime pool is not role-bound — so the
 * sweep's two direct queries and pollOne's row read also carry an explicit `org_id = $n`, the same
 * defence settings/store.ts already applies (design decision I1).
 */
function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('no organisation in scope');
  return orgId;
}

export function createMoneyOutService(deps: { db: Db; settings: Settings; cache: Cache; daraja: DarajaFactory; events: EventHub; config: Config; orgs: OrgService }): MoneyOutService {
  // Feature 11: the band this send falls in, stored on the row so History shows what it cost. Built
  // from the same pool, so no dependency has to be threaded through every caller of this factory.
  const fees = createFeesService({ db: deps.db });
  // Brief 2, item 7: one request in flight per operator, which is what makes the two-try guard hold
  // when a batch is going out on a credential Safaricom has just started refusing.
  const lock = createOperatorLock({ cache: deps.cache });

  async function urls() {
    const publicUrl = await deps.settings.get('public.url');
    if (!publicUrl) throw new HttpError(409, 'public_url_unverified', 'Test your public address in Settings first.');
    return callbackUrls(publicUrl, await currentCallbackSecret(deps.orgs));
  }

  async function view(id: string): Promise<RequestView> {
    const v = await getRequest(deps.db, id, deps.config.egressIps);
    if (!v) throw new HttpError(404, 'not_found', 'That request does not exist.');
    return v;
  }

  /** Every status-query row (sweep/manual polls and a receipt lookup) is keyed on a
   * studio-generated id, never Safaricom's ack — Safaricom queries by (and echoes back) the
   * *target's own* OriginatorConversationID (or, for a lookup, nothing of ours at all), so
   * storing that echo as the row's own id would collide with the UNIQUE column. The
   * echoed id and the ack's own conversation id go in payload_json/conversation_id instead, for
   * statusHandler to match on. */
  async function recordStatusQuery(
    ack: { conversationId: string; originatorConversationId: string },
    opts: { subtype: 'sweep' | 'manual' | 'lookup'; payload: Record<string, unknown>; recipientValue?: string; createdBy?: string | null },
  ): Promise<{ id: string }> {
    const [q] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, recipient_value, created_by, payload_json)
       VALUES ('status_query',$1,$2,$3,'sent',now(),$4,$5,$6::jsonb) RETURNING id`,
      [opts.subtype, randomUUID(), ack.conversationId || null, opts.recipientValue ?? null, opts.createdBy ?? null, JSON.stringify(opts.payload)]);
    return q;
  }

  /** One status query for a target. Counts the attempt before the call so a crash mid-call still
   * counts. */
  async function pollTarget(client: Daraja, cb: CallbackUrls, target: { id: string; originator_conversation_id: string }, subtype: 'sweep' | 'manual', createdBy: string | null = null): Promise<{ ok: true; queryId: string } | { ok: false; reason: 'sdk_rejected' | 'not_recorded' }> {
    await deps.db.query(`UPDATE requests SET poll_attempts = poll_attempts + 1, last_poll_at = now() WHERE id=$1`, [target.id]);
    let ack: { conversationId: string; originatorConversationId: string };
    try {
      ack = await client.status.transaction({ originatorConversationId: target.originator_conversation_id, resultUrl: cb.status, queueTimeoutUrl: cb.status, remarks: 'studio check' });
    } catch (e) {
      console.error('status query rejected', target.id, e instanceof Error ? e.message : e);
      return { ok: false, reason: 'sdk_rejected' };
    }
    try {
      const q = await recordStatusQuery(ack, { subtype, payload: { targetRequestId: target.id, ackOriginatorConversationId: ack.originatorConversationId }, createdBy });
      return { ok: true, queryId: q.id };
    } catch (e) {
      // Safaricom accepted the query (the ack above succeeded) but our own bookkeeping failed to
      // record it — never blame Safaricom for this. Nothing will ever match this poll by query
      // row; a human or the direct-match fallback in statusHandler is the only way back.
      console.error('status query not recorded', target.id, e instanceof Error ? e.message : e);
      await deps.events.publish('alert', { kind: 'status_query_not_recorded', id: target.id });
      return { ok: false, reason: 'not_recorded' };
    }
  }

  async function clientOrNull(): Promise<Daraja | null> {
    try { return await deps.daraja.getForOperator(); }
    catch (e) { if (e instanceof HttpError && e.code === 'no_operator') return null; throw e; }
  }

  /** The active environment's B2C API choice, and the version a send should actually use:
   * an explicit `v1`/`v3` setting always wins; `auto` (default) uses whatever was last detected,
   * or `v3` when nothing has been detected yet. */
  async function resolveB2cVersion(): Promise<{ version: 'v1' | 'v3'; setting: 'auto' | 'v1' | 'v3'; env: Env }> {
    const modeSetting = await deps.settings.get('daraja.environment');
    const env: Env = modeSetting === 'production' ? 'production' : 'sandbox';
    const s = await deps.settings.getMany([`env.${env}.b2cApi`, `env.${env}.b2cApiDetected`]);
    const rawSetting = s[`env.${env}.b2cApi`];
    const setting: 'auto' | 'v1' | 'v3' = rawSetting === 'v1' || rawSetting === 'v3' ? rawSetting : 'auto';
    const detected = s[`env.${env}.b2cApiDetected`];
    const version: 'v1' | 'v3' = setting !== 'auto' ? setting : (detected === 'v1' || detected === 'v3' ? detected : 'v3');
    return { version, setting, env };
  }

  /** Remembers which version actually works, once — a no-op once the same version is already
   * recorded, so `detectedAt` does not keep moving on every later send. */
  async function recordB2cDetection(env: Env, version: 'v1' | 'v3'): Promise<void> {
    const current = await deps.settings.get(`env.${env}.b2cApiDetected`);
    if (current === version) return;
    await deps.settings.set(`env.${env}.b2cApiDetected`, version);
    await deps.settings.set(`env.${env}.b2cApiDetectedAt`, new Date().toISOString());
  }

  /** The operator row id behind a built client, or null when no operator is attached at all. */
  async function operatorIdFor(client: Daraja): Promise<string | null> {
    return (await deps.db.query<{ id: string }>(`SELECT id FROM operators WHERE name=$1`, [client.config?.initiator ?? '']))[0]?.id ?? null;
  }

  /**
   * Brief 2, item 7. The next verified operator that has not already refused this request, with its
   * client. Null means nobody is left to try, which is where the row fails for real.
   */
  async function nextOperator(exclude: string[]): Promise<{ id: string; client: Daraja } | null> {
    let client: Daraja;
    try {
      client = await deps.daraja.getForOperator(undefined, { exclude });
    } catch (e) {
      if (e instanceof HttpError && e.code === 'no_operator') return null;
      throw e;
    }
    const id = await operatorIdFor(client);
    if (!id || exclude.includes(id)) return null;
    // The pick ran a moment ago; a concurrent refusal may have taken this operator down since. The
    // exclude check is repeated here so the rule holds even if a picker ever ignores the option: an
    // operator that already refused this request must never be handed it again.
    const [row] = await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [id]);
    return row?.status === 'verified' ? { id, client } : null;
  }

  /**
   * Move a row that is still in flight to another operator. Only the wire identifiers change: the
   * row keeps its id, its links and its author, so the next result settles it exactly as a first
   * attempt would. The refused attempt's ack id is dropped, so a redelivered callback for that
   * attempt can never land on this row again, and last_poll_at is set so the sweep does not poll the
   * row in the seconds between here and the new ack.
   *
   * Deliberately never writes a final status on the way: the requests table refuses to rewrite a
   * final row, and it is right to, so a request that is about to be tried again is simply never
   * declared dead.
   */
  async function moveRow(rowId: string, operatorId: string): Promise<RequestRow | null> {
    const rows = await deps.db.query<RequestRow>(
      `UPDATE requests SET operator_id=$2, originator_conversation_id=$3, poll_attempts=0, last_poll_at=now(),
              payload_json = payload_json - 'ackOriginatorConversationId'
        WHERE id=$1 AND status='pending' RETURNING *`,
      [rowId, operatorId, randomUUID()]);
    return rows[0] ?? null;
  }

  /**
   * One attempt: the Safaricom call behind the operator's one in-flight slot, the ack, and every way
   * it can go wrong. Returns the credential-class code when that is what Safaricom said, which is
   * the caller's signal that the same row may be sent again with another operator. The event is
   * published by dispatch(), once, with the status the request actually ended on.
   */
  async function attempt(kind: RequestKind, row: RequestRow, client: Daraja, cb: CallbackUrls, operatorId: string | null, tried: string[]): Promise<{ status: string; refused: string | null; next: { id: string; client: Daraja; row: RequestRow } | null }> {
      const { version: initialVersion, setting: b2cApiSetting, env: b2cApiEnv } = await resolveB2cVersion();
      let versionUsed: 'v1' | 'v3' = initialVersion;
      let refused: string | null = null;
      let status: string;
      // Taken last, so the slot can never be held by a call that failed before it reached Safaricom.
      const ticket = await lock.acquire(operatorId);
      try {
        let ack: { conversationId: string; originatorConversationId: string; responseCode: string; responseDescription: string };
        try {
          ack = await kind.send(client, row, cb, { b2cVersion: versionUsed });
        } catch (e) {
          // B0: only a kind that actually has two live API versions may negotiate between them.
          // The SDK's pochi, b2b and reversal calls take no version option at all, so without this
          // guard a gateway refusal would retry a kind that has nothing to retry with.
          if (kind.versionFallback === true && versionUsed === 'v3' && b2cApiSetting === 'auto' && isV3GatewayRefusal(e)) {
            // Safety: an HTTP 403 with 403.002.1001 is the API gateway itself refusing the
            // request — it happens before Safaricom's core ever validates or queues it, so there
            // is no ConversationID, no ack, nothing for Safaricom to have received. Retrying the
            // SAME row on v1 cannot cause a double payment. (isV3GatewayRefusal also refuses to
            // fire once an ack already exists, which cannot happen here anyway since this catch
            // only runs when kind.send itself threw, AND requires the HTTP status to be exactly
            // 403 — a 5xx carrying this same error code is not this guarantee and falls through
            // to `maybeQueued` below instead, exactly like any other 5xx.)
            console.warn('b2c v3 refused by gateway, retried on v1', row.id);
            versionUsed = 'v1';
            ack = await kind.send(client, row, cb, { b2cVersion: versionUsed });
          } else {
            throw e;
          }
        }
        if (ack.responseCode !== '0') throw new DarajaAPIError(ack.responseDescription, { resultCode: Number(ack.responseCode), resultDesc: ack.responseDescription, scope: kind.scope });
        const payloadPatch: Record<string, unknown> = kind.versionFallback === true ? { b2cApiUsed: versionUsed } : {};
        if (ack.originatorConversationId && ack.originatorConversationId !== row.originator_conversation_id) payloadPatch.ackOriginatorConversationId = ack.originatorConversationId;
        await deps.db.query(
          `UPDATE requests SET status='sent', conversation_id=$2, sent_at=now(), payload_json = payload_json || $3::jsonb WHERE id=$1 AND status='pending'`,
          [row.id, ack.conversationId, JSON.stringify(payloadPatch)]);
        if (b2cApiSetting === 'auto') {
          if (versionUsed === 'v1' && initialVersion === 'v3') {
            // The fallback just fired for the first time under this setting — remember it, and
            // tell whoever is watching Home/Settings that Studio worked this out on its own.
            await recordB2cDetection(b2cApiEnv, 'v1');
            await deps.events.publish('alert', { kind: 'b2c_api_detected', version: 'v1' });
          } else if (versionUsed === 'v3') {
            await recordB2cDetection(b2cApiEnv, 'v3');
          }
        }
        status = 'sent';
      } catch (e) {
        const httpStatus = e instanceof DarajaAPIError ? (e as { httpStatus?: unknown }).httpStatus : undefined;
        const maybeQueued = e instanceof DarajaConnectionError
          || (e instanceof DarajaAPIError && typeof httpStatus === 'number' && httpStatus >= 500)
          || (e instanceof DarajaAPIError && e.message.includes(DUPLICATE_ID));
        const b2cApiUsed = JSON.stringify(kind.versionFallback === true ? { b2cApiUsed: versionUsed } : {});
        if (maybeQueued) {
          // The request may already have reached Safaricom (connection error, a 5xx that could
          // mean it queued the payment before failing, or Safaricom saying the id already
          // exists) — in every case the sweep resolves it, not us.
          await deps.db.query(`UPDATE requests SET status='unknown', sent_at=now(), meaning=$2, payload_json = payload_json || $3::jsonb WHERE id=$1 AND status='pending'`, [row.id, UNCONFIRMED, b2cApiUsed]);
          status = 'unknown';
        } else if (e instanceof DarajaAuthError) {
          // Safaricom rejected the OAuth credential itself (bad/expired key+secret), before the
          // request even reached the money APIs — nothing was queued, and the operator (which
          // authenticates B2C/status, a separate credential from the app's OAuth pair) is fine.
          await deps.db.query(
            `UPDATE requests SET status='failed', result_at=now(), result_code=NULL, result_desc=$2, meaning=$3, retriable=false, payload_json = payload_json || $4::jsonb WHERE id=$1 AND status='pending'`,
            [row.id, e.message, AUTH_FAILED_MEANING, b2cApiUsed]);
          status = 'failed';
        } else if (e instanceof DarajaAPIError) {
          const { code, desc } = syncRejection(e);
          const ex = code !== null ? explain(kind.scope, code, desc, { b2cApiUsed: versionUsed }) : null;
          // Brief 2, item 7: a credential-class refusal is Safaricom turning the request down
          // outright. When another verified operator is attached, this row is not failed at all: it
          // is moved to that operator and sent again, so nothing final is ever written on the way.
          if (code !== null && await recordOperatorRefusal(deps.db, deps.events, operatorId, code, desc)) {
            const next = await nextOperator([...tried, ...(operatorId ? [operatorId] : [])]);
            const moved = next ? await moveRow(row.id, next.id) : null;
            if (next && moved) { refused = code; return { status: 'pending', refused, next: { id: next.id, client: next.client, row: moved } }; }
          }
          await deps.db.query(
            `UPDATE requests SET status='failed', result_at=now(), result_code=$2, result_desc=$3, meaning=$4, retriable=$5, payload_json = payload_json || $6::jsonb WHERE id=$1 AND status='pending'`,
            [row.id, code, desc, ex?.meaning ?? desc, ex?.retriable ?? false, b2cApiUsed]);
          status = 'failed';
        } else {
          await deps.db.query(`UPDATE requests SET status='failed', result_at=now(), result_desc=$2, meaning=$3, payload_json = payload_json || $4::jsonb WHERE id=$1 AND status='pending'`, [row.id, 'Studio could not send the request.', 'Something went wrong on our side before Safaricom was reached.', b2cApiUsed]);
          console.error('send failed before Safaricom', row.id, e instanceof Error ? e.name : 'error');
          status = 'failed';
        }
      } finally {
        // The slot goes back the instant Safaricom has answered, ack or refusal: what the next send
        // waits for is this call, never the result callback minutes later.
        await lock.release(operatorId, ticket);
      }
      return { status, refused, next: null };
  }

  /**
   * Everything after the row exists: the Safaricom call, the ack, and every way it can go wrong.
   * Shared by send() and release() (M4) so a released send takes exactly the path a direct one does.
   *
   * Brief 2, item 7: when a refusal is credential-class and another verified operator is attached,
   * the same row goes out again with that operator instead of failing. Safe because those codes mean
   * Safaricom rejected the request outright — no money moved, so the second attempt cannot be a
   * duplicate payment. The row keeps its id and its links; the next result settles it as a first
   * attempt would.
   */
  async function dispatch(kind: RequestKind, row: RequestRow, client: Daraja, cb: CallbackUrls, operatorId: string | null, tried: string[] = operatorId ? [operatorId] : []): Promise<RequestView> {
    let useClient = client;
    let useOperatorId = operatorId;
    let useRow = row;
    for (;;) {
      const outcome = await attempt(kind, useRow, useClient, cb, useOperatorId, tried);
      if (!outcome.next) {
        await deps.events.publish('request.updated', { id: useRow.id, status: outcome.status });
        return view(useRow.id);
      }
      console.warn('credential refusal, sent again with the next operator', useRow.id, outcome.refused, outcome.next.id);
      tried.push(outcome.next.id);
      useRow = outcome.next.row; useClient = outcome.next.client; useOperatorId = outcome.next.id;
    }
  }

  function checkCap(amountCents: number): void {
    if (deps.config.maxSendCents !== null && amountCents > deps.config.maxSendCents) {
      const cap = deps.config.maxSendCents;
      throw new HttpError(409, 'over_cap', `This studio is capped at KES ${cap % 100 === 0 ? cap / 100 : (cap / 100).toFixed(2)} per send.`, { capCents: cap });
    }
  }

  /** Feature 2: a business that is gone, another organisation's, or switched off is refused here,
   * before anything is written. Answers the business's id. */
  async function checkBusiness(businessId: string): Promise<string> {
    const [business] = await deps.db.query<{ id: string; active: boolean }>(
      `SELECT id, active FROM businesses WHERE id=$1 AND org_id=$2`, [businessId, requireOrg()]);
    if (!business) throw new HttpError(400, 'unknown_business', 'That business does not exist. Pick one from the list.');
    if (!business.active) throw new HttpError(409, 'business_inactive', 'That business is switched off. Switch it on to send under it.');
    return business.id;
  }

  /**
   * Everything a send does once its inputs are checked, whichever kind it is: the operator, the
   * duplicate guard, the pending row and its audit entry, the approval hold, then dispatch. A phone
   * send and a business payment take exactly this path, so the rules around money out apply to
   * both without being written twice.
   */
  async function createAndDispatch(n: NewSend, actor: Actor): Promise<RequestView> {
    const { kind } = n;
    const cb = await urls();
    // Operator first: a 409 here writes nothing. Then the pending row and its audit entry, in
    // one transaction so a failing audit write never strands a row with no audit trail. The
    // request exists before Safaricom hears of it (a crash between the ack and our update
    // below leaves a visible row) — once the SDK sends our own OriginatorConversationID
    // (1.5.0), the sweep resolves such a row by it; meanwhile the ack's own id is kept
    // on the row so a human can still find it on the Safaricom side.
    const client = await deps.daraja.getForOperator();
    const operatorId = await operatorIdFor(client);
    // The account number a paybill payment quotes is part of what makes two payments the same
    // one. A phone send has none, and '' on both sides compares equal, so it reads as before.
    const accountReference = typeof n.payload.accountReference === 'string' ? n.payload.accountReference : '';
    // W3: the duplicate guard used to be a plain SELECT outside any transaction, so two
    // concurrent identical sends could both see no prior row and both insert. The advisory
    // lock below is taken first, inside the same transaction as the guard SELECT and the
    // INSERT, keyed on exactly what the guard matches on — a second call for the same
    // recipient/amount/type blocks here until the first call's transaction commits (or rolls
    // back), then runs its own guard SELECT and correctly finds the first call's row. The lock
    // is transaction-scoped, so it releases automatically at commit, before the SDK is called.
    const row = await deps.db.tx(async (c) => {
      // B0: the lock key and the guard's own comparison come from the kind, so the two can never
      // disagree about what "the same request" means. `IS NOT DISTINCT FROM` rather than `=`
      // because a kind with no recipient (a float transfer moves money between the organisation's
      // own two accounts) stores NULL there, and SQL equality against NULL is never true — such a
      // kind would otherwise have no duplicate protection at all while appearing to have it.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [kind.dupKey({ type: kind.type, recipient_value: n.recipientValue, amount_cents: String(n.amountCents), payload_json: n.payload })]);
      if (!n.confirmDuplicate) {
        const dup = await c.query<{ id: string; created_at: Date }>(
          `SELECT id, created_at FROM requests WHERE type=$1 AND recipient_value IS NOT DISTINCT FROM $2 AND amount_cents=$3
             AND COALESCE(payload_json->>'accountReference','') = $4
             AND created_at > now() - ${DUP_WINDOW} AND status NOT IN ('failed','cancelled','rejected') ORDER BY created_at DESC LIMIT 1`,
          [kind.type, n.recipientValue, n.amountCents, accountReference]);
        if (dup.rows[0]) throw new HttpError(409, 'duplicate_recent', 'You sent this already. Send it again?', { requestId: dup.rows[0].id, at: dup.rows[0].created_at.toISOString() });
      }
      const { rows } = await c.query<RequestRow>(
        `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, recipient_name, remarks, payload_json, created_by, operator_id, bulk_plan_id, contact_id, business_id, account_id, charge_cents)
         VALUES ($1,$2,$3,'pending',$4,'KES',$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [kind.type, n.subtype, randomUUID(), n.amountCents, n.recipientKind, n.recipientValue, n.recipientName, n.remarks, JSON.stringify(n.payload), actor.personId, operatorId, n.bulkPlanId, n.contactId, n.businessId, n.accountId, n.chargeCents]);
      const r = rows[0];
      await c.query(
        `INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
        [actor.personId, 'request.created', r.id, null, JSON.stringify({ type: kind.type, subtype: n.subtype, ...n.audit, amountCents: n.amountCents }), actor.ip]);
      return r;
    });

    // Feature 2: the pickers default to the last business used. A failure to remember it never
    // fails the send — the row is written and the money is about to move either way.
    if (n.businessId) await deps.settings.set('send.lastBusinessId', n.businessId).catch(() => {});

    // M4: at or above the owner's threshold the row waits for a second person. The operator was
    // still required above (a studio with none refuses before writing anything), but the held
    // row drops it and picks one at release, so a rotation in between cannot strand it.
    const threshold = Number((await deps.settings.get('send.approvalThresholdCents')) ?? 0) || 0;
    if (threshold > 0 && n.amountCents >= threshold) {
      await deps.db.query(`UPDATE requests SET status='awaiting_approval', operator_id=NULL WHERE id=$1 AND status='pending'`, [row.id]);
      await audit(deps.db, { personId: actor.personId, action: 'request.held', target: row.id, ip: actor.ip });
      await deps.events.publish('request.updated', { id: row.id, status: 'awaiting_approval' });
      return view(row.id);
    }
    return dispatch(kind, row, client, cb, operatorId);
  }

  return {
    async nameCheck(input) {
      let phone: string;
      try { phone = normalizePhone(input); } catch { throw new HttpError(400, 'bad_phone', 'Enter a Kenyan mobile number such as 0712 345 678.'); }
      // Phase D-4: a payout Safaricom accepted counts as having paid this number — sent, paid, or
      // one whose answer never came. One that failed paid nobody, and a pending row that never
      // left Studio paid nobody either, so neither counts: the warning errs towards being shown.
      const paid = await deps.db.query(
        `SELECT 1 FROM requests WHERE type = $1 AND recipient_value = $2 AND status IN ('sent','completed','unknown') LIMIT 1`,
        [KINDS.b2c.type, phone],
      );
      const paidBefore = paid.length > 0;
      // Read-only and not tied to an operator: the app's own key is enough.
      const client = await deps.daraja.get();
      try {
        const r = await client.hakikisha.lookup({ phone });
        return { available: true, name: r.displayName, paidBefore };
      } catch (e) {
        // 401 here means the product is not on the app or not approved for the shortcode: the
        // same key just worked for everything else the review needed.
        if (e instanceof DarajaAuthError) return { available: false, reason: 'not_enabled', said: null, paidBefore };
        if (e instanceof DarajaAPIError) {
          // Safaricom's "does not exist" arrives either as an HTTP 400 whose body carries
          // `body.message`, or as a 200 with `header.status` 400 (already turned into the message).
          const body = (e.raw as { body?: { message?: unknown } } | undefined)?.body;
          const said = typeof body?.message === 'string' ? body.message : e.message;
          const notFound = /not exist|not found|invalid phone/i.test(said) || /HTTP 400/.test(e.message);
          return { available: false, reason: notFound ? 'not_found' : 'unavailable', said, paidBefore };
        }
        return { available: false, reason: 'unavailable', said: null, paidBefore };
      }
    },
    async businessCheck(to, input) {
      const shortcode = input.trim();
      if (!/^[0-9]{5,7}$/.test(shortcode)) throw new HttpError(400, 'bad_shortcode', to === 'till' ? 'A till number is 5 to 7 digits.' : 'A paybill number is 5 to 7 digits.');
      const paid = await deps.db.query(
        `SELECT 1 FROM requests WHERE type = $1 AND recipient_kind = $2 AND recipient_value = $3 AND status IN ('sent','completed','unknown') LIMIT 1`,
        [KINDS.b2b.type, to, shortcode]);
      const paidBefore = paid.length > 0;
      // Read-only: the app's own key is enough, the same as the setup check of the studio's own number.
      try {
        const client = await deps.daraja.get();
        const r = await client.orgInfo.query({ identifier: shortcode, identifierType: to });
        if (r.success && r.organizationName) return { available: true, name: r.organizationName, paidBefore };
        return { available: false, reason: 'not_found', paidBefore };
      } catch {
        return { available: false, reason: 'unavailable', paidBefore };
      }
    },

    async send(input, actor) {
      const kind = KINDS.b2c;
      let phone: string;
      try { phone = normalizePhone(input.phone); } catch { throw new HttpError(400, 'bad_phone', 'Enter a Kenyan mobile number such as 0712 345 678.'); }
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(400, 'bad_amount', 'Enter an amount in shillings.');
      if (kind.wholeShillings && input.amountCents % 100 !== 0) throw new HttpError(400, 'whole_shillings', 'Safaricom sends whole shillings to phones. Remove the cents.');
      // A category is the business's own label; the Safaricom command underneath it is what is sent.
      let commandId = input.commandId; let category: string | null = null;
      if (input.category) {
        const found = parseCategories(await deps.settings.get('send.categories')).find((c) => c.name.toLowerCase() === input.category!.trim().toLowerCase());
        if (!found) throw new HttpError(400, 'unknown_category', 'That payment category no longer exists. Pick one from the list.');
        commandId = found.commandId; category = found.name;
      }
      checkCap(input.amountCents);
      // Feature 1: a send may name a saved contact. The row stores it so History can show the name
      // the owner gave this person; the phone above is still the destination, so a contact whose
      // saved number no longer matches the number being dialled is refused rather than guessed at.
      // Both checks run before anything is written, so a refusal leaves no request row behind.
      let savedContactId: string | null = null;
      let savedContactName: string | null = null;
      if (input.contactId) {
        const [contact] = await deps.db.query<{ id: string; phone: string | null; name: string }>(
          `SELECT id, phone, name FROM contacts WHERE id=$1 AND org_id=$2 AND kind='phone' AND deleted_at IS NULL`,
          [input.contactId, requireOrg()]);
        if (!contact || !contact.phone) throw new HttpError(400, 'unknown_contact', 'That saved contact is gone. Pick them again.');
        let savedPhone: string | null;
        try { savedPhone = normalizePhone(contact.phone); } catch { savedPhone = null; }
        if (savedPhone !== phone) throw new HttpError(400, 'contact_mismatch', 'That number is not the one saved for this contact. Pick the contact again, or send without it.');
        savedContactId = contact.id;
        savedContactName = contact.name;
      }
      // Feature 2: the business this send belongs to is the operator's own choice (B2C has no
      // account number to read it from). A business that is gone, another organisation's, or
      // switched off is refused here, before anything is written.
      let savedBusinessId: string | null = input.businessId ? await checkBusiness(input.businessId) : null;
      // Brief 2, item 1: an account may be named instead of a business. The account carries its own
      // business, so naming one sets both, and a retired account or one in another organisation is
      // refused here, before anything is written.
      let savedAccountId: string | null = null;
      let savedAccountName: string | null = null;
      if (input.accountId) {
        const account = await resolveAccount(deps.db, input.accountId, savedBusinessId);
        if (!savedBusinessId) {
          const [biz] = await deps.db.query<{ active: boolean }>(`SELECT active FROM businesses WHERE id=$1`, [account.businessId]);
          if (biz && !biz.active) throw new HttpError(409, 'business_inactive', 'That business is switched off. Switch it on to send under it.');
        }
        savedAccountId = account.id;
        savedBusinessId = account.businessId;
        savedAccountName = account.holderName;
      }
      // Feature 11: what Safaricom will charge for this send, from the organisation's own bands.
      // Read before anything is written, and stored on the row: a later tariff change never
      // rewrites what an old payment cost. An amount with no band stores nothing rather than a
      // zero, which would read as free.
      const chargeCents = await fees.chargeFor('b2c', input.amountCents);
      // Phase A: the best name Studio knows at this moment goes on the row, so Waiting and History
      // show a person while Safaricom is still thinking. The owner's own label for the number comes
      // first (it is the one checked against the number above), then the person behind the account
      // the money is for, then the name the review screen confirmed with Safaricom. Safaricom's own
      // result name replaces it when the callback arrives, and the contact's label stays beside it.
      return createAndDispatch({
        kind, subtype: commandId, amountCents: input.amountCents, recipientKind: 'phone', recipientValue: phone,
        recipientName: savedContactName ?? savedAccountName ?? personName(input.recipientName), remarks: input.remarks ?? null,
        payload: { occasion: input.occasion ?? null, category, ...(input.bulk ? { bulkIndex: input.bulk.index } : {}) },
        audit: { category }, contactId: savedContactId, businessId: savedBusinessId, accountId: savedAccountId,
        chargeCents, bulkPlanId: input.bulk?.planId ?? null, confirmDuplicate: input.confirmDuplicate === true,
      }, actor);
    },

    async payBusiness(input, actor) {
      const kind = KINDS.b2b;
      const shortcode = input.shortcode.trim();
      if (!/^[0-9]{5,7}$/.test(shortcode)) throw new HttpError(400, 'bad_shortcode', input.to === 'till' ? 'A till number is 5 to 7 digits.' : 'A paybill number is 5 to 7 digits.');
      const accountReference = input.to === 'paybill' ? (input.accountReference?.trim() || null) : null;
      if (input.to === 'till' && input.accountReference?.trim()) throw new HttpError(400, 'till_no_account', 'A till takes no account number. Leave it empty.');
      if (accountReference !== null && !/^[A-Za-z0-9]{1,20}$/.test(accountReference)) throw new HttpError(400, 'bad_account', 'The account number is up to 20 letters and numbers.');
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(400, 'bad_amount', 'Enter an amount in shillings.');
      if (input.amountCents % 100 !== 0) throw new HttpError(400, 'whole_shillings', 'Safaricom pays businesses in whole shillings. Remove the cents.');
      checkCap(input.amountCents);
      // A saved contact must be this very destination: the number, the kind, and for a paybill the
      // account. Anything else is refused rather than guessed at, before anything is written.
      let savedContactId: string | null = null;
      let savedContactName: string | null = null;
      if (input.contactId) {
        const [contact] = await deps.db.query<{ id: string; kind: string; shortcode: string | null; account_reference: string | null; name: string }>(
          `SELECT id, kind, shortcode, account_reference, name FROM contacts WHERE id=$1 AND org_id=$2 AND kind IN ('till','paybill') AND deleted_at IS NULL`,
          [input.contactId, requireOrg()]);
        if (!contact) throw new HttpError(400, 'unknown_contact', 'That saved contact is gone. Pick them again.');
        if (contact.kind !== input.to || contact.shortcode !== shortcode || (input.to === 'paybill' && (contact.account_reference ?? null) !== accountReference)) {
          throw new HttpError(400, 'contact_mismatch', 'That number is not the one saved for this contact. Pick the contact again, or pay without it.');
        }
        savedContactId = contact.id;
        savedContactName = contact.name;
      }
      const savedBusinessId = input.businessId ? await checkBusiness(input.businessId) : null;
      const chargeCents = await fees.chargeFor('b2b', input.amountCents);
      const subtype = input.to === 'till' ? 'BusinessBuyGoods' : 'BusinessPayBill';
      return createAndDispatch({
        kind, subtype, amountCents: input.amountCents, recipientKind: input.to, recipientValue: shortcode,
        recipientName: savedContactName ?? personName(input.recipientName), remarks: input.remarks ?? null,
        payload: { accountReference },
        audit: { accountReference }, contactId: savedContactId, businessId: savedBusinessId, accountId: null,
        chargeCents, bulkPlanId: null, confirmDuplicate: input.confirmDuplicate === true,
      }, actor);
    },

    async release(requestId, actor) {
      const [held] = await deps.db.query<RequestRow>(`SELECT * FROM requests WHERE id=$1`, [requestId]);
      if (!held) throw new HttpError(404, 'not_found', 'That request does not exist.');
      if (held.status !== 'awaiting_approval') throw new HttpError(409, 'not_held', NOT_HELD);
      if (held.created_by === actor.personId) throw new HttpError(403, 'own_request', OWN_REQUEST);
      const kind = KINDS[held.type];
      if (!kind) throw new HttpError(409, 'not_held', NOT_HELD);
      const cb = await urls();
      const client = await deps.daraja.getForOperator();
      const operatorId = await operatorIdFor(client);
      // The atomic flip is the double-press guard: a second Release finds no held row and stops.
      const [row] = await deps.db.query<RequestRow>(
        `UPDATE requests SET status='pending', approved_by=$2, operator_id=$3 WHERE id=$1 AND status='awaiting_approval' RETURNING *`, [requestId, actor.personId, operatorId]);
      if (!row) throw new HttpError(409, 'not_held', NOT_HELD);
      await audit(deps.db, { personId: actor.personId, action: 'request.released', target: requestId, ip: actor.ip });
      return dispatch(kind, row, client, cb, operatorId);
    },

    // Brief 2, item 7: the half a caller needs when it caught the refusal itself (the reversal
    // path) or when the result callback already put the row back in flight. The row is still
    // pending; this picks the next verified operator, moves the row onto it and sends.
    async failover(requestId, failedOperatorId) {
      const [row] = await deps.db.query<RequestRow>(`SELECT * FROM requests WHERE id=$1 AND status='pending'`, [requestId]);
      if (!row) return false;
      const kind = KINDS[row.type];
      if (!kind) return false;
      const tried = failedOperatorId ? [failedOperatorId] : [];
      const next = await nextOperator(tried);
      if (!next) return false;
      const moved = await moveRow(requestId, next.id);
      if (!moved) return false;
      tried.push(next.id);
      console.warn('credential refusal, sent again with the next operator', requestId, next.id);
      await dispatch(kind, moved, next.client, await urls(), next.id, tried);
      return true;
    },

    async refuse(requestId, reason, actor) {
      const [held] = await deps.db.query<{ created_by: string | null; status: string }>(`SELECT created_by, status FROM requests WHERE id=$1`, [requestId]);
      if (!held) throw new HttpError(404, 'not_found', 'That request does not exist.');
      if (held.status !== 'awaiting_approval') throw new HttpError(409, 'not_held', NOT_HELD);
      if (held.created_by === actor.personId) throw new HttpError(403, 'own_request', OWN_REQUEST);
      const [row] = await deps.db.query<{ id: string }>(
        `UPDATE requests SET status='rejected', approved_by=$2, result_at=now(), result_desc=$3, meaning=$3 WHERE id=$1 AND status='awaiting_approval' RETURNING id`, [requestId, actor.personId, reason]);
      if (!row) throw new HttpError(409, 'not_held', NOT_HELD);
      await audit(deps.db, { personId: actor.personId, action: 'request.refused', target: requestId, after: { reason }, ip: actor.ip });
      await deps.events.publish('request.updated', { id: requestId, status: 'rejected' });
      return view(requestId);
    },

    async listAwaiting() { return listRequests(deps.db, { status: 'awaiting_approval', limit: 100 }, deps.config.egressIps); },

    async listWaiting(canDecide) { return listWaiting(deps.db, { canDecide, egressIps: deps.config.egressIps }); },

    async waitingBadge() { return waitingBadge(deps.db); },

    async expireApprovals() {
      const rows = await deps.db.query<{ id: string }>(
        `UPDATE requests SET status='rejected', result_at=now(), result_desc=$1, meaning=$1 WHERE status='awaiting_approval' AND created_at < now() - interval '24 hours' RETURNING id`, [APPROVAL_EXPIRED]);
      for (const r of rows) await deps.events.publish('request.updated', { id: r.id, status: 'rejected' });
      return rows.length;
    },

    async sweep() {
      const orgId = requireOrg();
      // Covers 'sent', 'pending' (a crash between Safaricom's ack and our own 'sent' UPDATE —
      // its payment may already have left) and 'unknown' (send()'s maybe-queued path, I1 — the
      // exact case the sweep exists for). A row a human has already Marked as checked
      // (checked_at set) is left alone. A pending row has no sent_at, hence
      // COALESCE(sent_at, created_at) for its age; the expiry guard's `result_at IS NULL` makes
      // it fire once even for a row that started 'unknown' with no prior result_at.
      const expired = await deps.db.query<{ id: string }>(
        `UPDATE requests SET status='unknown', result_at=now(), meaning=$2
         WHERE type = ANY($1) AND status IN ('sent','pending','unknown') AND poll_attempts >= $3
           AND last_poll_at < now() - interval '2 minutes' AND result_at IS NULL AND checked_at IS NULL
           AND org_id = $4 RETURNING id`,
        [MONEY_TYPES, NO_ANSWER_AFTER_POLLS, MAX_POLLS, orgId]);
      for (const row of expired) {
        await deps.events.publish('alert', { kind: 'request_unknown', id: row.id });
        await deps.events.publish('request.updated', { id: row.id, status: 'unknown' });
      }
      const due = await deps.db.query<{ id: string; originator_conversation_id: string }>(
        `SELECT id, ${SAFARICOM_OCID} AS originator_conversation_id FROM requests
         WHERE type = ANY($1) AND status IN ('sent','pending','unknown') AND checked_at IS NULL
           AND COALESCE(sent_at, created_at) < now() - interval '2 minutes'
           AND poll_attempts < $2 AND (last_poll_at IS NULL OR last_poll_at < now() - interval '2 minutes')
           AND org_id = $3
         ORDER BY COALESCE(sent_at, created_at) ASC LIMIT 10`, [MONEY_TYPES, MAX_POLLS, orgId]);
      if (due.length === 0) return { polled: 0, expired: expired.length };
      const client = await clientOrNull();
      if (!client) { console.error('sweep skipped: no verified operator'); return { polled: 0, expired: expired.length }; }
      const cb = await urls();
      let polled = 0;
      for (const t of due) { if ((await pollTarget(client, cb, t, 'sweep')).ok) polled++; }
      return { polled, expired: expired.length };
    },

    async pollOne(requestId, actor) {
      const orgId = requireOrg();
      const [t] = await deps.db.query<{ id: string; originator_conversation_id: string; status: string; poll_attempts: number; type: string; last_poll_at: Date | null }>(
        `SELECT id, ${SAFARICOM_OCID} AS originator_conversation_id, status, poll_attempts, type, last_poll_at FROM requests WHERE id=$1 AND org_id=$2`, [requestId, orgId]);
      if (!t || !MONEY_TYPES.includes(t.type)) throw new HttpError(404, 'not_found', 'That request does not exist.');
      if (t.status !== 'sent' && t.status !== 'pending' && t.status !== 'unknown') throw new HttpError(409, 'not_pending', 'This request already has its result.');
      // A cooldown, not only the step-up the guard stack already lacks: without it, an
      // operator holding only `send.phone` could burn the whole 5-poll budget in a burst and hit
      // Safaricom's status API on every click, mirroring the sweep's own 2-minute pacing.
      if (t.last_poll_at && t.last_poll_at.getTime() > Date.now() - 2 * 60_000) {
        throw new HttpError(409, 'poll_too_soon', 'Studio asked Safaricom less than two minutes ago. Wait for that answer first.');
      }
      if (t.poll_attempts >= MAX_POLLS) throw new HttpError(409, 'poll_cap', 'Studio has already asked Safaricom 5 times. Check the Safaricom portal, then Mark as checked.');
      const client = await deps.daraja.getForOperator();
      const outcome = await pollTarget(client, await urls(), t, 'manual', actor?.personId ?? null);
      if (!outcome.ok) {
        if (outcome.reason === 'sdk_rejected') throw new HttpError(502, 'status_query_rejected', 'Safaricom did not accept the check. Try again in a moment.');
        throw new HttpError(500, 'status_query_not_recorded', 'Studio could not record the check. Try again.');
      }
      return { queryId: outcome.queryId };
    },

    async markChecked(requestId, note, actor) {
      // A single atomic UPDATE, gated on the same conditions pollOne uses for what counts as a
      // money request: the `old` CTE runs against the pre-update row, so `old.checked_note`
      // is the previous note even though the UPDATE it feeds has already overwritten the column
      // — no separate read-then-write race window. The status/type guard is repeated on the
      // UPDATE's own qualification, not only the CTE: under READ COMMITTED, Postgres
      // re-checks only the UPDATE's own qual against the latest row version before writing, so a
      // row finalised by a concurrent callback between the CTE's snapshot and the UPDATE's lock
      // must still fail the write, not only miss the CTE.
      const rows = await deps.db.query<{ id: string; previous_note: string | null }>(
        `WITH old AS (
           SELECT id, checked_note FROM requests WHERE id=$1 AND status='unknown' AND type = ANY($4)
         )
         UPDATE requests r SET checked_by=$2, checked_at=now(), checked_note=$3
         FROM old WHERE r.id = old.id AND r.status='unknown' AND r.type = ANY($4)
         RETURNING r.id, old.checked_note AS previous_note`,
        [requestId, actor.personId, note, MONEY_TYPES]);
      if (!rows[0]) {
        const exists = await deps.db.query('SELECT 1 FROM requests WHERE id=$1', [requestId]);
        throw exists[0] ? new HttpError(409, 'not_unknown', 'Only a request with an unknown result can be marked as checked.') : new HttpError(404, 'not_found', 'That request does not exist.');
      }
      await audit(deps.db, { personId: actor.personId, action: 'request.checked', target: requestId, ip: actor.ip, before: { note: rows[0].previous_note }, after: { note } });
      await deps.events.publish('request.updated', { id: requestId, status: 'unknown' });
      return view(requestId);
    },

    async refreshBalance(actor) {
      // Defence in depth: the HTTP route already runs `requireMoneyReady` (which checks this),
      // but the daily job calls this function directly with no HTTP layer in front of it — this
      // guard is what actually stops it from reaching Safaricom before the address is proven
      // reachable.
      if (!(await deps.settings.get('public.verifiedAt'))) throw new HttpError(409, 'public_url_unverified', PUBLIC_URL_UNVERIFIED);
      const inFlight = await deps.db.query(`SELECT 1 FROM requests WHERE type='balance' AND subtype='refresh' AND status='sent' AND sent_at > now() - interval '5 minutes' LIMIT 1`);
      if (inFlight[0]) throw new HttpError(409, 'refresh_in_flight', 'A balance check is already on its way. Give it a few minutes.');
      const client = await deps.daraja.getForOperator();
      const cb = await urls();
      const operatorId = await operatorIdFor(client);
      let ack: { conversationId: string; originatorConversationId: string };
      try {
        ack = await client.balance.query({ resultUrl: cb.balance, queueTimeoutUrl: cb.balance, remarks: 'studio balance' });
      } catch (e) { throw sdkCallError(e, 'balance', deps.config.egressIps); }
      // Kept as the balance callback's own match key (Phase 1's balanceHandler matches on it) —
      // but Safaricom's ack can come back with an empty id, and the column is UNIQUE NOT NULL,
      // so an empty ack id falls back to a studio uuid rather than ever risking a collision.
      const ocid = ack.originatorConversationId || randomUUID();
      const [row] = await deps.db.query<{ id: string }>(
        `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, operator_id, sent_at, created_by, payload_json)
         VALUES ('balance','refresh',$1,$2,'sent',$3,now(),$4,'{}'::jsonb) RETURNING id`, [ocid, ack.conversationId || null, operatorId, actor?.personId ?? null]);
      await enqueue(deps.db, 'request_timeout', { requestId: row.id }, { runAt: new Date(Date.now() + 5 * 60_000), maxAttempts: 3 });
      await audit(deps.db, { personId: actor?.personId ?? null, action: 'balance.refreshed', target: row.id, ip: actor?.ip });
      return { requestId: row.id };
    },

    async lookup(receipt, actor, opts) {
      // Read-only permission (`lookup.view`), no cooldown at the route — this is the only thing
      // stopping a repeat click for the same receipt from hitting Safaricom's Transaction Status
      // API on every request. A fresh receipt, or the same one after the window, is always
      // allowed: each still gets its own studio-generated row, so there is no UNIQUE risk.
      const inFlight = await deps.db.query(
        `SELECT 1 FROM requests WHERE type='status_query' AND subtype='lookup' AND recipient_value=$1 AND status='sent' AND sent_at > now() - interval '2 minutes' LIMIT 1`,
        [receipt]);
      if (inFlight[0]) throw new HttpError(409, 'lookup_in_flight', 'Studio already asked Safaricom about this receipt. Wait for that answer.');
      const client = await deps.daraja.getForOperator();
      const cb = await urls();
      let ack: { conversationId: string; originatorConversationId: string };
      try {
        ack = await client.status.transaction({ transactionId: receipt, resultUrl: cb.status, queueTimeoutUrl: cb.status, remarks: 'studio lookup' });
      } catch (e) { throw sdkCallError(e, 'status', deps.config.egressIps); }
      const q = await recordStatusQuery(ack, { subtype: 'lookup', payload: { receipt, ackOriginatorConversationId: ack.originatorConversationId, ...(opts?.subject ? { subject: opts.subject } : {}) }, recipientValue: receipt, createdBy: actor.personId });
      await enqueue(deps.db, 'request_timeout', { requestId: q.id }, { runAt: new Date(Date.now() + 5 * 60_000), maxAttempts: 3 });
      await audit(deps.db, { personId: actor.personId, action: 'lookup.requested', target: q.id, ip: actor.ip });
      return { requestId: q.id };
    },
  };
}
