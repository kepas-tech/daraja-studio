import type { Db } from '../db/pool.js';
import { withOrg, withSystem } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import type { Settings } from '../settings/store.js';
import type { MoneyOutService } from '../money_out/service.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { PASSWORD_EXPIRY_DAYS, type OperatorService } from '../operators/service.js';
import type { OrgStatus } from '../orgs/service.js';
import type { MoneyInService } from '../money_in/service.js';
import type { BulkService } from '../money_out/bulk.js';
import type { JobHandler } from './loop.js';

export const REQUEST_TIMEOUT_MEANING = 'No answer from Safaricom within 5 minutes. Try again.';

/** One-shot: a non-money request (balance refresh, lookup) that never got its result. */
export function requestTimeoutHandler(deps: { db: Db; events: EventHub }): JobHandler {
  return async (payload) => {
    const { requestId } = payload as { requestId: string };
    const rows = await deps.db.query<{ id: string }>(
      `UPDATE requests SET status='unknown', result_at=now(), meaning=$2 WHERE id=$1 AND status='sent' RETURNING id`, [requestId, REQUEST_TIMEOUT_MEANING]);
    if (rows[0]) await deps.events.publish('request.updated', { id: rows[0].id, status: 'unknown' });
  };
}

/**
 * The one loop every recurring handler uses. Organisations are listed once, across the whole
 * install, then each one's work runs inside its own context. A `closed` organisation is skipped;
 * everything else is walked, including `pending` ones — this install's organisation stays pending
 * until the setup wizard finishes it, and skipping it would silently stop the sweep before then.
 * One organisation's failure is logged by id and never stops the walk.
 */
export async function forEachOrg(db: Db, fn: (org: { id: string; status: OrgStatus }) => Promise<void>): Promise<void> {
  const orgs = await withSystem(() =>
    db.query<{ id: string; status: OrgStatus }>(`SELECT id, status FROM orgs WHERE status <> 'closed' ORDER BY created_at`),
  );
  for (const org of orgs) {
    try {
      await withOrg(org.id, () => fn(org));
    } catch (e) {
      console.error('job failed for organisation', org.id, e instanceof Error ? e.message : e);
    }
  }
}

/** Every 30 s: finish the results that never arrived, for every organisation. */
export function sweepHandler(deps: { db: Db; moneyOut: Pick<MoneyOutService, 'sweep'> }): JobHandler {
  return async () => {
    // forEachOrg itself never rethrows (one organisation's failure must never stop the walk), so
    // failures are collected here and raised once the whole walk is done — otherwise the loop
    // always re-arms this job as a success and jobs.error stays permanently NULL.
    const failed: string[] = [];
    await forEachOrg(deps.db, async (org) => {
      try {
        await deps.moneyOut.sweep();
      } catch (e) {
        failed.push(org.id);
        throw e;
      }
    });
    if (failed.length) throw new Error(`sweep failed for organisation(s): ${failed.join(', ')}`);
  };
}

/** Hourly: expired sessions, cache rows and rate-limit windows, across every organisation. */
export function housekeepingHandler(deps: { db: Db }): JobHandler {
  return async () => {
    // sessions is a tenant table: without the system context this deletes nothing at all.
    await withSystem(() => deps.db.query('DELETE FROM sessions WHERE expires_at < now()'));
    // cache is an install-wide table with no organisation and no policies; the organisation lives
    // in the key (db/cache.ts), so one sweep covers every namespace.
    await deps.db.query('DELETE FROM cache WHERE expires_at < now()');
    // rate_limits is install-wide too. The longest window in spec 8.3 is exactly one day, so a row
    // whose window opened more than a day ago cannot be current for any limit.
    await deps.db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  };
}

const EXPIRY_ALERT_DAYS = [7, 3];
const EXPIRY_ALERT_ACTION = 'operator_password_expiring';

/** Every 24 h: operator-password expiry alerts (once per Kenyan calendar day per operator — see
 * below), then a balance snapshot when the studio is money-ready. `refreshBalance` itself also
 * refuses with `public_url_unverified` when the public address is unverified — the check here is
 * defence in depth, and is what actually keeps the job from ever touching Safaricom or building a
 * Daraja client for an address nothing has proven reachable: unlike the HTTP route, this job
 * has no `requireMoneyReady` in front of it. */
export function dailyHandler(deps: { db: Db; settings: Settings; events: EventHub; moneyOut: Pick<MoneyOutService, 'refreshBalance'> }): JobHandler {
  // RLS already scopes both queries below, but the admin pool (a superuser) bypasses RLS
  // entirely — the boot pass and tests use it, and the runtime pool is not yet role-bound
  // either — so both carry an explicit `org_id = $n` bound to the organisation forEachOrg is
  // currently walking, the same defence settings/store.ts already applies (design decision I1).
  async function forOneOrg(orgId: string): Promise<void> {
    // Day bounds are the operator's own Kenyan calendar day (Africa/Nairobi, matching
    // money_out/reads.ts's rule for History's date filters), not the session's default timezone —
    // otherwise the count can be off by one for part of the evening UTC.
    const mode = (await deps.settings.get('daraja.environment')) || 'sandbox';
    const ops = await deps.db.query<{ id: string; days_left: number }>(
      `SELECT id, ((rotated_at AT TIME ZONE 'Africa/Nairobi')::date + ${PASSWORD_EXPIRY_DAYS}) - (now() AT TIME ZONE 'Africa/Nairobi')::date AS days_left
       FROM operators WHERE status <> 'disabled' AND environment=$1 AND org_id=$2`, [mode, orgId]);
    for (const op of ops) {
      const daysLeft = Number(op.days_left);
      if (!EXPIRY_ALERT_DAYS.includes(daysLeft)) continue;
      // days_left only changes once every 24 h, so a job that only ever runs once a day would
      // never need this — but nothing stops a manual re-run or a second tick landing on the same
      // Kenyan day, and that must not spam the same alert. audit_log is the durable record of it.
      const already = await deps.db.query(
        `SELECT 1 FROM audit_log WHERE action=$1 AND target=$2 AND org_id=$3
           AND (at AT TIME ZONE 'Africa/Nairobi')::date = (now() AT TIME ZONE 'Africa/Nairobi')::date LIMIT 1`,
        [EXPIRY_ALERT_ACTION, op.id, orgId]);
      if (already[0]) continue;
      await deps.events.publish('alert', { kind: EXPIRY_ALERT_ACTION, operatorId: op.id, daysLeft });
      await audit(deps.db, { action: EXPIRY_ALERT_ACTION, target: op.id });
    }
    if (!(await deps.settings.get('public.verifiedAt'))) { console.error('daily balance refresh skipped', 'public_url_unverified'); return; }
    try {
      await deps.moneyOut.refreshBalance(null);
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) { console.error('daily balance refresh skipped', e.code); return; }
      throw e;
    }
  }
  return async () => {
    // See sweepHandler's comment: forEachOrg never rethrows, so failures are collected here and
    // raised once the whole walk is done, or jobs.error never sees them.
    const failed: string[] = [];
    await forEachOrg(deps.db, async (org) => {
      // A suspended organisation is read-only: its money already left, so the sweep still runs,
      // but there is nothing to refresh a balance for. Spec section 6.2.
      if (org.status === 'suspended') return;
      try {
        await forOneOrg(org.id);
      } catch (e) {
        failed.push(org.id);
        throw e;
      }
    });
    if (failed.length) throw new Error(`daily job failed for organisation(s): ${failed.join(', ')}`);
  };
}

/**
 * Every recurring job the scheduler runs — the boot pass's own `createScheduler(db, ...)` argument,
 * pulled out here so it is one exported, callable thing rather than an inline object literal only
 * `index.ts`'s own source text could ever be checked against (Minor 5, final review).
 */
export function buildHandlers(
  deps: {
    db: Db; events: EventHub; settings: Settings; moneyOut: Pick<MoneyOutService, 'sweep' | 'refreshBalance' | 'expireApprovals'>;
    operators: Pick<OperatorService, 'timeoutHandler'>;
    moneyIn: Pick<MoneyInService, 'checkMissedIfRegistered'>;
    bulk: Pick<BulkService, 'drain'>;
  },
): Record<string, JobHandler> {
  return {
    // One-shot, inside the batch's own organisation (the loop enters it from the stamped payload).
    bulk_send: async (payload) => { await deps.bulk.drain((payload as { planId: string }).planId); },
    // Every hour: backfill any customer payment whose confirmation Safaricom never delivered.
    // Every 10 minutes: a held send nobody decided on within a day is refused by the clock (M4).
    approvals_expire: async () => { await forEachOrg(deps.db, async () => { await deps.moneyOut.expireApprovals(); }); },
    c2b_pull: async () => { await forEachOrg(deps.db, () => deps.moneyIn.checkMissedIfRegistered()); },
    operator_probe_timeout: deps.operators.timeoutHandler,
    request_timeout: requestTimeoutHandler({ db: deps.db, events: deps.events }),
    money_out_sweep: sweepHandler({ db: deps.db, moneyOut: deps.moneyOut }),
    housekeeping: housekeepingHandler({ db: deps.db }),
    daily: dailyHandler({ db: deps.db, settings: deps.settings, events: deps.events, moneyOut: deps.moneyOut }),
  };
}
