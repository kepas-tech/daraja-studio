import { randomUUID } from 'node:crypto';
import { DarajaAPIError, DarajaAuthError, DarajaConnectionError, normalizePhone, type Daraja } from '@kepas/daraja-js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
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
import { KINDS, MONEY_TYPES, type CallbackUrls, type RequestRow } from './registry.js';
import { failOperatorOnCredentialCode } from './operatorHealth.js';
import { getRequest, type RequestView } from './reads.js';

export interface SendInput { phone: string; amountCents: number; commandId: 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment'; category?: string; remarks?: string; occasion?: string; confirmDuplicate?: boolean }
export interface Actor { personId: string; ip: string }
export interface MoneyOutService {
  send(input: SendInput, actor: Actor): Promise<RequestView>;
  sweep(): Promise<{ polled: number; expired: number }>;
  pollOne(requestId: string): Promise<{ queryId: string }>;
  markChecked(requestId: string, note: string, actor: Actor): Promise<RequestView>;
  refreshBalance(actor: Actor | null): Promise<{ requestId: string }>;
  lookup(receipt: string, actor: Actor): Promise<{ requestId: string }>;
}

export const UNCONFIRMED = 'We could not confirm Safaricom received this. Studio will check.';
export const B2C_QUEUE_TIMEOUT = "Safaricom's queue timed out before this payment was processed. Studio will check whether it went through.";
export const NO_ANSWER_AFTER_POLLS = 'No answer from Safaricom after 5 checks. Check the Safaricom portal, then Mark as checked.';
export const AUTH_FAILED_MEANING = 'Safaricom did not accept the Daraja key and secret. Check them in Settings.';
const DUP_WINDOW = "interval '5 minutes'";
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
 * The HTTP status must be checked too, not just the error code: a 5xx carrying this same
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
 * text so a `safaricom_rejected` response still shows the house three lines, not just one. */
function sdkCallError(e: unknown, scope: DarajaScope, egressIps: string[]): HttpError {
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

export function createMoneyOutService(deps: { db: Db; settings: Settings; daraja: DarajaFactory; events: EventHub; config: Config; orgs: OrgService }): MoneyOutService {
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
  async function pollTarget(client: Daraja, cb: CallbackUrls, target: { id: string; originator_conversation_id: string }, subtype: 'sweep' | 'manual'): Promise<{ ok: true; queryId: string } | { ok: false; reason: 'sdk_rejected' | 'not_recorded' }> {
    await deps.db.query(`UPDATE requests SET poll_attempts = poll_attempts + 1, last_poll_at = now() WHERE id=$1`, [target.id]);
    let ack: { conversationId: string; originatorConversationId: string };
    try {
      ack = await client.status.transaction({ originatorConversationId: target.originator_conversation_id, resultUrl: cb.status, queueTimeoutUrl: cb.status, remarks: 'studio check' });
    } catch (e) {
      console.error('status query rejected', target.id, e instanceof Error ? e.message : e);
      return { ok: false, reason: 'sdk_rejected' };
    }
    try {
      const q = await recordStatusQuery(ack, { subtype, payload: { targetRequestId: target.id, ackOriginatorConversationId: ack.originatorConversationId } });
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

  return {
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
      if (deps.config.maxSendCents !== null && input.amountCents > deps.config.maxSendCents) {
        const cap = deps.config.maxSendCents;
        throw new HttpError(409, 'over_cap', `This studio is capped at KES ${cap % 100 === 0 ? cap / 100 : (cap / 100).toFixed(2)} per send.`, { capCents: cap });
      }
      const cb = await urls();

      // Operator first: a 409 here writes nothing. Then the pending row and its audit entry, in
      // one transaction so a failing audit write never strands a row with no audit trail. The
      // request exists before Safaricom hears of it (a crash between the ack and our update
      // below leaves a visible row) — once the SDK sends our own OriginatorConversationID
      // (1.5.0), the sweep resolves such a row by it; meanwhile the ack's own id is kept
      // on the row so a human can still find it on the Safaricom side.
      const client = await deps.daraja.getForOperator();
      const operatorId = (await deps.db.query<{ id: string }>(`SELECT id FROM operators WHERE name=$1`, [client.config?.initiator ?? '']))[0]?.id ?? null;
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
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [kind.dupKey({ type: kind.type, recipient_value: phone, amount_cents: String(input.amountCents), payload_json: {} })]);
        if (!input.confirmDuplicate) {
          const dup = await c.query<{ id: string; created_at: Date }>(
            `SELECT id, created_at FROM requests WHERE type=$1 AND recipient_value IS NOT DISTINCT FROM $2 AND amount_cents=$3
               AND created_at > now() - ${DUP_WINDOW} AND status NOT IN ('failed','cancelled','rejected') ORDER BY created_at DESC LIMIT 1`,
            [kind.type, phone, input.amountCents]);
          if (dup.rows[0]) throw new HttpError(409, 'duplicate_recent', 'You sent this already. Send it again?', { requestId: dup.rows[0].id, at: dup.rows[0].created_at.toISOString() });
        }
        const { rows } = await c.query<RequestRow>(
          `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, remarks, payload_json, created_by, operator_id)
           VALUES ($1,$2,$3,'pending',$4,'KES','phone',$5,$6,$7::jsonb,$8,$9) RETURNING *`,
          [kind.type, commandId, randomUUID(), input.amountCents, phone, input.remarks ?? null, JSON.stringify({ occasion: input.occasion ?? null, category }), actor.personId, operatorId]);
        const r = rows[0];
        await c.query(
          `INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
          [actor.personId, 'request.created', r.id, null, JSON.stringify({ type: kind.type, subtype: commandId, category, amountCents: input.amountCents }), actor.ip]);
        return r;
      });

      const { version: initialVersion, setting: b2cApiSetting, env: b2cApiEnv } = await resolveB2cVersion();
      let versionUsed: 'v1' | 'v3' = initialVersion;
      let status: string;
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
        const payloadPatch: Record<string, unknown> = { b2cApiUsed: versionUsed };
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
        const b2cApiUsed = JSON.stringify({ b2cApiUsed: versionUsed });
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
          await deps.db.query(
            `UPDATE requests SET status='failed', result_at=now(), result_code=$2, result_desc=$3, meaning=$4, retriable=$5, payload_json = payload_json || $6::jsonb WHERE id=$1 AND status='pending'`,
            [row.id, code, desc, ex?.meaning ?? desc, ex?.retriable ?? false, b2cApiUsed]);
          if (code !== null) await failOperatorOnCredentialCode(deps.db, deps.events, operatorId, code, desc);
          status = 'failed';
        } else {
          await deps.db.query(`UPDATE requests SET status='failed', result_at=now(), result_desc=$2, meaning=$3, payload_json = payload_json || $4::jsonb WHERE id=$1 AND status='pending'`, [row.id, 'Studio could not send the request.', 'Something went wrong on our side before Safaricom was reached.', b2cApiUsed]);
          console.error('send failed before Safaricom', row.id, e instanceof Error ? e.name : 'error');
          status = 'failed';
        }
      }
      await deps.events.publish('request.updated', { id: row.id, status });
      return view(row.id);
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

    async pollOne(requestId) {
      const orgId = requireOrg();
      const [t] = await deps.db.query<{ id: string; originator_conversation_id: string; status: string; poll_attempts: number; type: string; last_poll_at: Date | null }>(
        `SELECT id, ${SAFARICOM_OCID} AS originator_conversation_id, status, poll_attempts, type, last_poll_at FROM requests WHERE id=$1 AND org_id=$2`, [requestId, orgId]);
      if (!t || !MONEY_TYPES.includes(t.type)) throw new HttpError(404, 'not_found', 'That request does not exist.');
      if (t.status !== 'sent' && t.status !== 'pending' && t.status !== 'unknown') throw new HttpError(409, 'not_pending', 'This request already has its result.');
      // A cooldown, not just the step-up the guard stack already lacks: without it, an
      // operator holding only `send.phone` could burn the whole 5-poll budget in a burst and hit
      // Safaricom's status API on every click, mirroring the sweep's own 2-minute pacing.
      if (t.last_poll_at && t.last_poll_at.getTime() > Date.now() - 2 * 60_000) {
        throw new HttpError(409, 'poll_too_soon', 'Studio asked Safaricom less than two minutes ago. Wait for that answer first.');
      }
      if (t.poll_attempts >= MAX_POLLS) throw new HttpError(409, 'poll_cap', 'Studio has already asked Safaricom 5 times. Check the Safaricom portal, then Mark as checked.');
      const client = await deps.daraja.getForOperator();
      const outcome = await pollTarget(client, await urls(), t, 'manual');
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
      // UPDATE's own qualification, not just the CTE: under READ COMMITTED, Postgres
      // re-checks only the UPDATE's own qual against the latest row version before writing, so a
      // row finalised by a concurrent callback between the CTE's snapshot and the UPDATE's lock
      // must still fail the write, not just miss the CTE.
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
      const operatorId = (await deps.db.query<{ id: string }>(`SELECT id FROM operators WHERE name=$1`, [client.config?.initiator ?? '']))[0]?.id ?? null;
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

    async lookup(receipt, actor) {
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
      const q = await recordStatusQuery(ack, { subtype: 'lookup', payload: { receipt, ackOriginatorConversationId: ack.originatorConversationId }, recipientValue: receipt, createdBy: actor.personId });
      await enqueue(deps.db, 'request_timeout', { requestId: q.id }, { runAt: new Date(Date.now() + 5 * 60_000), maxAttempts: 3 });
      await audit(deps.db, { personId: actor.personId, action: 'lookup.requested', target: q.id, ip: actor.ip });
      return { requestId: q.id };
    },
  };
}
