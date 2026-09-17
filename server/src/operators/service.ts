import { generateSecurityCredential, DarajaAPIError } from '@kepas/daraja-js';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import type { Settings, Env } from '../settings/store.js';
import type { DarajaFactory } from '../sdk/client.js';
import type { EventHub } from '../events/hub.js';
import type { JobHandler } from '../scheduler/loop.js';
import type { OrgService } from '../orgs/service.js';
import { currentCallbackSecret } from '../orgs/secret.js';
import { encryptForOrg, type Keyring } from '../crypto/secrets.js';
import { callbackUrls } from '../sdk/callbackUrls.js';
import { enqueueOn } from '../db/jobs.js';
import { audit } from '../audit/log.js';
import { explain } from '../sdk/meaning.js';
import { clearOperatorFailures } from '../money_out/operatorHealth.js';
import { HttpError } from '../util/errors.js';

export interface OperatorView {
  id: string; name: string; environment: Env; status: 'pending' | 'verified' | 'failed' | 'disabled'; priority: number;
  rotatedAt: string; lastProbeAt: string | null; lastError: string | null; expiresAt: string;
  /** Feature 8: credential failures inside the last ten minutes, and when the operator went DOWN. */
  consecutiveFailures: number; lastFailureAt: string | null; downSince: string | null;
}
export interface Actor { personId: string | null; ip: string }

// Safaricom's Daraja 3.0 portal dropped the certificate-file download in favour of a
// "Generate Security Credential" tool, so callers may supply either the operator password
// (generated locally, as before) or an already-generated credential pasted from that tool.
// Exactly one of `password` / `credential` must be present.
interface CredentialInput { password?: string; credential?: string; certPem?: string }
export interface AddOperatorInput { name: string; password?: string; certPem?: string; credential?: string }
export interface RotateOperatorInput { password?: string; credential?: string }

export interface OperatorService {
  add(env: Env, input: AddOperatorInput, actor: Actor): Promise<{ id: string }>;
  probe(id: string): Promise<void>;
  rotate(id: string, input: RotateOperatorInput, actor: Actor): Promise<void>;
  disable(id: string, actor: Actor): Promise<void>;
  list(env: Env): Promise<OperatorView[]>;
  timeoutHandler: JobHandler;
}

export const PASSWORD_EXPIRY_DAYS = 90;
const NO_ANSWER = 'No answer from Safaricom within 5 minutes. Check the public address and try Probe again.';
/** The three lines an organisation waiting on its first probe is shown when nothing arrives. */
export const PROBE_TIMEOUT_FAIL_REASON = [
  'Safaricom did not answer.',
  "Safaricom accepted the request but no result reached this organisation's address within five minutes.",
  'Check that the operator has the Balance Query ORG API role on the organisation portal, then try again.',
].join('\n');
const SECURITY_CREDENTIAL_BYTES = 256; // RSA-2048 ciphertext length
const UNIQUE_VIOLATION = '23505';

export function createOperatorService(deps: { db: Db; settings: Settings; keyring: Keyring; daraja: DarajaFactory; events: EventHub; orgs: OrgService; config: Config }): OperatorService {
  /** RLS already scopes this table; an explicit `org_id` also guards the admin pool, which bypasses it. */
  function requireOrgId(): string {
    const orgId = currentOrgId();
    if (!orgId) throw new Error('no organisation in scope');
    return orgId;
  }

  function validateCredential(credential: string): void {
    if (Buffer.from(credential, 'base64').length !== SECURITY_CREDENTIAL_BYTES) {
      throw new HttpError(400, 'bad_credential', 'That does not look like a Safaricom Security Credential.');
    }
  }

  // Both add() and rotate() need the public address configured *before* they touch the
  // operators table, so a probe that can never run doesn't leave a row behind (or, for
  // rotate, doesn't leave the old credential half-replaced). probe() also needs it, so it's
  // shared rather than duplicated three times.
  async function requireProbePreconditions(): Promise<{ publicUrl: string; secret: string }> {
    const publicUrl = await deps.settings.get('public.url');
    if (!publicUrl) throw new HttpError(409, 'public_url_missing', 'Set and test your public address first.');
    return { publicUrl, secret: await currentCallbackSecret(deps.orgs) };
  }

  async function credentialFor(env: Env, input: CredentialInput): Promise<string> {
    const hasPassword = input.password !== undefined;
    const hasCredential = input.credential !== undefined;
    if (hasPassword === hasCredential) {
      throw new HttpError(400, 'bad_input', 'Give either the operator password or a Security Credential, not both.');
    }
    if (hasCredential) {
      // Portal exports are often line-wrapped when copy-pasted; strip whitespace before it
      // is validated or stored.
      const credential = (input.credential as string).replace(/\s+/g, '');
      validateCredential(credential);
      if (input.certPem) await deps.settings.set(`env.${env}.certPem`, input.certPem);
      return credential;
    }
    const password = input.password as string;
    if (/[()]/.test(password)) throw new HttpError(400, 'bad_password', 'Safaricom does not allow ( or ) in operator passwords.');
    const pem = input.certPem ?? (await deps.settings.get(`env.${env}.certPem`));
    if (!pem) throw new HttpError(400, 'cert_missing', 'Paste the Safaricom certificate first.');
    let credential: string;
    try {
      credential = generateSecurityCredential({ password, certPem: pem });
    } catch {
      // node-forge/OpenSSL errors here are raw decoder diagnostics, not fit for an admin UI.
      // Only persist the certificate once we know it actually works.
      throw new HttpError(400, 'bad_cert', 'That certificate is not readable. Download the certificate from the Daraja portal and paste the whole file.');
    }
    if (input.certPem) await deps.settings.set(`env.${env}.certPem`, input.certPem);
    return credential;
  }

  /** Refusals of operators that were dropped, so add() can hand the reason straight back. */
  const refusals = new Map<string, string>();

  /**
   * Only an operator Safaricom has accepted is kept. One that fails before ever being verified is
   * removed (its probe requests stay, detached), so the list never fills with refused attempts
   * and the same name can be tried again. One that once worked keeps its row and is marked failed.
   */
  async function setFailed(id: string, rotatedAt: string | null, message: string) {
    const [updated] = await deps.db.query<{ id: string }>(
      `UPDATE operators
       SET status='failed', last_probe_at=now(), last_error=$3
       WHERE id=$1
         AND status <> 'disabled'
         AND verified_at IS NOT NULL
         AND rotated_at IS NOT DISTINCT FROM $2::timestamptz
       RETURNING id`,
      [id, rotatedAt, message.slice(0, 500)],
    );
    if (updated) { await deps.events.publish('operator.updated', { operatorId: id, status: 'failed' }); return; }
    const dropped = await deps.db.tx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM operators WHERE id=$1 AND status <> 'disabled' AND verified_at IS NULL
           AND rotated_at IS NOT DISTINCT FROM $2::timestamptz FOR UPDATE`,
        [id, rotatedAt],
      );
      if (!rows[0]) return false;
      await c.query(`UPDATE requests SET operator_id=NULL WHERE operator_id=$1`, [id]);
      await c.query(`DELETE FROM operators WHERE id=$1`, [id]);
      return true;
    });
    if (dropped) {
      refusals.set(id, message);
      await deps.events.publish('operator.updated', { operatorId: id, status: 'failed', removed: true, lastError: message.slice(0, 500) });
    }
  }

  /** Safaricom's own code and text from a synchronous rejection — the SDK's errorFromResponse only
   * sets resultCode/resultDesc when the caller passed them explicitly; a genuine sync rejection
   * carries them on the error's raw payload instead. Mirrors money_out/service.ts's own copy. */
  function syncRejection(e: DarajaAPIError): { code: string | null; desc: string } {
    if (e.resultCode != null) return { code: String(e.resultCode), desc: e.resultDesc ?? e.message };
    const raw = (e as { raw?: unknown }).raw;
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const code = typeof o.ResponseCode === 'string' ? o.ResponseCode : typeof o.errorCode === 'string' ? o.errorCode : null;
    const desc = e.resultDesc ?? (typeof o.ResponseDescription === 'string' ? o.ResponseDescription : typeof o.errorMessage === 'string' ? o.errorMessage : e.message);
    return { code, desc };
  }

  const svc: OperatorService = {
    async add(env, input, actor) {
      await requireProbePreconditions();
      const cred = await credentialFor(env, input);
      let row: { id: string };
      try {
        const orgId = requireOrgId();
        [row] = await deps.db.query<{ id: string }>(
          `INSERT INTO operators(org_id, name, credential_enc, status, priority, environment)
           VALUES ($1, $2, $3, 'pending', COALESCE((SELECT max(priority) FROM operators WHERE org_id=$1), 0) + 1, $4) RETURNING id`,
          [orgId, input.name.trim(), await encryptForOrg(deps.keyring, cred), env],
        );
      } catch (e) {
        if (e && typeof e === 'object' && (e as { code?: string }).code === UNIQUE_VIOLATION) {
          // Adding a failed operator again under the same name is a retry with a new credential —
          // the natural thing to do after Safaricom refused the last one — not a clash. A working
          // or pending operator keeps its name.
          const [failed] = await deps.db.query<{ id: string }>(
            `SELECT id FROM operators WHERE org_id=$1 AND name=$2 AND environment=$3 AND status='failed'`,
            [requireOrgId(), input.name.trim(), env],
          );
          if (failed) { await svc.rotate(failed.id, input, actor); return { id: failed.id }; }
          throw new HttpError(409, 'operator_exists', 'An operator with that name already exists.');
        }
        throw e;
      }
      await audit(deps.db, { personId: actor.personId, action: 'operator.added', target: input.name, ip: actor.ip });
      deps.daraja.invalidate();
      // Onboarding auto-probe needs a Daraja client for the ACTIVE mode, which only works when
      // this operator's own environment is that mode (probe() itself would otherwise 409
      // wrong_environment). Adding an operator for the other environment is a legitimate way to
      // prepare it ahead of a later mode switch — leave it 'pending', untested, rather than
      // rejecting the add outright.
      const mode = ((await deps.settings.get('daraja.environment')) as Env) || 'sandbox';
      if (env === mode) await svc.probe(row.id);
      // A synchronous refusal has already dropped the row: the caller gets the reason, not an id.
      const refusal = refusals.get(row.id);
      if (refusal) { refusals.delete(row.id); throw new HttpError(400, 'operator_refused', refusal); }
      return { id: row.id };
    },

    async probe(id) {
      const [opRow] = await deps.db.query<{ environment: Env; rotated_at: string; status: string }>('SELECT environment, rotated_at::text AS rotated_at, status FROM operators WHERE id=$1', [id]);
      if (!opRow) throw new HttpError(404, 'operator_not_found', 'That operator does not exist.');
      if (opRow) {
        const mode = ((await deps.settings.get('daraja.environment')) as Env) || 'sandbox';
        if (opRow.environment !== mode) {
          throw new HttpError(409, 'wrong_environment', `Switch to ${opRow.environment} mode to test this operator.`);
        }
      }
      if (opRow.status === 'disabled') throw new HttpError(409, 'operator_unavailable', 'This operator is turned off. Enable it in Settings first.');
      const { publicUrl, secret } = await requireProbePreconditions();
      // Lock requests before the operator, matching callback/timeout lock order. Recheck the
      // credential generation before cancelling anything: rotate() may have replaced this
      // invocation while its preconditions were being read.
      const current = await deps.db.tx(async (c) => {
        const live = await c.query<{ id: string }>(
          `SELECT id FROM requests WHERE operator_id=$1 AND subtype='operator_probe'
           AND status IN ('sent','unknown') ORDER BY id FOR UPDATE`, [id],
        );
        const updated = await c.query<{ id: string }>(
          `UPDATE operators SET status=CASE WHEN status='failed' THEN 'pending' ELSE status END
           WHERE id=$1 AND status <> 'disabled'
             AND rotated_at IS NOT DISTINCT FROM $2::timestamptz RETURNING id`,
          [id, opRow.rotated_at],
        );
        if (!updated.rows[0]) return false;
        const ids = live.rows.map((row) => row.id);
        await c.query(`UPDATE requests SET status='cancelled' WHERE id=ANY($1::uuid[])`, [ids]);
        await c.query(
          `UPDATE jobs SET done_at=now() WHERE kind='operator_probe_timeout' AND done_at IS NULL
           AND payload->>'requestId'=ANY($1::text[])`, [ids],
        );
        return true;
      });
      if (!current) return;
      const urls = callbackUrls(publicUrl, secret);
      let ack: { originatorConversationId: string; conversationId: string; responseCode: string; responseDescription: string };
      try {
        const client = await deps.daraja.get(id);
        ack = await client.balance.query({ resultUrl: urls.balance, queueTimeoutUrl: urls.balance, remarks: 'studio probe' });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e instanceof DarajaAPIError) {
          // A synchronous rejection is Safaricom's own answer, not a bare SDK message — sign-up
          // (and Settings) show it as the studio's usual three lines, the same shape a real
          // ResultCode failure gets from the balance callback (balance.ts), never just one line.
          const { code, desc } = syncRejection(e);
          const ex = code !== null ? explain('balance', code, desc, { egressIps: deps.config.egressIps }) : null;
          await setFailed(id, opRow.rotated_at, ex ? [ex.safaricomSaid.slice(0, 500), ex.meaning, ex.whatToDo].join('\n') : desc);
        } else {
          await setFailed(id, opRow.rotated_at, e instanceof Error ? e.message : String(e));
        }
        return;
      }
      // Everything below is bookkeeping for a call Safaricom has already accepted — a failure
      // here (e.g. the event bus) is a real error to surface, not a reason to mark the
      // operator failed.
      // The request carries the credential generation that started it. A rotation can commit
      // while the SDK call is in flight; this guarded transaction then creates no request for
      // the old credential. The callback repeats the guard before it can verify the operator.
      const req = await deps.db.tx(async (c) => {
        const updated = await c.query<{ id: string }>(
          `UPDATE operators SET status='pending', last_probe_at=now(), last_error=NULL
           WHERE id=$1 AND status <> 'disabled' AND rotated_at IS NOT DISTINCT FROM $2::timestamptz RETURNING id`,
          [id, opRow.rotated_at],
        );
        if (!updated.rows[0]) return null;
        const inserted = await c.query<{ id: string }>(
          `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, operator_id, sent_at, payload_json)
           VALUES ('balance','operator_probe',$1,$2,'sent',$3,now(),$4::jsonb) RETURNING id`,
          // I3: Safaricom's own synchronous acknowledgement is persisted with the request, so the
          // acknowledgement job writes result_code, result_desc and raw_result_json from evidence.
          [ack.originatorConversationId, ack.conversationId, id, JSON.stringify({ operatorRotatedAt: opRow.rotated_at, ack })],
        );
        const request = inserted.rows[0];
        // I4: the request, its 5-minute timeout, the sandbox acknowledgement job and the probe
        // pointer all commit in this one transaction. Sign-up's later pointer write is a repeat.
        await enqueueOn(c, 'operator_probe_timeout', { requestId: request.id }, { runAt: new Date(Date.now() + 5 * 60_000), maxAttempts: 1 });
        const [org] = (await c.query<{ status: string }>('SELECT status FROM orgs WHERE id = app_current_org()')).rows;
        if (opRow.environment === 'sandbox' && org?.status === 'operator_probing') {
          await c.query(
            `INSERT INTO settings(org_id, key, value, encrypted) VALUES (app_current_org(), 'setup.probeRequestId', $1, false)
             ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [request.id],
          );
          await enqueueOn(c, 'sandbox_ack_verify', { requestId: request.id }, { runAt: new Date(Date.now() + 60_000), maxAttempts: 1 });
        }
        return request;
      });
      if (!req) return;
      // Safaricom accepted the call, so the credential works: a probe is the way back from the
      // two-try guard, and the count must not outlive the failure it counted (feature 8).
      await clearOperatorFailures(deps.db, id);
      await deps.events.publish('operator.updated', { operatorId: id, status: 'pending' });
    },

    async rotate(id, input, actor) {
      const [existing] = await deps.db.query<{ environment: Env }>('SELECT environment FROM operators WHERE id=$1', [id]);
      if (!existing) throw new HttpError(404, 'operator_not_found', 'That operator does not exist.');
      // Checked before any write (credential, status, audit row): unlike add() — where staging
      // an operator for a future mode switch is normal — rotating a credential the studio cannot
      // immediately verify must not leave the operator silently demoted behind a 409 that reads
      // as "nothing happened".
      const mode = ((await deps.settings.get('daraja.environment')) as Env) || 'sandbox';
      if (existing.environment !== mode) {
        throw new HttpError(409, 'wrong_environment', `Switch to ${existing.environment} mode to test this operator.`);
      }
      await requireProbePreconditions();
      const cred = await credentialFor(existing.environment, input);
      await deps.db.query(
        `UPDATE operators SET credential_enc=$2, status='pending', rotated_at=now(), last_error=NULL WHERE id=$1 AND org_id=$3`,
        [id, await encryptForOrg(deps.keyring, cred), requireOrgId()],
      );
      await audit(deps.db, { personId: actor.personId, action: 'operator.rotated', target: id, ip: actor.ip });
      deps.daraja.invalidate();
      await svc.probe(id);
    },

    async disable(id, actor) {
      await deps.db.query(`UPDATE operators SET status='disabled' WHERE id=$1`, [id]);
      // A disabled operator's in-flight probe timeout would otherwise fire 5 minutes later
      // and mark it failed for no reason — it's already off.
      await deps.db.query(
        `UPDATE jobs SET done_at=now() WHERE kind='operator_probe_timeout' AND done_at IS NULL
           AND payload->>'requestId' IN (SELECT id::text FROM requests WHERE operator_id=$1 AND status IN ('sent','unknown'))`,
        [id],
      );
      // A live probe must not be able to re-enable an operator the owner just turned off: whenever
      // Safaricom's answer for it lands, the balance callback's `UPDATE operators SET
      // status='verified'` must find nothing still 'sent'/'unknown' to match. Mirrors what probe()
      // already does when a newer probe for the same operator supersedes an older one.
      await deps.db.query(
        `UPDATE requests SET status='cancelled' WHERE operator_id=$1 AND subtype='operator_probe' AND status IN ('sent','unknown')`,
        [id],
      );
      await audit(deps.db, { personId: actor.personId, action: 'operator.disabled', target: id, ip: actor.ip });
      deps.daraja.invalidate();
      await deps.events.publish('operator.updated', { operatorId: id, status: 'disabled' });
    },

    async list(env) {
      const rows = await deps.db.query<{ id: string; name: string; environment: Env; status: OperatorView['status']; priority: number; rotated_at: Date; last_probe_at: Date | null; last_error: string | null; consecutive_failures: number; last_failure_at: Date | null; down_since: Date | null }>(
        'SELECT id, name, environment, status, priority, rotated_at, last_probe_at, last_error, consecutive_failures, last_failure_at, down_since FROM operators WHERE environment=$1 ORDER BY priority ASC, created_at ASC', [env]);
      return rows.map((r) => ({
        id: r.id, name: r.name, environment: r.environment, status: r.status, priority: r.priority,
        rotatedAt: r.rotated_at.toISOString(), lastProbeAt: r.last_probe_at?.toISOString() ?? null, lastError: r.last_error,
        consecutiveFailures: r.consecutive_failures, lastFailureAt: r.last_failure_at?.toISOString() ?? null, downSince: r.down_since?.toISOString() ?? null,
        expiresAt: new Date(r.rotated_at.getTime() + PASSWORD_EXPIRY_DAYS * 86_400_000).toISOString(),
      }));
    },

    timeoutHandler: async (payload) => {
      const { requestId } = payload as { requestId: string };
      // Check-then-act against a callback that can land at any moment must be one atomic
      // statement: only a request still 'sent' is claimed, and only the operator behind a
      // claimed request is touched, all inside one transaction.
      let removed = false;
      const operatorId = await deps.db.tx(async (c) => {
        const { rows } = await c.query<{ operator_id: string | null }>(
          `UPDATE requests SET status='unknown', result_at=now(), result_source='poll', meaning=$2
           WHERE id=$1 AND status='sent' RETURNING operator_id`,
          [requestId, NO_ANSWER],
        );
        const row = rows[0];
        if (!row) return null;
        if (row.operator_id) {
          // Same rule as setFailed: a never-verified operator is dropped, a once-working one is kept.
          const kept = await c.query<{ id: string }>(`UPDATE operators SET status='failed', last_error=$2 WHERE id=$1 AND verified_at IS NOT NULL RETURNING id`, [row.operator_id, NO_ANSWER]);
          if (!kept.rows[0]) {
            await c.query(`UPDATE requests SET operator_id=NULL WHERE operator_id=$1`, [row.operator_id]);
            const gone = await c.query<{ id: string }>(`DELETE FROM operators WHERE id=$1 AND verified_at IS NULL RETURNING id`, [row.operator_id]);
            removed = !!gone.rows[0];
          }
        }
        return row.operator_id;
      });
      if (!operatorId) return;
      // An organisation still waiting on its sign-up probe fails with it (spec 4.1). The status
      // guard makes this a no-op for every other organisation, single mode's included — nothing
      // there is ever `operator_probing`; the `setup.probeRequestId` guard makes it a no-op for a
      // probe a newer one has already superseded — only the request the organisation is actually
      // waiting on may fail it.
      await deps.db.query(
        `UPDATE orgs SET status='failed', fail_reason=$1
           WHERE id=$2 AND status='operator_probing'
             AND EXISTS (SELECT 1 FROM settings WHERE org_id=$2 AND key='setup.probeRequestId' AND value=$3)`,
        [PROBE_TIMEOUT_FAIL_REASON, requireOrgId(), requestId],
      );
      await deps.events.publish('operator.updated', removed ? { operatorId, status: 'failed', removed: true, lastError: NO_ANSWER } : { operatorId, status: 'failed' });
    },
  };
  return svc;
}
