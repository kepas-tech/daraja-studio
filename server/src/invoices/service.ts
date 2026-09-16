import { DarajaAPIError, DarajaAuthError, DarajaConnectionError, normalizePhone, type BillManagerPayment } from '@kepas/daraja-js';
import { currentOrgId, withOrg, type Db } from '../db/pool.js';
import type { Settings, Env } from '../settings/store.js';
import type { DarajaFactory } from '../sdk/client.js';
import type { EventHub } from '../events/hub.js';
import type { OrgService } from '../orgs/service.js';
import { currentCallbackSecret } from '../orgs/secret.js';
import { callbackUrls } from '../sdk/callbackUrls.js';
import { explain } from '../sdk/meaning.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { PUBLIC_URL_UNVERIFIED } from '../money_out/ready.js';
import { syncRejection } from '../money_out/service.js';
import { parseInvoices, type InvoiceRow, type InvoiceRowError } from './parse.js';

export interface Actor { personId: string; ip: string }
export interface OptInInput { email: string; officialContact: string; sendReminders: boolean; logo?: string }
export interface InvoiceInput { customerName: string; customerPhone: string; invoiceName: string; accountReference: string; billedPeriod: string; dueDate: string; amountCents: number; items?: { name: string; amountCents: number }[] }
export interface PaymentInput { paymentDate: string; amountCents: number; reference: string; payer: string }
export type InvoiceStatus = 'sent' | 'partly_paid' | 'paid' | 'cancelled' | 'overdue';
export interface InvoiceView {
  id: string; reference: string; customerName: string; customerPhone: string; invoiceName: string; accountReference: string; billedPeriod: string; dueDate: string;
  amountCents: number; paidCents: number; items: { name: string; amountCents: number }[]; status: InvoiceStatus; stored: 'sent' | 'partly_paid' | 'paid' | 'cancelled';
  createdBy: { id: string; displayName: string } | null; sentAt: string; paidAt: string | null; cancelledAt: string | null;
  payments: { id: string; amountCents: number; receipt: string | null; at: string; source: 'callback' | 'manual' }[];
}
export interface InvoicesSettingsView {
  mode: Env; optedIn: boolean; optedInAt: string | null; email: string | null; phone: string | null; reminders: boolean; publicVerified: boolean;
  /** The opt-in is in flight (started within the last two minutes and not yet finished). */
  registering: boolean;
  /** Safaricom's refusal, three lines joined, from the last attempt; null once it worked. */
  lastError: string | null;
}
export interface InvoicesService {
  settings(): Promise<InvoicesSettingsView>;
  optIn(input: OptInInput, actor: Actor): Promise<InvoicesSettingsView>;
  /** The Safaricom call behind optIn; runs after optIn has answered. */
  runOptIn(input: OptInInput, actor: Actor): Promise<void>;
  create(input: InvoiceInput, actor: Actor): Promise<InvoiceView>;
  checkBulk(text: string): { rows: InvoiceRow[]; errors: InvoiceRowError[]; count: number; totalCents: number };
  createBulk(text: string, actor: Actor): Promise<{ count: number }>;
  list(filter: 'open' | 'paid' | 'overdue' | 'cancelled' | 'all', q?: string): Promise<Omit<InvoiceView, 'payments'>[]>;
  get(id: string): Promise<InvoiceView>;
  cancel(ids: string[], actor: Actor): Promise<number>;
  recordPayment(id: string, input: PaymentInput, actor: Actor): Promise<InvoiceView>;
  /** The payment push from Bill Manager. Idempotent on the transaction id. */
  applyPush(p: BillManagerPayment): Promise<{ verdict: 'applied' | 'duplicate' | 'unmatched'; requestId?: string }>;
  unmatched(): Promise<{ id: string; amountCents: number; receipt: string | null; accountReference: string | null; at: string }[]>;
}

export const NOT_OPTED_IN = 'Set up invoicing with Safaricom first, under Invoices.';
export const BILL_MANAGER_NOT_ALLOWED = {
  safaricomSaid: 'Safaricom answered "not allowed" (HTTP 401) to the Bill Manager set-up.',
  meaning: 'Your Daraja key works for everything else, so Safaricom is refusing Bill Manager for this app or this paybill, not the key.',
  whatToDo: 'On the Daraja portal open My Apps, your Production app, then Update App, and make sure Bill Manager is ticked. If it already is, email apisupport@safaricom.co.ke with your paybill number asking for Bill Manager to be enabled, then press Set up invoicing again.',
};
export const ALREADY_PAID = 'A paid invoice cannot be cancelled.';

interface Row {
  id: string; seq: number; external_reference: string; customer_name: string; customer_phone: string; invoice_name: string; account_reference: string; billed_period: string;
  due_date: string; amount_cents: string; items: { name: string; amountCents: number }[]; status: 'sent' | 'partly_paid' | 'paid' | 'cancelled'; paid_cents: string;
  created_by: string | null; created_by_name?: string | null; sent_at: Date; paid_at: Date | null; cancelled_at: Date | null;
}
const SELECT = `SELECT i.*, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, p.display_name AS created_by_name FROM customer_invoices i LEFT JOIN people p ON p.id = i.created_by`;
const todayNairobi = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);

/**
 * Safaricom Bill Manager: the studio opts in once per environment (the app key comes back and is
 * kept encrypted), then sends invoices by SMS through Safaricom, hears about payments on its own
 * callback, and can cancel what is unpaid or record a payment made another way so reminders stop.
 */
export function createInvoicesService(deps: { db: Db; settings: Settings; daraja: DarajaFactory; events: EventHub; orgs: OrgService }): InvoicesService {
  const mode = async (): Promise<Env> => ((await deps.settings.get('daraja.environment')) as Env) ?? 'sandbox';
  const threeLines = (e: unknown): never => {
    if (e instanceof HttpError) throw e;
    // The same key works for balances, payments and prompts, so a 401 here is Safaricom refusing
    // Bill Manager for this app or this number, not the key. Seen live on 2026-09-16.
    if (e instanceof DarajaAuthError) {
      // The SDK message carries the gateway's own words ("Invalid Access Token", "no apiproduct match") from 1.5.1 on; no PII in it.
      const said = `${BILL_MANAGER_NOT_ALLOWED.safaricomSaid} ${e.message}`;
      throw new HttpError(502, 'not_allowed', said, { ...BILL_MANAGER_NOT_ALLOWED, safaricomSaid: said });
    }
    if (e instanceof DarajaConnectionError) throw new HttpError(502, 'unreachable', 'Safaricom could not be reached. Try again in a moment.');
    if (e instanceof DarajaAPIError) {
      const { code, desc } = syncRejection(e);
      const ex = code !== null ? explain('billmanager', code, desc) : null;
      throw new HttpError(502, 'refused', ex ? ex.safaricomSaid : desc, ex ? { safaricomSaid: ex.safaricomSaid, meaning: ex.meaning, whatToDo: ex.whatToDo } : undefined);
    }
    throw e;
  };
  async function appKey(): Promise<string> {
    const env = await mode();
    const key = await deps.settings.get(`env.${env}.billManagerAppKey`);
    if (!key) throw new HttpError(409, 'not_opted_in', NOT_OPTED_IN);
    return key;
  }
  const derive = (r: Row): InvoiceStatus => (r.status === 'sent' || r.status === 'partly_paid') && r.due_date < todayNairobi() ? 'overdue' : r.status;
  const base = (r: Row): Omit<InvoiceView, 'payments'> => ({
    id: r.id, reference: r.external_reference, customerName: r.customer_name, customerPhone: r.customer_phone, invoiceName: r.invoice_name, accountReference: r.account_reference,
    billedPeriod: r.billed_period, dueDate: r.due_date, amountCents: Number(r.amount_cents), paidCents: Number(r.paid_cents), items: r.items ?? [], status: derive(r), stored: r.status,
    createdBy: r.created_by ? { id: r.created_by, displayName: r.created_by_name ?? '' } : null, sentAt: r.sent_at.toISOString(), paidAt: r.paid_at?.toISOString() ?? null, cancelledAt: r.cancelled_at?.toISOString() ?? null,
  });
  async function load(id: string): Promise<Row> {
    const [r] = await deps.db.query<Row>(`${SELECT} WHERE i.id=$1`, [id]);
    if (!r) throw new HttpError(404, 'not_found', 'That invoice does not exist.');
    return r;
  }
  async function full(id: string): Promise<InvoiceView> {
    const r = await load(id);
    const pays = await deps.db.query<{ id: string; amount_cents: string; receipt: string | null; created_at: Date; result_source: string }>(
      `SELECT id, amount_cents, receipt, created_at, result_source FROM requests WHERE type='invoice_payment' AND payload_json->>'invoiceId'=$1 ORDER BY created_at`, [id]);
    return { ...base(r), payments: pays.map((p) => ({ id: p.id, amountCents: Number(p.amount_cents), receipt: p.receipt, at: p.created_at.toISOString(), source: p.result_source === 'callback' ? 'callback' : 'manual' })) };
  }
  /** Applies a payment to an invoice and records it as a requests row. Returns null when the receipt is already known. */
  async function applyPayment(invoiceId: string, amountCents: number, receipt: string, source: 'callback' | 'manual', extra: Record<string, unknown>): Promise<string | null> {
    return deps.db.tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invoice_payment:${receipt}`]);
      const dup = await c.query<{ id: string }>(`SELECT id FROM requests WHERE type='invoice_payment' AND receipt=$1 LIMIT 1`, [receipt]);
      if (dup.rows[0]) return null;
      const ins = await c.query<{ id: string }>(
        `INSERT INTO requests(type, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, recipient_name, account_reference, payload_json, sent_at, result_at, result_source, result_code, result_desc, receipt)
         VALUES ('invoice_payment', $1, 'completed', $2, 'KES', 'phone', $3, $4, $5, $6::jsonb, now(), now(), $7, '0', 'Completed', $8) RETURNING id`,
        [`invpay:${receipt}`, amountCents, extra.phone ?? null, extra.payer ?? null, extra.accountReference ?? null, JSON.stringify({ invoiceId, ...extra }), source === 'callback' ? 'callback' : 'poll', receipt]);
      const inv = await c.query<{ amount_cents: string; paid_cents: string }>(`SELECT amount_cents, paid_cents FROM customer_invoices WHERE id=$1 FOR UPDATE`, [invoiceId]);
      const paid = Number(inv.rows[0].paid_cents) + amountCents;
      const done = paid >= Number(inv.rows[0].amount_cents);
      await c.query(`UPDATE customer_invoices SET paid_cents=$2, status=$3, paid_at=CASE WHEN $3='paid' THEN now() ELSE paid_at END WHERE id=$1 AND status IN ('sent','partly_paid')`, [invoiceId, paid, done ? 'paid' : 'partly_paid']);
      return ins.rows[0].id;
    });
  }

  const svc: InvoicesService = {
    async settings() {
      const env = await mode();
      const s = await deps.settings.getMany([`env.${env}.billManagerAppKey`, `env.${env}.billManagerOptedInAt`, `env.${env}.billManagerEmail`, `env.${env}.billManagerPhone`, `env.${env}.billManagerReminders`, `env.${env}.billManagerOptInStartedAt`, `env.${env}.billManagerOptInError`, 'public.verifiedAt']);
      const started = s[`env.${env}.billManagerOptInStartedAt`];
      const registering = !!started && Date.now() - Date.parse(started) < 2 * 60_000;
      return {
        mode: env, optedIn: !!s[`env.${env}.billManagerAppKey`], optedInAt: s[`env.${env}.billManagerOptedInAt`], email: s[`env.${env}.billManagerEmail`], phone: s[`env.${env}.billManagerPhone`],
        reminders: s[`env.${env}.billManagerReminders`] === '1', publicVerified: !!s['public.verifiedAt'], registering, lastError: registering ? null : s[`env.${env}.billManagerOptInError`],
      };
    },
    async optIn(input, actor) {
      const env = await mode();
      const s = await deps.settings.getMany(['public.url', 'public.verifiedAt']);
      if (!s['public.url'] || !s['public.verifiedAt']) throw new HttpError(409, 'public_url_unverified', PUBLIC_URL_UNVERIFIED);
      let phone: string;
      try { phone = normalizePhone(input.officialContact); } catch { throw new HttpError(400, 'bad_phone', 'Enter a Kenyan mobile number such as 0712 345 678.'); }
      // Safaricom can take long enough here that a proxy in front of the studio gives up first, and
      // the page would then see a cut connection rather than an answer. So the work runs after this
      // reply, and the page reads its outcome from settings(): registering, then opted in or an error.
      await deps.settings.set(`env.${env}.billManagerEmail`, input.email.trim());
      await deps.settings.set(`env.${env}.billManagerPhone`, phone);
      await deps.settings.set(`env.${env}.billManagerReminders`, input.sendReminders ? '1' : '0');
      await deps.settings.set(`env.${env}.billManagerOptInStartedAt`, new Date().toISOString());
      await deps.settings.delete(`env.${env}.billManagerOptInError`);
      const orgId = currentOrgId();
      setImmediate(() => {
        const run = () => svc.runOptIn({ ...input, officialContact: phone }, actor);
        (orgId ? withOrg(orgId, run) : run()).catch((e) => console.error('invoicing opt-in failed', e instanceof Error ? e.name : 'error'));
      });
      return svc.settings();
    },
    async runOptIn(input, actor) {
      const env = await mode();
      const s = await deps.settings.getMany(['public.url', `env.${env}.billManagerAppKey`]);
      const finish = async (error: string | null) => {
        await deps.settings.delete(`env.${env}.billManagerOptInStartedAt`);
        if (error) await deps.settings.set(`env.${env}.billManagerOptInError`, error.slice(0, 600));
        else await deps.settings.delete(`env.${env}.billManagerOptInError`);
        await deps.events.publish('invoice.updated', { settings: true, environment: env, ok: !error });
      };
      const startedAt = Date.now();
      try {
        const urls = callbackUrls(s['public.url'] ?? '', await currentCallbackSecret(deps.orgs));
        const client = await deps.daraja.get();
        const body = { email: input.email.trim(), officialContact: input.officialContact, sendReminders: input.sendReminders, logo: input.logo, callbackUrl: urls.billManager };
        if (s[`env.${env}.billManagerAppKey`]) await client.billManager.updateOptIn(body);
        else {
          const r = await client.billManager.optIn(body);
          if (!r.appKey) throw new HttpError(502, 'no_app_key', 'Safaricom accepted the request but sent no app key. Try again.');
          await deps.settings.set(`env.${env}.billManagerAppKey`, r.appKey);
          await deps.settings.set(`env.${env}.billManagerOptedInAt`, new Date().toISOString());
        }
        await audit(deps.db, { personId: actor.personId, action: 'invoices.opted_in', after: { environment: env, email: body.email }, ip: actor.ip });
        console.log('invoicing opt-in ok', env, `${Date.now() - startedAt}ms`);
        await finish(null);
      } catch (e) {
        let message: string;
        try { threeLines(e); message = 'Something went wrong on our side.'; } catch (h) {
          const he = h as HttpError;
          const d = he.details as { safaricomSaid?: string; meaning?: string; whatToDo?: string } | undefined;
          message = d?.safaricomSaid ? [d.safaricomSaid, d.meaning, d.whatToDo].filter(Boolean).join('\n') : he.message;
        }
        // The gateway's refusal text names the cause (token, product, whitelisting) and holds no customer data.
        console.error('invoicing opt-in failed', env, e instanceof Error ? e.name : 'error', e instanceof DarajaAuthError ? e.message : '', `${Date.now() - startedAt}ms`);
        await finish(message);
      }
    },
    async create(input, actor) {
      const key = await appKey();
      let phone: string;
      try { phone = normalizePhone(input.customerPhone); } catch { throw new HttpError(400, 'bad_phone', 'Enter a Kenyan mobile number such as 0712 345 678.'); }
      const items = (input.items ?? []).filter((i) => i.name.trim() && i.amountCents > 0);
      if (items.length && items.reduce((s, i) => s + i.amountCents, 0) !== input.amountCents) throw new HttpError(400, 'items_mismatch', 'The items must add up to the invoice amount.');
      const client = await deps.daraja.get();
      // The reference is minted under a lock so two invoices never share a number, and the row is
      // written only after Safaricom accepted the invoice: a refusal stores nothing.
      const id = await deps.db.tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('invoices'))`);
        const seq = Number((await c.query<{ n: string }>(`SELECT COALESCE(max(seq),0)+1 AS n FROM customer_invoices`)).rows[0].n);
        const reference = `INV-${String(seq).padStart(6, '0')}`;
        try {
          await client.billManager.sendInvoice({
            appKey: key, externalReference: reference, billedFullName: input.customerName.trim(), billedPhoneNumber: phone, billedPeriod: input.billedPeriod.trim(), invoiceName: input.invoiceName.trim(),
            dueDate: input.dueDate, accountReference: input.accountReference.trim(), amount: input.amountCents / 100,
            ...(items.length ? { invoiceItems: items.map((i) => ({ itemName: i.name.trim(), amount: i.amountCents / 100 })) } : {}),
          });
        } catch (e) { threeLines(e); }
        const ins = await c.query<{ id: string }>(
          `INSERT INTO customer_invoices(seq, external_reference, customer_name, customer_phone, invoice_name, account_reference, billed_period, due_date, amount_cents, items, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::jsonb,$11) RETURNING id`,
          [seq, reference, input.customerName.trim(), phone, input.invoiceName.trim(), input.accountReference.trim(), input.billedPeriod.trim(), input.dueDate, input.amountCents, JSON.stringify(items), actor.personId]);
        await c.query(`INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip) VALUES ($1,'invoice.sent',$2,NULL,$3::jsonb,$4)`, [actor.personId, ins.rows[0].id, JSON.stringify({ reference, amountCents: input.amountCents }), actor.ip]);
        return ins.rows[0].id;
      });
      return full(id);
    },
    checkBulk(text) {
      const { rows, errors } = parseInvoices(text);
      return { rows, errors, count: rows.length, totalCents: rows.reduce((s, r) => s + r.amountCents, 0) };
    },
    async createBulk(text, actor) {
      const key = await appKey();
      const c0 = svc.checkBulk(text);
      if (c0.errors.length) throw new HttpError(400, 'bulk_invalid', 'Fix the rows marked in red first.', { errors: c0.errors });
      if (c0.rows.length === 0) throw new HttpError(400, 'bulk_empty', 'Paste or upload at least one row.');
      const client = await deps.daraja.get();
      return deps.db.tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('invoices'))`);
        let seq = Number((await c.query<{ n: string }>(`SELECT COALESCE(max(seq),0) AS n FROM customer_invoices`)).rows[0].n);
        const planned = c0.rows.map((r) => ({ ...r, seq: ++seq, reference: `INV-${String(seq).padStart(6, '0')}` }));
        try {
          await client.billManager.sendBulkInvoices({ appKey: key, invoices: planned.map((r) => ({ externalReference: r.reference, billedFullName: r.customerName, billedPhoneNumber: r.customerPhone, billedPeriod: r.billedPeriod, invoiceName: r.invoiceName, dueDate: r.dueDate, accountReference: r.accountReference, amount: r.amountCents / 100 })) });
        } catch (e) { threeLines(e); }
        for (const r of planned) {
          await c.query(
            `INSERT INTO customer_invoices(seq, external_reference, customer_name, customer_phone, invoice_name, account_reference, billed_period, due_date, amount_cents, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10)`,
            [r.seq, r.reference, r.customerName, r.customerPhone, r.invoiceName, r.accountReference, r.billedPeriod, r.dueDate, r.amountCents, actor.personId]);
        }
        await c.query(`INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip) VALUES ($1,'invoice.bulk_sent',NULL,NULL,$2::jsonb,$3)`, [actor.personId, JSON.stringify({ count: planned.length, totalCents: c0.totalCents }), actor.ip]);
        return { count: planned.length };
      });
    },
    async list(filter, q) {
      const where: string[] = []; const params: unknown[] = [];
      const today = todayNairobi();
      if (filter === 'open') where.push(`i.status IN ('sent','partly_paid')`);
      if (filter === 'overdue') { params.push(today); where.push(`i.status IN ('sent','partly_paid') AND i.due_date < $${params.length}::date`); }
      if (filter === 'paid') where.push(`i.status = 'paid'`);
      if (filter === 'cancelled') where.push(`i.status = 'cancelled'`);
      if (q?.trim()) { params.push(`%${q.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`); const n = params.length; where.push(`(i.customer_name ILIKE $${n} ESCAPE '\\' OR i.external_reference ILIKE $${n} ESCAPE '\\' OR i.account_reference ILIKE $${n} ESCAPE '\\' OR i.invoice_name ILIKE $${n} ESCAPE '\\')`); }
      const rows = await deps.db.query<Row>(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY i.created_at DESC LIMIT 200`, params);
      return rows.map(base);
    },
    async get(id) { return full(id); },
    async cancel(ids, actor) {
      const key = await appKey();
      const rows = await deps.db.query<Row>(`${SELECT} WHERE i.id = ANY($1::uuid[])`, [ids]);
      if (rows.length !== ids.length) throw new HttpError(404, 'not_found', 'That invoice does not exist.');
      if (rows.some((r) => r.status === 'paid' || r.status === 'partly_paid')) throw new HttpError(409, 'already_paid', ALREADY_PAID);
      const open = rows.filter((r) => r.status === 'sent');
      if (open.length === 0) return 0;
      const client = await deps.daraja.get();
      try {
        if (open.length === 1) await client.billManager.cancelInvoice({ appKey: key, externalReference: open[0].external_reference });
        else await client.billManager.cancelBulkInvoices({ appKey: key, externalReferences: open.map((r) => r.external_reference) });
      } catch (e) { threeLines(e); }
      await deps.db.query(`UPDATE customer_invoices SET status='cancelled', cancelled_at=now() WHERE id = ANY($1::uuid[]) AND status='sent'`, [open.map((r) => r.id)]);
      await audit(deps.db, { personId: actor.personId, action: 'invoice.cancelled', after: { references: open.map((r) => r.external_reference) }, ip: actor.ip });
      return open.length;
    },
    async recordPayment(id, input, actor) {
      const key = await appKey();
      const r = await load(id);
      if (r.status === 'cancelled' || r.status === 'paid') throw new HttpError(409, 'not_open', 'This invoice is not open.');
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(400, 'bad_amount', 'Enter an amount in shillings.');
      const client = await deps.daraja.get();
      try {
        await client.billManager.acknowledgePayment({ appKey: key, paymentDate: input.paymentDate, paidAmount: input.amountCents / 100, accountReference: r.account_reference, transactionId: input.reference.trim(), phoneNumber: r.customer_phone, fullName: input.payer.trim() || r.customer_name, invoiceName: r.invoice_name, externalReference: r.external_reference });
      } catch (e) { threeLines(e); }
      const reqId = await applyPayment(id, input.amountCents, input.reference.trim(), 'manual', { phone: r.customer_phone, payer: input.payer.trim() || r.customer_name, accountReference: r.account_reference, paymentDate: input.paymentDate });
      if (!reqId) throw new HttpError(409, 'duplicate_receipt', 'A payment with that reference is already recorded.');
      await audit(deps.db, { personId: actor.personId, action: 'invoice.payment_recorded', target: id, after: { amountCents: input.amountCents }, ip: actor.ip });
      await deps.events.publish('request.updated', { id: reqId, status: 'completed' });
      return full(id);
    },
    async applyPush(p) {
      const receipt = String(p.transactionId).trim();
      const amountCents = Math.round(Number(p.paidAmount) * 100);
      const [inv] = await deps.db.query<{ id: string }>(`SELECT id FROM customer_invoices WHERE account_reference=$1 AND status IN ('sent','partly_paid') ORDER BY created_at ASC LIMIT 1`, [String(p.accountReference ?? '')]);
      if (!inv) {
        // Kept, and listed under "Payments we could not match": money that arrived for no open invoice.
        const out = await deps.db.tx(async (c) => {
          await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`invoice_payment:${receipt}`]);
          const dup = await c.query<{ id: string }>(`SELECT id FROM requests WHERE type='invoice_payment' AND receipt=$1 LIMIT 1`, [receipt]);
          if (dup.rows[0]) return { verdict: 'duplicate' as const, requestId: dup.rows[0].id };
          const ins = await c.query<{ id: string }>(
            `INSERT INTO requests(type, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, account_reference, payload_json, sent_at, result_at, result_source, result_code, result_desc, receipt)
             VALUES ('invoice_payment', $1, 'completed', $2, 'KES', 'phone', $3, $4, $5::jsonb, now(), now(), 'callback', '0', 'Completed', $6) RETURNING id`,
            [`invpay:${receipt}`, amountCents, String(p.msisdn ?? '') || null, String(p.accountReference ?? '') || null, JSON.stringify({ invoiceId: null, unmatched: true, dateCreated: p.dateCreated }), receipt]);
          return { verdict: 'unmatched' as const, requestId: ins.rows[0].id };
        });
        if (out.verdict === 'unmatched') await deps.events.publish('request.updated', { id: out.requestId, status: 'completed' });
        return out;
      }
      const reqId = await applyPayment(inv.id, amountCents, receipt, 'callback', { phone: String(p.msisdn ?? ''), accountReference: p.accountReference, dateCreated: p.dateCreated });
      if (!reqId) {
        const [dup] = await deps.db.query<{ id: string }>(`SELECT id FROM requests WHERE type='invoice_payment' AND receipt=$1 LIMIT 1`, [receipt]);
        return { verdict: 'duplicate', requestId: dup?.id };
      }
      await deps.events.publish('request.updated', { id: reqId, status: 'completed' });
      await deps.events.publish('invoice.updated', { id: inv.id });
      return { verdict: 'applied', requestId: reqId };
    },
    async unmatched() {
      const rows = await deps.db.query<{ id: string; amount_cents: string; receipt: string | null; account_reference: string | null; created_at: Date }>(
        `SELECT id, amount_cents, receipt, account_reference, created_at FROM requests WHERE type='invoice_payment' AND (payload_json->>'unmatched')='true' ORDER BY created_at DESC LIMIT 100`);
      return rows.map((r) => ({ id: r.id, amountCents: Number(r.amount_cents), receipt: r.receipt, accountReference: r.account_reference, at: r.created_at.toISOString() }));
    },
  };
  return svc;
}
