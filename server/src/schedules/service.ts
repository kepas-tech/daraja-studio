import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import type { FeesService } from '../fees/service.js';
import type { MoneyOutService } from '../money_out/service.js';
import type { ModuleService } from '../modules/service.js';
import type { PermissionKey } from '../permissions/catalog.js';
import { audit } from '../audit/log.js';
import { HttpError } from '../util/errors.js';
import { scheduleBalanceRefresh } from '../money_out/balanceRefresh.js';
import { FLOAT_MAX_AGE_MS, kes } from '../sweep/service.js';
import { NAIROBI_OFFSET_MS } from '../sweep/window.js';
import {
  addDays, isDue, nextOccurrence, payDateOf, timetableWords, todayNairobi, upcoming,
  type Every, type Timetable, type WeekendRule,
} from './timetable.js';

/**
 * Scheduled payments (design: scheduled-payments-design.md). Consent is taken once, when a schedule
 * is created, edited or resumed, behind the step-up and a warning that has to be accepted; from then
 * on each run goes out on its own through the ordinary money-out path, exactly as a person's send
 * would, so every rule around money out — operators, receipts, approvals, the sweep that settles a
 * lost answer — applies to it unchanged.
 *
 * What never goes on its own: a run the float cannot cover (nobody is paid, the gap is named), a
 * failed line (reported, never sent again by itself), and a date Studio was not running for.
 */
export const MODULE_KEY = 'scheduled_payments';
/** M-Pesa's least B2C payment. A phone line below it would be refused on every run. */
export const PHONE_MIN_CENTS = 1000;
/** A reading older than this is refreshed before a run goes, if there is time to wait for it. */
export const FRESH_FLOAT_MS = 60 * 60 * 1000;
/** How long past its hour a run waits for that fresh reading before using the one it has. */
export const FLOAT_WAIT_MS = 30 * 60 * 1000;
/** A run whose pay date is further back than this is not paid late on its own: the owner decides. */
export const MISSED_AFTER_DAYS = 2;

export const FLOAT_UNKNOWN = 'Studio has no recent reading of your balance, so nobody was paid. Refresh the balance on Home, then press Try again.';
export const MISSED = 'Studio was not running on this date, so it was not paid late on its own. Pay it by hand if it is still owed.';

export interface Actor { personId: string; ip: string }
export interface LineInput { contactId: string; amountCents: number; note?: string }
export interface ScheduleInput {
  name: string; every: Every; weekday: number; dayOfMonth: number; hour: number; weekendRule: WeekendRule;
  phoneCommand: 'SalaryPayment' | 'BusinessPayment'; startOn: string; endOn?: string | null; lines: LineInput[];
}

export interface LineView { id: string; contactId: string; name: string; kind: 'phone' | 'till' | 'paybill'; destination: string | null; accountReference: string | null; amountCents: number; note: string | null; gone: boolean }
export interface RunSummary { id: string; dueOn: string; payOn: string; state: string; totalCents: number; lineCount: number; reason: string | null; gapCents: number | null; createdAt: string; finishedAt: string | null }
export interface ScheduleView {
  id: string; name: string; state: string; every: Every; weekday: number; dayOfMonth: number; hour: number; weekendRule: WeekendRule;
  phoneCommand: string; startOn: string; endOn: string | null; words: string;
  totalCents: number; lines: LineView[]; nextPayOn: string | null; upcoming: string[];
  consentedBy: string | null; consentedAt: string; createdAt: string; lastRun: RunSummary | null;
}
export interface RunLineView { id: string; name: string; kind: string; destination: string; accountReference: string | null; amountCents: number; note: string | null; state: string; failure: string | null; requestId: string | null; receipt: string | null }
export interface RunView extends RunSummary { scheduleId: string; scheduleName: string; lines: RunLineView[] }
export interface Summary { active: number; paused: number; next: { id: string; name: string; totalCents: number; people: number; payOn: string } | null }
export interface PassResult { runs: number; sent: number; refused: number; missed: number }

export interface ScheduleService {
  list(): Promise<ScheduleView[]>;
  get(id: string): Promise<ScheduleView>;
  summary(): Promise<Summary>;
  /** The next three pay dates a timetable would give, from now: what the warning screen spells out. */
  preview(t: Omit<Timetable, 'endOn'> & { endOn?: string | null }, at?: Date): { words: string; payDates: string[] };
  /** The permissions a person needs to set up these lines: the send permission of each kind in it. */
  permissionsFor(lines: LineInput[]): Promise<PermissionKey[]>;
  create(input: ScheduleInput, actor: Actor, at?: Date): Promise<ScheduleView>;
  update(id: string, input: ScheduleInput, actor: Actor, at?: Date): Promise<ScheduleView>;
  pause(id: string, actor: Actor): Promise<ScheduleView>;
  resume(id: string, actor: Actor, at?: Date): Promise<ScheduleView>;
  stop(id: string, typedName: string, actor: Actor): Promise<ScheduleView>;
  runs(scheduleId: string): Promise<RunSummary[]>;
  run(runId: string): Promise<RunView>;
  /** Send a run the float refused, once the owner has topped up. */
  retry(runId: string, actor: Actor, at?: Date): Promise<RunView>;
  /** One scheduler pass for the organisation in scope. */
  pass(at?: Date): Promise<PassResult>;
}

interface ScheduleRow {
  id: string; name: string; every: Every; weekday: number; day_of_month: number; hour: number; weekend_rule: WeekendRule;
  phone_command: string; start_on: string; end_on: string | null; state: string; next_due_on: string | null;
  consented_by: string | null; consented_at: Date; created_by: string | null; created_at: Date;
}
interface LineRow { id: string; contact_id: string; amount_cents: string; note: string | null; position: number; name: string; kind: 'phone' | 'till' | 'paybill'; phone: string | null; shortcode: string | null; account_reference: string | null; deleted_at: Date | null }
interface RunRow { id: string; schedule_id: string; due_on: string; pay_on: string; state: string; total_cents: string; line_count: number; reason: string | null; gap_cents: string | null; created_at: Date; finished_at: Date | null }

const SCHEDULE_COLS = `id, name, every, weekday, day_of_month, hour, weekend_rule, phone_command, to_char(start_on,'YYYY-MM-DD') AS start_on,
  to_char(end_on,'YYYY-MM-DD') AS end_on, state, to_char(next_due_on,'YYYY-MM-DD') AS next_due_on, consented_by, consented_at, created_by, created_at`;
const RUN_COLS = `id, schedule_id, to_char(due_on,'YYYY-MM-DD') AS due_on, to_char(pay_on,'YYYY-MM-DD') AS pay_on, state, total_cents, line_count, reason, gap_cents, created_at, finished_at`;

const timetableOf = (s: Pick<ScheduleRow, 'every' | 'weekday' | 'day_of_month' | 'hour' | 'weekend_rule' | 'start_on' | 'end_on'>): Timetable => ({
  every: s.every, weekday: Number(s.weekday), dayOfMonth: Number(s.day_of_month), hour: Number(s.hour),
  weekendRule: s.weekend_rule, startOn: s.start_on, endOn: s.end_on,
});
const inputTimetable = (i: ScheduleInput): Timetable => ({
  every: i.every, weekday: i.weekday, dayOfMonth: i.dayOfMonth, hour: i.hour, weekendRule: i.weekendRule, startOn: i.startOn, endOn: i.endOn ?? null,
});
const runSummary = (r: RunRow): RunSummary => ({
  id: r.id, dueOn: r.due_on, payOn: r.pay_on, state: r.state, totalCents: Number(r.total_cents), lineCount: r.line_count,
  reason: r.reason, gapCents: r.gap_cents === null ? null : Number(r.gap_cents), createdAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
});

/**
 * The first payment still to come: the next nominal date whose pay moment has not passed. Creating
 * a schedule at ten for "today at nine" must not pay at once — the warning named future dates only.
 */
export function firstToCome(t: Timetable, now: Date): string | null {
  let n = nextOccurrence(t, todayNairobi(now));
  while (n && isDue(t, n, now)) n = nextOccurrence(t, addDays(n, 1));
  return n;
}

/** The instant a nominal date's payment falls due: its pay date at its hour, Nairobi time. */
const dueInstant = (t: Timetable, nominal: string): number =>
  Date.parse(payDateOf(t, nominal) + 'T00:00:00Z') + t.hour * 3_600_000 - NAIROBI_OFFSET_MS;

export function createScheduleService(deps: {
  db: Db; events: EventHub; fees: Pick<FeesService, 'chargeFor'>;
  moneyOut: Pick<MoneyOutService, 'send' | 'payBusiness'>; modules: Pick<ModuleService, 'isOn'>;
}): ScheduleService {
  const org = (): string => {
    const id = currentOrgId();
    if (!id) throw new Error('no organisation in scope');
    return id;
  };

  async function row(id: string): Promise<ScheduleRow> {
    const [s] = await deps.db.query<ScheduleRow>(`SELECT ${SCHEDULE_COLS} FROM schedules WHERE id=$1 AND org_id=$2`, [id, org()]);
    if (!s) throw new HttpError(404, 'not_found', 'That schedule does not exist.');
    return s;
  }

  async function linesOf(scheduleId: string): Promise<LineRow[]> {
    return deps.db.query<LineRow>(
      `SELECT l.id, l.contact_id, l.amount_cents, l.note, l.position, c.name, c.kind, c.phone, c.shortcode, c.account_reference, c.deleted_at
         FROM schedule_lines l JOIN contacts c ON c.id = l.contact_id
        WHERE l.schedule_id=$1 AND l.org_id=$2 ORDER BY l.position, l.id`, [scheduleId, org()]);
  }

  const lineView = (l: LineRow): LineView => ({
    id: l.id, contactId: l.contact_id, name: l.name, kind: l.kind, destination: l.kind === 'phone' ? l.phone : l.shortcode,
    accountReference: l.account_reference, amountCents: Number(l.amount_cents), note: l.note, gone: l.deleted_at !== null,
  });

  async function view(s: ScheduleRow): Promise<ScheduleView> {
    const t = timetableOf(s);
    const lines = (await linesOf(s.id)).map(lineView);
    const [last] = await deps.db.query<RunRow>(`SELECT ${RUN_COLS} FROM pay_runs WHERE schedule_id=$1 ORDER BY due_on DESC LIMIT 1`, [s.id]);
    const [consenter] = s.consented_by ? await deps.db.query<{ display_name: string }>('SELECT display_name FROM people WHERE id=$1', [s.consented_by]) : [];
    const coming = s.state === 'active' && s.next_due_on ? upcoming(t, s.next_due_on, 3).map((u) => u.payOn) : [];
    return {
      id: s.id, name: s.name, state: s.state, every: s.every, weekday: Number(s.weekday), dayOfMonth: Number(s.day_of_month), hour: Number(s.hour),
      weekendRule: s.weekend_rule, phoneCommand: s.phone_command, startOn: s.start_on, endOn: s.end_on, words: timetableWords(t),
      totalCents: lines.filter((l) => !l.gone).reduce((a, l) => a + l.amountCents, 0), lines,
      nextPayOn: coming[0] ?? null, upcoming: coming,
      consentedBy: consenter?.display_name ?? null, consentedAt: s.consented_at.toISOString(), createdAt: s.created_at.toISOString(),
      lastRun: last ? runSummary(last) : null,
    };
  }

  /** Every line checked before anything is written: a real, live contact, once, for a payable amount. */
  async function checkLines(lines: LineInput[]): Promise<{ id: string; kind: string }[]> {
    if (lines.length === 0) throw new HttpError(400, 'no_lines', 'Add at least one person or business to pay.');
    if (lines.length > 200) throw new HttpError(400, 'too_many_lines', 'A schedule pays at most 200 people. Split it into two.');
    const ids = lines.map((l) => l.contactId);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'duplicate_line', 'Each contact appears once in a schedule. Put the whole amount on one line.');
    const found = await deps.db.query<{ id: string; kind: string; name: string }>(
      `SELECT id, kind, name FROM contacts WHERE id = ANY($1::uuid[]) AND org_id=$2 AND deleted_at IS NULL`, [ids, org()]);
    for (const l of lines) {
      const c = found.find((f) => f.id === l.contactId);
      if (!c) throw new HttpError(400, 'unknown_contact', 'One of those contacts is gone. Pick them again.');
      if (!Number.isInteger(l.amountCents) || l.amountCents <= 0 || l.amountCents % 100 !== 0) throw new HttpError(400, 'bad_amount', 'Each amount is whole shillings, more than nothing.');
      if (c.kind === 'phone' && l.amountCents < PHONE_MIN_CENTS) throw new HttpError(400, 'below_minimum', `M-Pesa sends at least ${kes(PHONE_MIN_CENTS)} to a phone. ${c.name}'s line is less.`);
    }
    return found;
  }

  function checkTimetable(t: Timetable, now: Date): void {
    if (t.startOn < todayNairobi(now)) throw new HttpError(400, 'start_past', 'The first date cannot be in the past.');
    if (t.every === 'daily' && t.weekendRule === 'before') throw new HttpError(400, 'bad_weekend_rule', 'A daily schedule either pays every day or skips weekends.');
    if (t.every !== 'daily' && t.weekendRule === 'skip') throw new HttpError(400, 'bad_weekend_rule', 'Only a daily schedule can skip weekends.');
    if (!firstToCome(t, now)) throw new HttpError(400, 'nothing_to_pay', 'Those dates leave nothing to pay. Check the start and the end.');
  }

  async function writeLines(scheduleId: string, lines: LineInput[]): Promise<void> {
    await deps.db.query('DELETE FROM schedule_lines WHERE schedule_id=$1 AND org_id=$2', [scheduleId, org()]);
    let position = 0;
    for (const l of lines) {
      await deps.db.query(`INSERT INTO schedule_lines(schedule_id, contact_id, amount_cents, note, position) VALUES ($1,$2,$3,$4,$5)`,
        [scheduleId, l.contactId, l.amountCents, l.note?.trim() || null, position++]);
    }
  }

  // --- the pass ------------------------------------------------------------------------------

  interface Float { utilityCents: number | null; workingCents: number | null; at: Date | null }
  async function float(): Promise<Float> {
    const [b] = await deps.db.query<{ utility_cents: string | null; working_cents: string | null; queried_at: Date }>(
      `SELECT utility_cents, working_cents, queried_at FROM balances WHERE org_id=$1 ORDER BY queried_at DESC LIMIT 1`, [org()]);
    return b ? { utilityCents: b.utility_cents === null ? null : Number(b.utility_cents), workingCents: b.working_cents === null ? null : Number(b.working_cents), at: b.queried_at }
      : { utilityCents: null, workingCents: null, at: null };
  }

  interface SnapLine { id: string; kind: 'phone' | 'till' | 'paybill'; destination: string; account_reference: string | null; amount_cents: string; contact_id: string | null; note: string | null; payee_name: string }

  /** What each account must hold for this run: the amounts and Safaricom's charge on each. */
  async function needs(lines: SnapLine[]): Promise<{ utility: number; working: number; unpriced: boolean }> {
    let utility = 0; let working = 0; let unpriced = false;
    for (const l of lines) {
      const amount = Number(l.amount_cents);
      const charge = await deps.fees.chargeFor(l.kind === 'phone' ? 'b2c' : 'b2b', amount);
      if (charge === null) unpriced = true;
      if (l.kind === 'phone') utility += amount + (charge ?? 0); else working += amount + (charge ?? 0);
    }
    return { utility, working, unpriced };
  }

  async function refuse(run: { id: string }, s: ScheduleRow, code: string, reason: string, gapCents: number | null): Promise<void> {
    await deps.db.query(
      `UPDATE pay_runs SET state='refused', reason_code=$2, reason=$3, gap_cents=$4, finished_at=now(), updated_at=now() WHERE id=$1 AND state='prepared'`,
      [run.id, code, reason, gapCents]);
    await audit(deps.db, { personId: null, action: 'schedule.run_refused', target: run.id, after: { scheduleId: s.id, name: s.name, code, gapCents } });
    await deps.events.publish('alert', { kind: 'schedule_refused', runId: run.id, scheduleId: s.id, scheduleName: s.name, code, gapCents, reason });
  }

  /** Hand every line of a run to the ordinary money-out path, with nobody behind it. */
  async function sendLines(runId: string, s: ScheduleRow): Promise<number> {
    const lines = await deps.db.query<SnapLine & { state: string }>(
      `SELECT id, payee_kind AS kind, destination, account_reference, amount_cents, contact_id, note, payee_name, state FROM pay_run_lines WHERE run_id=$1 ORDER BY position`, [runId]);
    await deps.db.query(`UPDATE pay_runs SET state='sending', started_at=COALESCE(started_at, now()), updated_at=now() WHERE id=$1 AND state='prepared'`, [runId]);
    let sent = 0;
    const who = { personId: null, ip: 'studio' };
    const remarks = (l: SnapLine) => (l.note || s.name).slice(0, 100);
    for (const l of lines) {
      if (l.state !== 'waiting') continue;
      try {
        // The run is this payment's own guard, keyed on the schedule and the date, which is stronger
        // than the five-minute duplicate window: the same wage to the same person every day is the
        // point of a schedule, and the window would call the second day a mistake.
        const v = l.kind === 'phone'
          ? await deps.moneyOut.send({ phone: l.destination, amountCents: Number(l.amount_cents), commandId: s.phone_command as 'SalaryPayment' | 'BusinessPayment', contactId: l.contact_id ?? undefined, remarks: remarks(l), confirmDuplicate: true }, who)
          : await deps.moneyOut.payBusiness({ to: l.kind, shortcode: l.destination, accountReference: l.account_reference ?? undefined, amountCents: Number(l.amount_cents), contactId: l.contact_id ?? undefined, remarks: remarks(l), confirmDuplicate: true }, who);
        const state = v.status === 'completed' ? 'paid' : v.status === 'failed' || v.status === 'rejected' ? 'failed' : v.status === 'unknown' ? 'unknown' : 'sent';
        await deps.db.query(`UPDATE pay_run_lines SET state=$2, request_id=$3, failure=$4 WHERE id=$1`, [l.id, state, v.id, state === 'failed' ? (v.meaning ?? v.safaricomSaid ?? 'Safaricom did not accept this payment.') : null]);
        if (state !== 'failed') sent++;
      } catch (e) {
        // Nothing reached Safaricom for this line: a missing operator, a contact that changed, a cap.
        // It is reported on the run and never tried again by itself.
        const text = e instanceof HttpError ? e.message : 'Studio could not send this payment.';
        if (!(e instanceof HttpError)) console.error('scheduled line failed before Safaricom', l.id, e instanceof Error ? e.message : e);
        await deps.db.query(`UPDATE pay_run_lines SET state='failed', failure=$2 WHERE id=$1`, [l.id, text]);
      }
    }
    return sent;
  }

  /** Settle runs that were waiting on answers, from the money-out rows that carried each line. */
  async function reconcile(): Promise<void> {
    const live = await deps.db.query<{ id: string; schedule_id: string }>(`SELECT id, schedule_id FROM pay_runs WHERE org_id=$1 AND state='sending'`, [org()]);
    for (const r of live) {
      await deps.db.query(
        `UPDATE pay_run_lines l SET
            state = CASE WHEN q.status='completed' THEN 'paid' WHEN q.status IN ('failed','rejected','cancelled') THEN 'failed' WHEN q.status='unknown' THEN 'unknown' ELSE l.state END,
            failure = CASE WHEN q.status IN ('failed','rejected','cancelled') THEN COALESCE(q.meaning, q.result_desc, 'Safaricom did not accept this payment.') ELSE l.failure END
           FROM requests q WHERE q.id = l.request_id AND l.run_id=$1 AND l.state IN ('sent','unknown')`, [r.id]);
      const [c] = await deps.db.query<{ open: string; failed: string; total: string }>(
        `SELECT count(*) FILTER (WHERE state IN ('waiting','sent')) AS open, count(*) FILTER (WHERE state='failed') AS failed, count(*) AS total FROM pay_run_lines WHERE run_id=$1`, [r.id]);
      if (Number(c.open) > 0) continue;
      const failed = Number(c.failed); const total = Number(c.total);
      const state = failed === 0 ? 'done' : failed === total ? 'failed' : 'partly_failed';
      const [done] = await deps.db.query<RunRow & { name: string }>(
        `UPDATE pay_runs p SET state=$2, finished_at=now(), updated_at=now() FROM schedules s WHERE p.id=$1 AND p.state='sending' AND s.id=p.schedule_id
         RETURNING p.id, p.total_cents, p.line_count, s.name`, [r.id, state]);
      // Every run tells the owner afterwards: the total, how many, and anything that failed.
      if (done) await deps.events.publish('alert', { kind: 'schedule_run', runId: r.id, scheduleId: r.schedule_id, scheduleName: done.name, state, totalCents: Number(done.total_cents), lines: total, failed });
    }
  }

  /** Check the float for a prepared run and, when it covers the whole run, send it. */
  async function attempt(runId: string, s: ScheduleRow, f: Float, remaining: { utility: number | null; working: number | null }, now: Date): Promise<'sent' | 'refused'> {
    const lines = await deps.db.query<SnapLine>(
      `SELECT id, payee_kind AS kind, destination, account_reference, amount_cents, contact_id, note, payee_name FROM pay_run_lines WHERE run_id=$1 AND state='waiting'`, [runId]);
    const need = await needs(lines);
    if (need.unpriced) {
      await refuse({ id: runId }, s, 'no_charge_band', 'Studio has no Safaricom charge for one of these amounts, so nobody was paid. Add the band on the Safaricom’s charges page, then press Try again.', null);
      return 'refused';
    }
    const stale = f.at === null || now.getTime() - f.at.getTime() > FLOAT_MAX_AGE_MS;
    if (stale || (need.utility > 0 && remaining.utility === null) || (need.working > 0 && remaining.working === null)) {
      await scheduleBalanceRefresh(deps.db).catch(() => {});
      await refuse({ id: runId }, s, 'float_unknown', FLOAT_UNKNOWN, null);
      return 'refused';
    }
    // Rule: a short float refuses the whole run. Paying eleven of fourteen workers is worse than
    // paying none and being told.
    const utilityGap = need.utility - (remaining.utility ?? 0);
    const workingGap = need.working - (remaining.working ?? 0);
    if (utilityGap > 0 || workingGap > 0) {
      const parts: string[] = [];
      if (utilityGap > 0) parts.push(`Utility is ${kes(utilityGap)} short for the phones`);
      if (workingGap > 0) parts.push(`Working is ${kes(workingGap)} short for the businesses`);
      await refuse({ id: runId }, s, 'float_short', parts.join(', and ') + ', so nobody was paid. Top up, then press Try again.', Math.max(utilityGap, 0) + Math.max(workingGap, 0));
      return 'refused';
    }
    if (remaining.utility !== null) remaining.utility -= need.utility;
    if (remaining.working !== null) remaining.working -= need.working;
    await sendLines(runId, s);
    return 'sent';
  }

  async function runView(runId: string): Promise<RunView> {
    const [r] = await deps.db.query<RunRow & { name: string }>(
      `SELECT p.id, p.schedule_id, to_char(p.due_on,'YYYY-MM-DD') AS due_on, to_char(p.pay_on,'YYYY-MM-DD') AS pay_on, p.state, p.total_cents, p.line_count,
              p.reason, p.gap_cents, p.created_at, p.finished_at, s.name
         FROM pay_runs p JOIN schedules s ON s.id=p.schedule_id WHERE p.id=$1 AND p.org_id=$2`, [runId, org()]);
    if (!r) throw new HttpError(404, 'not_found', 'That pay run does not exist.');
    const lines = await deps.db.query<{ id: string; payee_name: string; payee_kind: string; destination: string; account_reference: string | null; amount_cents: string; note: string | null; state: string; failure: string | null; request_id: string | null; receipt: string | null }>(
      `SELECT l.id, l.payee_name, l.payee_kind, l.destination, l.account_reference, l.amount_cents, l.note, l.state, l.failure, l.request_id, q.receipt
         FROM pay_run_lines l LEFT JOIN requests q ON q.id = l.request_id WHERE l.run_id=$1 ORDER BY l.position`, [runId]);
    return {
      ...runSummary(r), scheduleId: r.schedule_id, scheduleName: r.name,
      lines: lines.map((l) => ({ id: l.id, name: l.payee_name, kind: l.payee_kind, destination: l.destination, accountReference: l.account_reference, amountCents: Number(l.amount_cents), note: l.note, state: l.state, failure: l.failure, requestId: l.request_id, receipt: l.receipt })),
    };
  }

  return {
    async list() {
      const rows = await deps.db.query<ScheduleRow>(`SELECT ${SCHEDULE_COLS} FROM schedules WHERE org_id=$1 ORDER BY (state='active') DESC, created_at DESC`, [org()]);
      return Promise.all(rows.map(view));
    },
    async get(id) { return view(await row(id)); },

    async summary() {
      const rows = await deps.db.query<ScheduleRow>(`SELECT ${SCHEDULE_COLS} FROM schedules WHERE org_id=$1 AND state IN ('active','paused')`, [org()]);
      const active = rows.filter((r) => r.state === 'active' && r.next_due_on);
      let next: Summary['next'] = null;
      for (const s of active) {
        const payOn = payDateOf(timetableOf(s), s.next_due_on!);
        if (next && next.payOn <= payOn) continue;
        const lines = (await linesOf(s.id)).filter((l) => !l.deleted_at);
        next = { id: s.id, name: s.name, payOn, people: lines.length, totalCents: lines.reduce((a, l) => a + Number(l.amount_cents), 0) };
      }
      return { active: rows.filter((r) => r.state === 'active').length, paused: rows.filter((r) => r.state === 'paused').length, next };
    },

    preview(t, at = new Date()) {
      const full: Timetable = { ...t, endOn: t.endOn ?? null };
      const first = firstToCome(full, at);
      return { words: timetableWords(full), payDates: first ? upcoming(full, first, 3).map((u) => u.payOn) : [] };
    },

    async permissionsFor(lines) {
      const kinds = await deps.db.query<{ kind: string }>(`SELECT DISTINCT kind FROM contacts WHERE id = ANY($1::uuid[]) AND org_id=$2`, [lines.map((l) => l.contactId), org()]);
      return kinds.map((k) => (k.kind === 'phone' ? 'send.phone' : k.kind === 'till' ? 'pay.till' : 'pay.paybill') as PermissionKey);
    },

    async create(input, actor, at = new Date()) {
      const t = inputTimetable(input);
      checkTimetable(t, at);
      await checkLines(input.lines);
      const first = firstToCome(t, at);
      const id = await deps.db.tx(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO schedules(name, every, weekday, day_of_month, hour, weekend_rule, phone_command, start_on, end_on, next_due_on, consented_by, consented_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$11) RETURNING id`,
          [input.name.trim(), t.every, t.weekday, t.dayOfMonth, t.hour, t.weekendRule, input.phoneCommand, t.startOn, t.endOn, first, actor.personId]);
        return rows[0].id;
      });
      await writeLines(id, input.lines);
      const v = await view(await row(id));
      await audit(deps.db, { personId: actor.personId, action: 'schedule.created', target: id, ip: actor.ip,
        after: { name: v.name, words: v.words, totalCents: v.totalCents, lines: v.lines.length, firstPayOn: v.nextPayOn, consented: true } });
      return v;
    },

    async update(id, input, actor, at = new Date()) {
      const s = await row(id);
      if (s.state !== 'active' && s.state !== 'paused') throw new HttpError(409, 'schedule_closed', 'This schedule is stopped. Make a new one instead.');
      const t = inputTimetable(input);
      if (t.startOn !== s.start_on) checkTimetable(t, at); else if (!firstToCome(t, at)) throw new HttpError(400, 'nothing_to_pay', 'Those dates leave nothing to pay. Check the start and the end.');
      await checkLines(input.lines);
      const before = await view(s);
      // An edit is consent again: the person who changed it accepted the new warning. A run already
      // prepared is left exactly as it was — it holds its own copy of every line.
      await deps.db.query(
        `UPDATE schedules SET name=$2, every=$3, weekday=$4, day_of_month=$5, hour=$6, weekend_rule=$7, phone_command=$8, start_on=$9, end_on=$10,
            next_due_on=CASE WHEN state='active' THEN $11::date ELSE next_due_on END, consented_by=$12, consented_at=now(), updated_at=now()
          WHERE id=$1 AND org_id=$13`,
        [id, input.name.trim(), t.every, t.weekday, t.dayOfMonth, t.hour, t.weekendRule, input.phoneCommand, t.startOn, t.endOn, firstToCome(t, at), actor.personId, org()]);
      await writeLines(id, input.lines);
      const after = await view(await row(id));
      await audit(deps.db, { personId: actor.personId, action: 'schedule.edited', target: id, ip: actor.ip,
        before: { name: before.name, words: before.words, totalCents: before.totalCents, lines: before.lines.length },
        after: { name: after.name, words: after.words, totalCents: after.totalCents, lines: after.lines.length, consented: true } });
      return after;
    },

    async pause(id, actor) {
      const [s] = await deps.db.query<{ id: string }>(`UPDATE schedules SET state='paused', updated_at=now() WHERE id=$1 AND org_id=$2 AND state='active' RETURNING id`, [id, org()]);
      if (!s) { await row(id); throw new HttpError(409, 'not_active', 'Only a schedule that is on can be paused.'); }
      await audit(deps.db, { personId: actor.personId, action: 'schedule.paused', target: id, ip: actor.ip });
      return view(await row(id));
    },

    async resume(id, actor, at = new Date()) {
      const s = await row(id);
      if (s.state !== 'paused') throw new HttpError(409, 'not_paused', 'Only a paused schedule can be turned back on.');
      // Nothing is paid for the dates it was paused over: it picks up at the next date to come.
      const first = firstToCome(timetableOf(s), at);
      if (!first) throw new HttpError(409, 'nothing_to_pay', 'This schedule has no dates left. Edit its end date first.');
      await deps.db.query(`UPDATE schedules SET state='active', next_due_on=$2, consented_by=$3, consented_at=now(), updated_at=now() WHERE id=$1 AND state='paused'`, [id, first, actor.personId]);
      await audit(deps.db, { personId: actor.personId, action: 'schedule.resumed', target: id, ip: actor.ip, after: { nextDueOn: first, consented: true } });
      return view(await row(id));
    },

    async stop(id, typedName, actor) {
      const s = await row(id);
      if (s.state === 'stopped') throw new HttpError(409, 'already_stopped', 'This schedule is already stopped.');
      if (typedName.trim().toLowerCase() !== s.name.trim().toLowerCase()) throw new HttpError(400, 'name_mismatch', 'Type the schedule’s name exactly to stop it.');
      await deps.db.query(`UPDATE schedules SET state='stopped', next_due_on=NULL, stopped_at=now(), stopped_by=$2, updated_at=now() WHERE id=$1`, [id, actor.personId]);
      await audit(deps.db, { personId: actor.personId, action: 'schedule.stopped', target: id, ip: actor.ip, before: { state: s.state } });
      return view(await row(id));
    },

    async runs(scheduleId) {
      await row(scheduleId);
      return (await deps.db.query<RunRow>(`SELECT ${RUN_COLS} FROM pay_runs WHERE schedule_id=$1 ORDER BY due_on DESC LIMIT 60`, [scheduleId])).map(runSummary);
    },

    run: runView,

    async retry(runId, actor, at = new Date()) {
      const [r] = await deps.db.query<{ schedule_id: string; state: string }>(`SELECT schedule_id, state FROM pay_runs WHERE id=$1 AND org_id=$2`, [runId, org()]);
      if (!r) throw new HttpError(404, 'not_found', 'That pay run does not exist.');
      if (r.state !== 'refused') throw new HttpError(409, 'not_refused', 'Only a run the float held back can be tried again.');
      if (!(await deps.modules.isOn(MODULE_KEY))) throw new HttpError(409, 'module_off', 'Scheduled payments is switched off.');
      const s = await row(r.schedule_id);
      // Back to prepared on one atomic flip, so two presses cannot send it twice.
      const [flipped] = await deps.db.query<{ id: string }>(
        `UPDATE pay_runs SET state='prepared', reason_code=NULL, reason=NULL, gap_cents=NULL, finished_at=NULL, updated_at=now() WHERE id=$1 AND state='refused' RETURNING id`, [runId]);
      if (!flipped) throw new HttpError(409, 'not_refused', 'Only a run the float held back can be tried again.');
      await audit(deps.db, { personId: actor.personId, action: 'schedule.run_retried', target: runId, ip: actor.ip, after: { scheduleId: s.id } });
      const f = await float();
      await attempt(runId, s, f, { utility: f.utilityCents, working: f.workingCents }, at);
      await reconcile();
      return runView(runId);
    },

    async pass(at = new Date()) {
      const out: PassResult = { runs: 0, sent: 0, refused: 0, missed: 0 };
      // A module that is off is off for the scheduler too: turning it off stops the money, not only
      // the screens, and every schedule is kept for when it comes back on.
      if (!(await deps.modules.isOn(MODULE_KEY))) return out;
      await reconcile();
      const due = await deps.db.query<ScheduleRow>(
        `SELECT ${SCHEDULE_COLS} FROM schedules WHERE org_id=$1 AND state='active' AND next_due_on IS NOT NULL ORDER BY next_due_on, created_at`, [org()]);
      const f = await float();
      // One reading serves the pass; every run that goes takes its own amounts off what is left, so
      // two schedules that each fit cannot together take more than the account holds.
      const remaining = { utility: f.utilityCents, working: f.workingCents };
      const today = todayNairobi(at);
      for (const s of due) {
        const t = timetableOf(s);
        const nominal = s.next_due_on!;
        if (!isDue(t, nominal, at)) continue;
        const payOn = payDateOf(t, nominal);
        const advance = async () => {
          const next = nextOccurrence(t, addDays(nominal, 1));
          await deps.db.query(`UPDATE schedules SET next_due_on=$2, state=CASE WHEN $2::date IS NULL THEN 'finished' ELSE state END, updated_at=now() WHERE id=$1 AND next_due_on=$3::date`, [s.id, next, nominal]);
        };
        // A reading more than an hour old is refreshed first, and the run waits up to half an hour
        // past its time for it. After that it goes on the reading it has, or is refused.
        const fresh = f.at !== null && at.getTime() - f.at.getTime() <= FRESH_FLOAT_MS;
        const missed = payOn < addDays(today, -MISSED_AFTER_DAYS);
        if (!fresh && !missed && at.getTime() < dueInstant(t, nominal) + FLOAT_WAIT_MS) {
          await scheduleBalanceRefresh(deps.db).catch(() => {});
          continue;
        }
        const lines = await linesOf(s.id);
        const total = lines.filter((l) => !l.deleted_at).reduce((a, l) => a + Number(l.amount_cents), 0);
        const [run] = await deps.db.query<{ id: string }>(
          `INSERT INTO pay_runs(schedule_id, due_on, pay_on, state, total_cents, line_count, reason_code, reason, finished_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (schedule_id, due_on) DO NOTHING RETURNING id`,
          [s.id, nominal, payOn, missed ? 'missed' : 'prepared', total, lines.length, missed ? 'missed' : null, missed ? MISSED : null, missed ? at : null]);
        await advance();
        // Another pass has this date already: nothing more to do here, whatever it did.
        if (!run) continue;
        out.runs++;
        if (missed) {
          out.missed++;
          await audit(deps.db, { personId: null, action: 'schedule.run_missed', target: run.id, after: { scheduleId: s.id, name: s.name, dueOn: nominal } });
          await deps.events.publish('alert', { kind: 'schedule_missed', runId: run.id, scheduleId: s.id, scheduleName: s.name, payOn });
          continue;
        }
        // A copy of every line as it stands today; a contact deleted since the schedule was made is
        // reported as a failed line rather than silently dropped.
        let position = 0;
        for (const l of lines) {
          const destination = l.kind === 'phone' ? l.phone : l.shortcode;
          const gone = l.deleted_at !== null || !destination;
          await deps.db.query(
            `INSERT INTO pay_run_lines(run_id, contact_id, payee_name, payee_kind, destination, account_reference, amount_cents, note, position, state, failure)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [run.id, l.contact_id, l.name, l.kind, destination ?? '', l.kind === 'paybill' ? l.account_reference : null, l.amount_cents, l.note, position++,
              gone ? 'failed' : 'waiting', gone ? 'This contact was deleted, so this line was not paid.' : null]);
        }
        // Rule: a due run sends with nobody present, and the audit names the schedule and the person
        // who consented to it.
        await audit(deps.db, { personId: null, action: 'schedule.run', target: run.id,
          after: { scheduleId: s.id, name: s.name, dueOn: nominal, payOn, totalCents: total, lines: lines.length, createdBy: s.created_by, consentedBy: s.consented_by } });
        const outcome = await attempt(run.id, s, f, remaining, at);
        if (outcome === 'sent') out.sent++; else out.refused++;
      }
      await reconcile();
      return out;
    },
  };
}
