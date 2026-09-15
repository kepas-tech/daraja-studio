import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { enqueue } from '../db/jobs.js';
import type { EventHub } from '../events/hub.js';
import type { Settings } from '../settings/store.js';
import { parseCategories } from '../settings/categories.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { parseBulk, type BulkError, type BulkRow } from './bulkParse.js';
import type { MoneyOutService } from './service.js';

export interface Actor { personId: string; ip: string }
export interface BulkResult { requestId?: string; status: string; error?: string; retriable?: boolean }
export interface BulkPlanView {
  id: string; category: string | null; rowCount: number; totalCents: number; status: 'sending' | 'done' | 'partly_done';
  createdAt: string; finishedAt: string | null; createdBy: { id: string; displayName: string } | null;
  rows: (BulkRow & { index: number; result: BulkResult | null; receipt: string | null; liveStatus: string | null })[];
}
export interface BulkCheck { rows: BulkRow[]; errors: BulkError[]; count: number; totalCents: number }
export interface BulkService {
  check(text: string): BulkCheck;
  create(text: string, category: string | undefined, actor: Actor): Promise<BulkPlanView>;
  list(): Promise<Omit<BulkPlanView, 'rows'>[]>;
  get(id: string): Promise<BulkPlanView>;
  /** The job: sends every row not yet decided, one at a time, in order. Safe to re-run. */
  drain(planId: string): Promise<void>;
  /** Re-queue the rows that failed for a reason worth trying again. */
  retry(id: string, actor: Actor): Promise<BulkPlanView>;
}

interface PlanRow {
  id: string; created_by: string | null; category: string | null; row_count: number; total_cents: string; status: 'sending' | 'done' | 'partly_done';
  rows: BulkRow[]; results: Record<string, BulkResult>; created_at: Date; finished_at: Date | null; created_by_name?: string | null;
}
const SELECT = `SELECT b.*, p.display_name AS created_by_name FROM bulk_plans b LEFT JOIN people p ON p.id = b.created_by`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A batch is bookkeeping over ordinary sends. Nothing here talks to Safaricom: every row goes
 * through `moneyOut.send()`, so the duplicate guard, the cap, the approval hold and the
 * three-line errors are exactly a single send's. The plan only remembers what happened to each.
 */
export function createBulkService(deps: { db: Db; settings: Settings; config: Config; events: EventHub; moneyOut: Pick<MoneyOutService, 'send'>; pauseMs?: number }): BulkService {
  const pauseMs = deps.pauseMs ?? 300;

  function checkText(text: string): BulkCheck {
    const { rows, errors } = parseBulk(text);
    const cap = deps.config.maxSendCents;
    if (cap !== null) for (const r of rows) if (r.amountCents > cap) errors.push({ line: r.line, message: `Over this studio's cap of KES ${cap / 100} per send.` });
    errors.sort((a, b) => a.line - b.line);
    return { rows, errors, count: rows.length, totalCents: rows.reduce((s, r) => s + r.amountCents, 0) };
  }

  async function toView(p: PlanRow, withRows: boolean): Promise<BulkPlanView> {
    const base = {
      id: p.id, category: p.category, rowCount: p.row_count, totalCents: Number(p.total_cents), status: p.status,
      createdAt: p.created_at.toISOString(), finishedAt: p.finished_at?.toISOString() ?? null,
      createdBy: p.created_by ? { id: p.created_by, displayName: p.created_by_name ?? '' } : null,
    };
    if (!withRows) return { ...base, rows: [] };
    const live = await deps.db.query<{ id: string; status: string; receipt: string | null; idx: string }>(
      `SELECT id, status, receipt, payload_json->>'bulkIndex' AS idx FROM requests WHERE bulk_plan_id=$1`, [p.id]);
    const byIndex = new Map(live.map((r) => [Number(r.idx), r]));
    return {
      ...base,
      rows: p.rows.map((r, index) => {
        const lr = byIndex.get(index);
        return { ...r, index, result: p.results[String(index)] ?? null, receipt: lr?.receipt ?? null, liveStatus: lr?.status ?? null };
      }),
    };
  }

  async function load(id: string): Promise<PlanRow> {
    const [p] = await deps.db.query<PlanRow>(`${SELECT} WHERE b.id=$1`, [id]);
    if (!p) throw new HttpError(404, 'not_found', 'That batch does not exist.');
    return p;
  }

  const svc: BulkService = {
    check: checkText,

    async create(text, category, actor) {
      const c = checkText(text);
      if (c.errors.length) throw new HttpError(400, 'bulk_invalid', 'Fix the rows marked in red first.', { errors: c.errors });
      if (c.rows.length === 0) throw new HttpError(400, 'bulk_empty', 'Paste or upload at least one row.');
      let cat: string | null = null;
      if (category) {
        const found = parseCategories(await deps.settings.get('send.categories')).find((k) => k.name.toLowerCase() === category.trim().toLowerCase());
        if (!found) throw new HttpError(400, 'unknown_category', 'That payment category no longer exists. Pick one from the list.');
        cat = found.name;
      }
      const [p] = await deps.db.query<{ id: string }>(
        `INSERT INTO bulk_plans(created_by, category, row_count, total_cents, rows) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
        [actor.personId, cat, c.rows.length, c.totalCents, JSON.stringify(c.rows)]);
      await audit(deps.db, { personId: actor.personId, action: 'bulk.created', target: p.id, after: { rows: c.rows.length, totalCents: c.totalCents, category: cat }, ip: actor.ip });
      await enqueue(deps.db, 'bulk_send', { planId: p.id }, { maxAttempts: 3 });
      return svc.get(p.id);
    },

    async list() {
      const rows = await deps.db.query<PlanRow>(`${SELECT} ORDER BY b.created_at DESC LIMIT 50`);
      return Promise.all(rows.map((p) => toView(p, false).then(({ rows: _r, ...rest }) => rest)));
    },

    async get(id) { return toView(await load(id), true); },

    async drain(planId) {
      const p = await load(planId);
      if (p.status !== 'sending') return;
      const results = { ...p.results };
      const actor = { personId: p.created_by ?? '', ip: 'bulk' };
      for (let i = 0; i < p.rows.length; i++) {
        if (results[String(i)]) continue;
        const r = p.rows[i];
        try {
          const v = await deps.moneyOut.send({ phone: r.phone, amountCents: r.amountCents, commandId: 'BusinessPayment', category: p.category ?? undefined, remarks: r.note ?? undefined, bulk: { planId, index: i } }, actor);
          results[String(i)] = { requestId: v.id, status: v.status };
        } catch (e) {
          // A refusal before Safaricom (duplicate of an earlier single send, cap, no operator): the
          // row is recorded and the batch goes on. Nothing here is a Safaricom answer.
          const msg = e instanceof HttpError ? e.message : 'Studio could not send this row.';
          const retriable = !(e instanceof HttpError && e.code === 'duplicate_recent');
          results[String(i)] = { status: 'failed', error: msg, retriable };
        }
        await deps.db.query(`UPDATE bulk_plans SET results=$2::jsonb WHERE id=$1`, [planId, JSON.stringify(results)]);
        await deps.events.publish('bulk.updated', { id: planId });
        if (i < p.rows.length - 1 && pauseMs > 0) await sleep(pauseMs);
      }
      const failed = Object.values(results).some((x) => x.status === 'failed');
      await deps.db.query(`UPDATE bulk_plans SET status=$2, finished_at=now() WHERE id=$1`, [planId, failed ? 'partly_done' : 'done']);
      await deps.events.publish('bulk.updated', { id: planId });
    },

    async retry(id, actor) {
      const p = await load(id);
      if (p.status === 'sending') throw new HttpError(409, 'still_sending', 'This batch is still being sent.');
      const results: Record<string, BulkResult> = {};
      let again = 0;
      for (const [k, v] of Object.entries(p.results)) {
        if (v.status === 'failed' && v.retriable !== false && !v.requestId) { again += 1; continue; }
        results[k] = v;
      }
      if (again === 0) throw new HttpError(409, 'nothing_to_retry', 'No row here can be tried again.');
      await deps.db.query(`UPDATE bulk_plans SET results=$2::jsonb, status='sending', finished_at=NULL WHERE id=$1`, [id, JSON.stringify(results)]);
      await audit(deps.db, { personId: actor.personId, action: 'bulk.retried', target: id, after: { rows: again }, ip: actor.ip });
      await enqueue(deps.db, 'bulk_send', { planId: id }, { maxAttempts: 3 });
      return svc.get(id);
    },
  };
  return svc;
}
