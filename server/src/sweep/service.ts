import { currentOrgId, type Db } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import type { MoneyOutService } from '../money_out/service.js';
import type { FeesService } from '../fees/service.js';
import type { Settings } from '../settings/store.js';
import type { ModuleService } from '../modules/service.js';
import { audit } from '../audit/log.js';
import { HttpError } from '../util/errors.js';
import { directionOf, LEDGER_TYPES } from '../money_out/registry.js';
import { scheduleBalanceRefresh } from '../money_out/balanceRefresh.js';
import { normalizePhone } from '@kepas/daraja-js';
import { feeFor, netOf, type FeeRule } from './fee.js';
import { timetableWords, windowFor, type Schedule, type Timetable } from './window.js';

/**
 * Sweep-through: what arrives for a business leaves for that business's own phone, on its own
 * timetable, less the fee set for it.
 *
 * Nothing here writes a balance. What is owed is a sum over rows, worked out every time it is asked
 * for:
 *
 *     owed = payments in, matched to this business
 *          - the sweeps already sent or in flight
 *          - the fees those sweeps took
 *
 * A sweep claims the exact payment rows it covers, so every shilling that left can be traced back
 * to the shillings that arrived, and the claimed set is also what keeps a second window from
 * sweeping money the first one has already taken.
 */

export interface Actor { personId: string; ip: string }

/** Safaricom will not send less than this to a phone. The same figure KEPAS Pay uses. */
export const DEFAULT_MIN_CENTS = 1000;
/** ...and this is where the owner changes that, without a new build. */
export const MIN_SETTING = 'sweep.minCents';

/**
 * A float figure older than this is not trusted enough to send against. The daily job reads the
 * float once a day and every settled payment reads it again, so a figure this old means those reads
 * have stopped working — and sending against a figure from three days ago is how a payout is
 * refused for a float that emptied in between. Money waits; it does not guess.
 */
export const FLOAT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * How long a sweep may sit prepared — written down, with its payments claimed, but never handed to
 * Safaricom. Nothing should take that long between two statements; anything that does means the
 * process stopped in the middle, so the row is called failed and the money is owed again, for the
 * next window to carry.
 */
export const PREPARED_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The states that mean the money has been claimed: written down, in flight, or gone. A prepared
 * sweep is on its way to Safaricom within the same pass, so it is counted as claimed too — the safe
 * direction, because the alternative is a second window paying the same money twice.
 */
const CLAIMED = ['prepared', 'sending', 'sent'];

/** Every kind of row that means money arrived, from the one list that says which way money moves. */
const MONEY_IN_TYPES: string[] = LEDGER_TYPES.filter((t) => directionOf(t) === 'in');

const FEE_COLUMNS = 'fee_percent_bp, fee_flat_cents, fee_floor_cents, fee_ceiling_cents';

export interface FeeView { percentBp: number; flatCents: number; floorCents: number | null; ceilingCents: number | null }
export interface SweepPaymentView { id: string; receipt: string | null; amountCents: number; at: string; accountNumber: string | null; type: string }
export interface OwedView {
  paidInCents: number;
  sweptCents: number;
  feesTakenCents: number;
  owedCents: number;
  /** The payments that make the figure up, oldest first. */
  payments: SweepPaymentView[];
}
export interface SweepView {
  id: string; window: string; schedule: Schedule; state: string;
  grossCents: number; feeCents: number; netCents: number;
  destinationPhone: string | null; reasonCode: string | null; reason: string | null; gapCents: number | null;
  requestId: string | null; requestStatus: string | null; receipt: string | null;
  sentAt: string | null; createdAt: string; payments: SweepPaymentView[];
}
/** Why this business is not sweeping right now, in the owner's words. Null when nothing is waiting. */
export interface Waiting { code: string; text: string; gapCents: number | null }
export interface BusinessSweepView {
  businessId: string; businessName: string; businessCode: string; active: boolean;
  destinationPhone: string | null;
  schedule: Schedule; hour: number; weekday: number;
  fee: FeeView; stopped: boolean; consentedAt: string | null;
  /** The timetable in words, the same ones the page shows. */
  timetable: string;
  owed: OwedView;
  minCents: number;
  waiting: Waiting | null;
  sweeps: SweepView[];
}
export interface SweepInput {
  destinationPhone: string | null;
  schedule: Schedule;
  hour: number;
  weekday: number;
  fee: FeeView;
}
export interface SweepRun { businesses: number; sent: number; held: number; failed: number; skipped: number }
/**
 * What one attempt at a sweep did, and whether it took money out of the account. The pass keeps a
 * running float, so the second half of this matters as much as the first: only an attempt that
 * reached Safaricom — or one whose window another pass has already claimed — may take its net and
 * charge off what is left. A hold or a failure left the account alone.
 */
interface Attempt { outcome: 'sent' | 'held' | 'failed'; committed: boolean }
/** One business with money due this pass, and what sending it would take. */
interface Due {
  row: SettingsRow;
  owed: OwedView;
  window: string;
  netCents: number;
  /** Safaricom's own charge for the net, or null when no band prices it. */
  chargeCents: number | null;
  /** When the oldest unpaid payment for this business arrived: the pass is ordered by this. */
  since: number;
}
export interface SweepService {
  list(): Promise<{ items: BusinessSweepView[]; minCents: number }>;
  one(businessId: string): Promise<BusinessSweepView>;
  save(businessId: string, input: SweepInput, actor: Actor): Promise<BusinessSweepView>;
  /** One press. Stopping leaves the money owed and visible; nothing is sent while it is stopped. */
  setStopped(businessId: string, stopped: boolean, actor: Actor): Promise<BusinessSweepView>;
  /**
   * One pass for this organisation: settle what came back, then sweep what is due. The moment is a
   * parameter so a timetable can be tested at the hour it names rather than waited for; the
   * scheduler passes nothing and the clock answers.
   */
  run(now?: Date): Promise<SweepRun>;
}

interface SettingsRow {
  business_id: string; business_name: string; business_code: string; business_active: boolean;
  destination_phone: string | null; schedule: Schedule; hour: number; weekday: number;
  fee_percent_bp: number; fee_flat_cents: number; fee_floor_cents: string | number | null; fee_ceiling_cents: string | number | null;
  stopped: boolean | null; consented_at: Date | null;
}
interface SweepRow {
  id: string; window: string; schedule: Schedule; state: string;
  gross_cents: string; fee_cents: string; net_cents: string;
  destination_phone: string | null; reason_code: string | null; reason: string | null; gap_cents: string | null;
  request_id: string | null; request_status: string | null; receipt: string | null;
  sent_at: Date | null; created_at: Date;
}
interface PaymentRow { id: string; receipt: string | null; amount_cents: string; created_at: Date; type: string; full_number: string | null }

const NO_DESTINATION = 'No phone yet, so nothing is swept. Money paid to this business waits here until you name the number it should go to.';
const STOPPED_TEXT = 'Sweeping is stopped. The money stays here and is still owed.';
const BUSINESS_OFF = 'This business is switched off, so nothing is swept. The money stays here and is still owed.';
const FLOAT_UNKNOWN = 'Studio has not read the float yet, so nothing was sent. It asks for a reading and tries again.';
const FLOAT_STALE = 'The float figure is out of date, so nothing was sent. Studio has asked for a fresh one.';
const FLOAT_SHORT_WHY = 'short of the float, so the whole sweep was held and nothing was sent. It goes as one when the float covers it.';
const NO_CHARGE_BAND = 'Studio does not have Safaricom’s charge for this amount, so it will not guess at it. Check the B2C bands in Settings, then it goes.';

/** KES 1,234.50 when the cents matter, KES 1,234 otherwise. Whole shillings are the normal case. */
export function kes(cents: number): string {
  const n = cents / 100;
  return 'KES ' + (cents % 100 === 0 ? n.toLocaleString('en-KE') : n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('no organisation in scope');
  return orgId;
}

const toFeeView = (r: SettingsRow): FeeView => ({
  percentBp: Number(r.fee_percent_bp), flatCents: Number(r.fee_flat_cents),
  floorCents: r.fee_floor_cents === null ? null : Number(r.fee_floor_cents),
  ceilingCents: r.fee_ceiling_cents === null ? null : Number(r.fee_ceiling_cents),
});
const toRule = (f: FeeView): FeeRule => ({ percentBp: f.percentBp, flatCents: f.flatCents, floorCents: f.floorCents, ceilingCents: f.ceilingCents });
const toPayment = (r: PaymentRow): SweepPaymentView => ({
  id: r.id, receipt: r.receipt, amountCents: Number(r.amount_cents), at: r.created_at.toISOString(),
  accountNumber: r.full_number, type: r.type,
});

export function createSweepService(deps: {
  db: Db; settings: Settings; events: EventHub; fees: FeesService;
  moneyOut: Pick<MoneyOutService, 'send'>; modules: Pick<ModuleService, 'isOn'>;
}): SweepService {
  const org = requireOrg;

  /** Safaricom's own floor, changeable by the owner in Settings. Absent means the default. */
  async function minCents(): Promise<number> {
    const setting = await deps.settings.get(MIN_SETTING);
    const n = setting === null ? NaN : Number(setting);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_MIN_CENTS;
  }

  /**
   * The payments that arrived for one business, oldest first. Every kind of row that brings money
   * in counts, whichever door it came through; the business is the one the account number named.
   */
  async function paymentsIn(businessId: string): Promise<PaymentRow[]> {
    return deps.db.query<PaymentRow>(
      `SELECT r.id, r.receipt, r.amount_cents, r.created_at, r.type, a.full_number
         FROM requests r LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.org_id = $1 AND r.business_id = $2 AND r.status = 'completed' AND r.type = ANY($3)
        ORDER BY r.created_at ASC, r.id ASC`,
      [org(), businessId, MONEY_IN_TYPES]);
  }

  /** What the sweeps that claimed money add up to, and which payments they claimed. */
  async function claimed(businessId: string): Promise<{ grossCents: number; feesCents: number; paymentIds: string[] }> {
    const [sum] = await deps.db.query<{ gross: string; fee: string }>(
      `SELECT COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(fee_cents),0) AS fee
         FROM sweeps WHERE org_id = $1 AND business_id = $2 AND state = ANY($3)`,
      [org(), businessId, CLAIMED]);
    const rows = await deps.db.query<{ request_id: string }>(
      `SELECT sp.request_id FROM sweep_payments sp JOIN sweeps s ON s.id = sp.sweep_id
        WHERE sp.org_id = $1 AND s.business_id = $2 AND s.state = ANY($3)`,
      [org(), businessId, CLAIMED]);
    return { grossCents: Number(sum?.gross ?? 0), feesCents: Number(sum?.fee ?? 0), paymentIds: rows.map((r) => r.request_id) };
  }

  /**
   * What is owed to one business, and the payments that make it up. The figure is the sum above; the
   * list is the payments no claiming sweep has taken, which is the same money because every window
   * sweeps everything that is owed at that moment.
   */
  async function owedOf(businessId: string): Promise<OwedView> {
    const [payments, claim] = await Promise.all([paymentsIn(businessId), claimed(businessId)]);
    const taken = new Set(claim.paymentIds);
    const paidInCents = payments.reduce((sum, p) => sum + Number(p.amount_cents), 0);
    return {
      paidInCents, sweptCents: claim.grossCents, feesTakenCents: claim.feesCents,
      owedCents: paidInCents - claim.grossCents,
      payments: payments.filter((p) => !taken.has(p.id)).map(toPayment),
    };
  }

  async function settingsRows(): Promise<SettingsRow[]> {
    return deps.db.query<SettingsRow>(
      `SELECT b.id AS business_id, b.name AS business_name, b.code::text AS business_code, b.active AS business_active,
              s.destination_phone, COALESCE(s.schedule,'arrival') AS schedule, COALESCE(s.hour,20) AS hour, COALESCE(s.weekday,1) AS weekday,
              COALESCE(s.fee_percent_bp,0) AS fee_percent_bp, COALESCE(s.fee_flat_cents,0) AS fee_flat_cents,
              s.fee_floor_cents, s.fee_ceiling_cents, s.stopped, s.consented_at
         FROM businesses b LEFT JOIN sweep_settings s ON s.business_id = b.id
        WHERE b.org_id = $1 ORDER BY b.code ASC`, [org()]);
  }

  async function sweepsFor(businessId: string, limit = 20): Promise<SweepView[]> {
    const rows = await deps.db.query<SweepRow>(
      `SELECT s.id, s.window_key AS window, s.schedule, s.state, s.gross_cents, s.fee_cents, s.net_cents, s.destination_phone,
              s.reason_code, s.reason, s.gap_cents, s.request_id, r.status AS request_status, s.receipt, s.sent_at, s.created_at
         FROM sweeps s LEFT JOIN requests r ON r.id = s.request_id
        WHERE s.org_id = $1 AND s.business_id = $2
        -- The window breaks a tie, so two sweeps written in the same millisecond still read newest
        -- first, and a page never shows them the other way round from one refresh to the next.
        ORDER BY s.created_at DESC, s.window_key DESC LIMIT $3`, [org(), businessId, limit]);
    if (rows.length === 0) return [];
    const links = await deps.db.query<{ sweep_id: string; id: string; receipt: string | null; amount_cents: string; created_at: Date; type: string; full_number: string | null }>(
      `SELECT sp.sweep_id, r.id, r.receipt, r.amount_cents, r.created_at, r.type, a.full_number
         FROM sweep_payments sp JOIN requests r ON r.id = sp.request_id LEFT JOIN accounts a ON a.id = r.account_id
        WHERE sp.sweep_id = ANY($1::uuid[]) AND sp.org_id = $2 ORDER BY r.created_at ASC`, [rows.map((r) => r.id), org()]);
    const byId = new Map<string, SweepPaymentView[]>();
    for (const l of links) {
      const list = byId.get(l.sweep_id) ?? [];
      list.push(toPayment(l));
      byId.set(l.sweep_id, list);
    }
    return rows.map((r) => ({
      id: r.id, window: r.window, schedule: r.schedule, state: r.state,
      grossCents: Number(r.gross_cents), feeCents: Number(r.fee_cents), netCents: Number(r.net_cents),
      destinationPhone: r.destination_phone, reasonCode: r.reason_code, reason: r.reason,
      gapCents: r.gap_cents === null ? null : Number(r.gap_cents),
      requestId: r.request_id, requestStatus: r.request_status, receipt: r.receipt,
      sentAt: r.sent_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
      payments: byId.get(r.id) ?? [],
    }));
  }

  /** The newest float Studio has read, and when it read it. */
  async function float(): Promise<{ cents: number | null; at: Date | null }> {
    const [row] = await deps.db.query<{ utility_cents: string | null; queried_at: Date }>(
      `SELECT utility_cents, queried_at FROM balances WHERE org_id = $1 ORDER BY queried_at DESC LIMIT 1`, [org()]);
    return row ? { cents: row.utility_cents === null ? null : Number(row.utility_cents), at: row.queried_at } : { cents: null, at: null };
  }

  /**
   * Why nothing has left, when nothing has. The order is the order a person asks the questions in:
   * is it set up, is it stopped, is the business on, is there anything to send, is it worth sending,
   * is the float there, and has its window come round.
   */
  function waitingFor(row: SettingsRow, owed: OwedView, min: number, charge: number | null, floatCents: number | null, due: boolean): Waiting | null {
    if (!row.destination_phone) return { code: 'no_destination', text: NO_DESTINATION, gapCents: null };
    if (row.stopped) return { code: 'stopped', text: STOPPED_TEXT, gapCents: null };
    if (!row.business_active) return { code: 'business_off', text: BUSINESS_OFF, gapCents: null };
    if (owed.owedCents <= 0) return null;
    const timetable: Timetable = { schedule: row.schedule, hour: Number(row.hour), weekday: Number(row.weekday) };
    const net = netOf(owed.owedCents, toRule(toFeeView(row)));
    if (charge === null) return { code: 'no_charge_band', text: NO_CHARGE_BAND, gapCents: null };
    if (net < min + charge) {
      return { code: 'below_minimum', gapCents: null, text: 'Below the least Safaricom sends (' + kes(min) + ' plus its charge), so it waits and goes with the next sweep.' };
    }
    if (floatCents === null) return { code: 'float_unknown', text: FLOAT_UNKNOWN, gapCents: null };
    if (floatCents < net + charge) {
      const gap = net + charge - floatCents;
      return { code: 'float_short', text: kes(gap) + ' ' + FLOAT_SHORT_WHY, gapCents: gap };
    }
    if (!due) return { code: 'not_due', text: 'The next sweep is ' + timetableWords(timetable) + '.', gapCents: null };
    return null;
  }

  /** One business, read whole: its settings, what it is owed, and every sweep it has had. */
  async function view(row: SettingsRow, min: number, now: Date): Promise<BusinessSweepView> {
    const fee = toFeeView(row);
    const timetable: Timetable = { schedule: row.schedule, hour: Number(row.hour), weekday: Number(row.weekday) };
    const owed = await owedOf(row.business_id);
    const net = netOf(owed.owedCents, toRule(fee));
    const charge = owed.owedCents > 0 ? await deps.fees.chargeFor('b2c', net) : null;
    const f = await float();
    const { due } = windowFor(timetable, now);
    return {
      businessId: row.business_id, businessName: row.business_name, businessCode: row.business_code, active: row.business_active,
      destinationPhone: row.destination_phone, schedule: row.schedule, hour: Number(row.hour), weekday: Number(row.weekday),
      fee, stopped: row.stopped === true, consentedAt: row.consented_at?.toISOString() ?? null,
      timetable: timetableWords(timetable), owed, minCents: min,
      waiting: waitingFor(row, owed, min, charge, f.cents, due),
      sweeps: await sweepsFor(row.business_id),
    };
  }

  async function row(businessId: string): Promise<SettingsRow> {
    const rows = (await settingsRows()).filter((r) => r.business_id === businessId);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'That business does not exist.');
    return rows[0];
  }

  /** Has this window's money already gone, or is it on its way? A held or failed row for the same
   *  window has claimed nothing at all. */
  async function windowClaimed(businessId: string, window: string): Promise<boolean> {
    const [existing] = await deps.db.query<{ state: string }>(
      `SELECT state FROM sweeps WHERE org_id = $1 AND business_id = $2 AND window_key = $3`,
      [org(), businessId, window]);
    return existing !== undefined && CLAIMED.includes(existing.state);
  }

  /**
   * Write a sweep for one window, claim the payments it covers, hand it to Safaricom, and record
   * what came back. The row is written first and alone owns the window: the unique index on
   * (business_id, window_key) is what makes a second pass — or a second server — find it and stop.
   */
  async function sweepOne(row: SettingsRow, owed: OwedView, window: string, min: number, charge: number, actor: Actor | null): Promise<Attempt> {
    void min; void charge;
    const rule = toRule(toFeeView(row));
    const feeCents = feeFor(owed.owedCents, rule);
    const netCents = owed.owedCents - feeCents;
    const timetable: Timetable = { schedule: row.schedule, hour: Number(row.hour), weekday: Number(row.weekday) };
    const [created] = await deps.db.query<{ id: string }>(
      `INSERT INTO sweeps(org_id, business_id, window_key, schedule, state, gross_cents, fee_cents, net_cents, destination_phone)
       VALUES ($1,$2,$3,$4,'prepared',$5,$6,$7,$8)
       ON CONFLICT (business_id, window_key) DO NOTHING RETURNING id`,
      [org(), row.business_id, window, row.schedule, owed.owedCents, feeCents, netCents, row.destination_phone]);
    // Somebody else has this window. Whether that claims money depends on what their row says: a
    // sweep that is prepared, in flight or gone has taken it; a held or failed row has not, because
    // nothing left the account for those. The running float in the caller turns on this answer.
    if (!created) return { outcome: 'held', committed: await windowClaimed(row.business_id, window) };
    await deps.db.query(
      `INSERT INTO sweep_payments(sweep_id, request_id, org_id) SELECT $1, unnest($2::uuid[]), $3`,
      [created.id, owed.payments.map((p) => p.id), org()]);
    await deps.events.publish('sweep.created', { sweepId: created.id, businessId: row.business_id, window, grossCents: owed.owedCents, feeCents, netCents });
    try {
      const v = await deps.moneyOut.send({
        phone: row.destination_phone ?? '',
        amountCents: netCents,
        commandId: 'BusinessPayment',
        businessId: row.business_id,
        remarks: 'Sweep of ' + kes(owed.owedCents) + ' for ' + row.business_name + ', less ' + kes(feeCents) + ' fee (' + timetableWords(timetable) + ')',
        // The window is this sweep's own guard, and it is a stronger one than the five-minute
        // duplicate window: two sweeps of the same amount to the same phone in one day are
        // ordinary, and the guard would call the second one a mistake.
        confirmDuplicate: true,
      }, { personId: null, ip: 'studio' });
      const state = v.status === 'completed' ? 'sent' : v.status === 'failed' ? 'failed' : 'sending';
      await deps.db.query(
        `UPDATE sweeps SET state=$2, request_id=$3, receipt=COALESCE($4, receipt),
                sent_at=CASE WHEN $2='sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
                settled_at=CASE WHEN $2 IN ('sent','failed') THEN now() ELSE settled_at END,
                reason_code=CASE WHEN $2='failed' THEN 'send_failed' ELSE NULL END,
                reason=CASE WHEN $2='failed' THEN $5 ELSE NULL END, updated_at=now()
          WHERE id=$1 AND state='prepared'`,
        [created.id, state, v.id, v.receipt ?? null, v.meaning ?? 'Safaricom did not accept this sweep.']);
      await audit(deps.db, { personId: actor?.personId ?? null, action: 'sweep.sent', target: created.id, after: { window, grossCents: owed.owedCents, feeCents, netCents, state }, ip: actor?.ip });
      // Safaricom accepted it: the money is committed, whether or not the answer has come back yet.
      return state === 'failed' ? { outcome: 'failed', committed: false } : { outcome: 'sent', committed: true };
    } catch (e) {
      // Nothing was attempted, so this is a hold and not a failure: the money stays owed and the
      // next window carries it. A cap or a missing operator is the owner's to fix, and the page
      // and the alert say which it was.
      const known = e instanceof HttpError && ['over_cap', 'no_operator', 'public_url_unverified', 'business_inactive', 'whole_shillings'].includes(e.code);
      const text = e instanceof HttpError ? e.message : 'Studio could not send this sweep.';
      await deps.db.query(
        `UPDATE sweeps SET state=$2, reason_code=$3, reason=$4, settled_at=now(), updated_at=now() WHERE id=$1 AND state='prepared'`,
        [created.id, known ? 'held' : 'failed', e instanceof HttpError ? e.code : 'send_error', text]);
      await audit(deps.db, { personId: actor?.personId ?? null, action: 'sweep.held', target: created.id, after: { window, reason: text, code: e instanceof HttpError ? e.code : 'send_error' }, ip: actor?.ip });
      if (!known) console.error('sweep send failed', created.id, e instanceof Error ? e.message : e);
      // Nothing left the account either way, so neither answer takes anything off the float.
      return { outcome: known ? 'held' : 'failed', committed: false };
    }
  }

  /**
   * The held record for something that stopped the sweep before it was attempted — a short float, a
   * float nobody has read, an amount with no charge band. It is written once per run of the same
   * hold rather than once a tick: the row already says it, and nobody needs the same sentence every
   * five minutes. Writing it also sends the alert, so the owner hears about the first one.
   */
  async function hold(row: SettingsRow, owed: OwedView, gapCents: number, code: string, text: string, window: string, actor: Actor | null): Promise<boolean> {
    const [latest] = await deps.db.query<{ state: string; reason_code: string | null }>(
      `SELECT state, reason_code FROM sweeps WHERE org_id=$1 AND business_id=$2 ORDER BY created_at DESC LIMIT 1`, [org(), row.business_id]);
    if (latest && latest.state === 'held' && latest.reason_code === code) return false;
    const feeCents = feeFor(owed.owedCents, toRule(toFeeView(row)));
    const [created] = await deps.db.query<{ id: string }>(
      `INSERT INTO sweeps(org_id, business_id, window_key, schedule, state, gross_cents, fee_cents, net_cents, destination_phone, reason_code, reason, gap_cents, settled_at)
       VALUES ($1,$2,$3,$4,'held',$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT (business_id, window_key) DO NOTHING RETURNING id`,
      [org(), row.business_id, window, row.schedule, owed.owedCents, feeCents, owed.owedCents - feeCents, row.destination_phone, code, text, gapCents]);
    if (!created) return false;
    await deps.db.query(
      `INSERT INTO sweep_payments(sweep_id, request_id, org_id) SELECT $1, unnest($2::uuid[]), $3`,
      [created.id, owed.payments.map((p) => p.id), org()]);
    await audit(deps.db, { personId: actor?.personId ?? null, action: 'sweep.held', target: created.id, after: { window, code, gapCents, owedCents: owed.owedCents }, ip: actor?.ip });
    await deps.events.publish('alert', {
      kind: 'sweep_held', sweepId: created.id, businessId: row.business_id, businessName: row.business_name,
      code, gapCents, owedCents: owed.owedCents,
    });
    return true;
  }

  /**
   * Settle the sweeps that were waiting on an answer, from the ordinary money-out row that carried
   * each one. Nothing here talks to Safaricom: the row already knows, because the callback path and
   * the thirty-second sweep wrote it there.
   */
  async function reconcile(): Promise<void> {
    const rows = await deps.db.query<{ id: string; state: string; request_id: string | null; status: string | null; receipt: string | null; meaning: string | null; created_at: Date }>(
      `SELECT s.id, s.state, s.request_id, r.status, r.receipt, r.meaning, s.created_at
         FROM sweeps s LEFT JOIN requests r ON r.id = s.request_id
        WHERE s.org_id = $1 AND s.state IN ('prepared','sending')`, [org()]);
    for (const one of rows) {
      if (one.state === 'prepared') {
        // Written but never handed over, and long enough ago that nothing is still working on it.
        if (!one.request_id && Date.now() - one.created_at.getTime() > PREPARED_TIMEOUT_MS) {
          await deps.db.query(
            `UPDATE sweeps SET state='failed', reason_code='interrupted', reason='Studio stopped before this sweep was sent. The money is still owed and goes with the next sweep.', settled_at=now(), updated_at=now()
              WHERE id=$1 AND state='prepared'`, [one.id]);
        }
        continue;
      }
      if (!one.request_id || one.status === null) {
        await deps.db.query(
          `UPDATE sweeps SET state='failed', reason_code='lost', reason='This sweep has no payment behind it. The money is still owed and goes with the next sweep.', settled_at=now(), updated_at=now() WHERE id=$1 AND state='sending'`, [one.id]);
        continue;
      }
      if (one.status === 'completed') {
        await deps.db.query(
          `UPDATE sweeps SET state='sent', receipt=COALESCE(receipt, $2), sent_at=COALESCE(sent_at, now()), settled_at=now(), reason_code=NULL, reason=NULL, updated_at=now() WHERE id=$1 AND state='sending'`,
          [one.id, one.receipt]);
      } else if (['failed', 'rejected', 'cancelled'].includes(one.status)) {
        await deps.db.query(
          `UPDATE sweeps SET state='failed', reason_code='send_failed', reason=COALESCE($2, 'Safaricom did not accept this sweep.'), settled_at=now(), updated_at=now() WHERE id=$1 AND state='sending'`,
          [one.id, one.meaning]);
      }
      // Anything else is still in flight: the row keeps saying so, and nothing is sent twice.
    }
  }

  return {
    async list() {
      const min = await minCents();
      const now = new Date();
      const items: BusinessSweepView[] = [];
      for (const r of await settingsRows()) items.push(await view(r, min, now));
      return { items, minCents: min };
    },

    async one(businessId) {
      return view(await row(businessId), await minCents(), new Date());
    },

    async save(businessId, input, actor) {
      const before = await row(businessId);
      let phone: string | null = null;
      if (input.destinationPhone && input.destinationPhone.trim()) {
        try { phone = normalizePhone(input.destinationPhone); }
        catch { throw new HttpError(400, 'bad_phone', 'Enter a Kenyan mobile number such as 0712 345 678.'); }
      }
      const { percentBp, flatCents, floorCents, ceilingCents } = input.fee;
      const amounts = [percentBp, flatCents, floorCents ?? 0, ceilingCents ?? 0];
      if (!amounts.every((n) => Number.isInteger(n) && n >= 0)) throw new HttpError(400, 'bad_fee', 'The fee must be whole numbers, and none of them negative.');
      if (percentBp > 10_000) throw new HttpError(400, 'bad_fee', 'The fee cannot be more than the whole amount.');
      if (floorCents !== null && ceilingCents !== null && floorCents > ceilingCents) throw new HttpError(400, 'bad_fee', 'The least fee is more than the most. Swap them round.');
      const fee: FeeView = { percentBp, flatCents, floorCents, ceilingCents };
      // Consented once, the first time there is somewhere for the money to go. Later changes keep
      // the original consent: what the business agreed to was the arrangement, not one phone.
      const consent = before.consented_at ?? (phone ? new Date() : null);
      const was = toFeeView(before);
      const changed = before.destination_phone !== phone || before.schedule !== input.schedule
        || Number(before.hour) !== input.hour || Number(before.weekday) !== input.weekday
        || was.percentBp !== percentBp || was.flatCents !== flatCents
        || was.floorCents !== floorCents || was.ceilingCents !== ceilingCents;
      await deps.db.query(
        `INSERT INTO sweep_settings(org_id, business_id, destination_phone, schedule, hour, weekday, ` + FEE_COLUMNS + `, consented_at, consented_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         ON CONFLICT (business_id) DO UPDATE SET destination_phone=EXCLUDED.destination_phone, schedule=EXCLUDED.schedule,
           hour=EXCLUDED.hour, weekday=EXCLUDED.weekday, fee_percent_bp=EXCLUDED.fee_percent_bp,
           fee_flat_cents=EXCLUDED.fee_flat_cents, fee_floor_cents=EXCLUDED.fee_floor_cents,
           fee_ceiling_cents=EXCLUDED.fee_ceiling_cents, consented_at=EXCLUDED.consented_at,
           consented_by=COALESCE(sweep_settings.consented_by, EXCLUDED.consented_by), updated_at=now()`,
        [org(), businessId, phone, input.schedule, input.hour, input.weekday, percentBp, flatCents, floorCents, ceilingCents, consent, actor.personId]);
      if (changed) {
        await audit(deps.db, {
          personId: actor.personId, action: 'sweep.settings_changed', target: businessId, ip: actor.ip,
          before: { destinationPhone: before.destination_phone, schedule: before.schedule, hour: Number(before.hour), weekday: Number(before.weekday), fee: was },
          after: { destinationPhone: phone, schedule: input.schedule, hour: input.hour, weekday: input.weekday, fee },
        });
      }
      return view(await row(businessId), await minCents(), new Date());
    },

    async setStopped(businessId, stopped, actor) {
      const before = await row(businessId);
      await deps.db.query(
        `INSERT INTO sweep_settings(org_id, business_id, stopped, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (business_id) DO UPDATE SET stopped=EXCLUDED.stopped, updated_at=now()`,
        [org(), businessId, stopped]);
      if ((before.stopped === true) !== stopped) {
        await audit(deps.db, { personId: actor.personId, action: stopped ? 'sweep.stopped' : 'sweep.started', target: businessId, ip: actor.ip });
      }
      return view(await row(businessId), await minCents(), new Date());
    },

    async run(at) {
      // A module that is off is off for the scheduler too: turning sweep-through off must stop the
      // money moving, not only hide the page that says it is moving.
      if (!(await deps.modules.isOn('sweep'))) return { businesses: 0, sent: 0, held: 0, failed: 0, skipped: 0 };
      await reconcile();
      const min = await minCents();
      const now = at ?? new Date();
      const f = await float();
      const stale = f.at === null || f.cents === null || now.getTime() - f.at.getTime() > FLOAT_MAX_AGE_MS;
      // One reading serves every business in this pass. A figure nobody has read, or one too old to
      // trust, is asked for here — through the same debounced read the rest of Studio uses, never a
      // second path to Safaricom — and every business waits for it.
      if (stale) await scheduleBalanceRefresh(deps.db).catch(() => {});
      const out: SweepRun = { businesses: 0, sent: 0, held: 0, failed: 0, skipped: 0 };
      // Who is due, and what each of them would take. Nothing is sent and nothing is written here.
      const due: Due[] = [];
      for (const one of await settingsRows()) {
        if (!one.destination_phone || one.stopped || !one.business_active) continue;
        const timetable: Timetable = { schedule: one.schedule, hour: Number(one.hour), weekday: Number(one.weekday) };
        const { window, due: isDue } = windowFor(timetable, now);
        if (!isDue) continue;
        const owed = await owedOf(one.business_id);
        if (owed.owedCents <= 0) continue;
        const netCents = netOf(owed.owedCents, toRule(toFeeView(one)));
        due.push({
          row: one, owed, window, netCents, chargeCents: await deps.fees.chargeFor('b2c', netCents),
          // The payments are oldest first, so the first of them is when this business started
          // waiting. A business with a claimed sweep behind it dates from the money still unpaid.
          since: Date.parse(owed.payments[0]?.at ?? now.toISOString()),
        });
      }
      // Oldest money first. The float is one account for the whole paybill, so when it cannot cover
      // everybody the business that has been waiting longest goes first; a tie is broken by the
      // business code, so the same rows always come out in the same order.
      due.sort((a, b) => a.since - b.since || a.row.business_code.localeCompare(b.row.business_code));
      out.businesses = due.length;
      /**
       * What is left of the float for the businesses still to come. One reading starts the pass and
       * every sweep that goes out takes its own net and Safaricom's charge off it, so three
       * businesses owed amounts that each fit on their own cannot together take more than the
       * account holds. A sweep that was held or failed takes nothing off it: no money left for
       * those. Null means the reading is not one to send against, which holds everybody.
       */
      let remaining = stale ? null : f.cents;
      for (const d of due) {
        const { row: one, owed, window, netCents, chargeCents } = d;
        if (chargeCents === null) {
          // Never attempt what Studio cannot price: a hold says why, and the next window carries it.
          if (await hold(one, owed, 0, 'no_charge_band', NO_CHARGE_BAND, window, null)) out.held++;
          continue;
        }
        // Rule: never below what Safaricom allows. No row is written for this one — nothing was
        // attempted, and the page says why from the figures themselves rather than from a note.
        if (netCents < min + chargeCents) { out.skipped++; continue; }
        if (remaining === null) {
          const code = f.at === null || f.cents === null ? 'float_unknown' : 'float_stale';
          if (await hold(one, owed, 0, code, code === 'float_stale' ? FLOAT_STALE : FLOAT_UNKNOWN, window, null)) out.held++;
          continue;
        }
        // Rule: never more than the float — and never more than what is left of it after the
        // sweeps this same pass has already sent. The whole sweep is held, never a part of it, and
        // the gap is named against what is left rather than against the reading the pass began with.
        if (netCents + chargeCents > remaining) {
          const gap = netCents + chargeCents - remaining;
          if (await hold(one, owed, gap, 'float_short', kes(gap) + ' ' + FLOAT_SHORT_WHY, window, null)) out.held++;
          continue;
        }
        const attempt = await sweepOne(one, owed, window, min, chargeCents, null);
        // Sent, or a window another pass has already claimed: either way the money is spoken for,
        // and the next business in this pass is measured against what is left afterwards.
        if (attempt.committed) remaining -= netCents + chargeCents;
        if (attempt.outcome === 'sent') out.sent++; else if (attempt.outcome === 'held') out.held++; else out.failed++;
      }
      return out;
    },
  };
}
