import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, loginAs, makePerson, resetTables, TEST_ORG_ID } from './helpers.js';
import { csvCell, toCsv } from '../src/export/csv.js';
import { INVOICE_STATUS_LABELS, STATUS_LABELS, SUBTYPE_LABELS, TYPE_LABELS } from '../src/export/labels.js';
import { LEDGER_TYPES } from '../src/money_out/registry.js';

/**
 * Feature 3: the files History and Invoices hand back. Real PostgreSQL, and no Safaricom call
 * anywhere — every row here is written straight to the table, so nothing can move money.
 */

/** A Nairobi "today", the same clock the file name uses. */
const eatDay = (offsetDays = 0) => new Date(Date.now() + 3 * 3_600_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);

describe('the CSV writer', () => {
  it('quotes every cell, doubles an inner quote and guards a formula', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(300.5)).toBe('"300.5"');
    expect(csvCell(null)).toBe('""');
    for (const lead of ['=1+1', '+1', '-1', '@x', '\tx', '\rx']) expect(csvCell(lead)).toBe(`"'${lead}"`);
  });
  it('ends every line with CRLF, header first', () => {
    expect(toCsv(['A', 'B'], [[1, 2]])).toBe('"A","B"\r\n"1","2"\r\n');
  });
});

describe('CSV export', () => {
  const { app, deps, close } = makeApp();
  afterAll(close);
  let s: { cookie: string; csrf: string };
  let oc = 0;
  let seq = 0;
  beforeEach(async () => {
    await resetTables(deps.db);
    s = await loginAsOwner(app, deps);
  });
  const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

  /** One request row, written straight to the table: no send path and no Safaricom. */
  async function addRequest(over: Record<string, unknown> = {}): Promise<string> {
    const cols: Record<string, unknown> = {
      type: 'b2c', subtype: 'BusinessPayment', originator_conversation_id: `OC-${++oc}`, status: 'completed',
      amount_cents: 30000, recipient_kind: 'phone', recipient_value: '254704549060', recipient_name: 'Joseph Ngumbao John',
      remarks: 'Rent', receipt: `R${String(++seq).padStart(9, '0')}`.slice(0, 10), ...over,
    };
    const keys = Object.keys(cols);
    const [row] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => cols[k]),
    );
    return row.id;
  }

  /** One invoice row, straight to the table. */
  async function addInvoice(over: { reference?: string; status?: string; paidCents?: number } = {}): Promise<string> {
    const n = ++seq;
    const [row] = await deps.db.query<{ id: string }>(
      `INSERT INTO customer_invoices(seq, external_reference, customer_name, customer_phone, invoice_name, account_reference, billed_period, due_date, amount_cents, items, status, paid_cents)
       VALUES ($1,$2,'Jane Doe','254700123456','Rent','000123','September 2026',$3::date,1400000,'[]'::jsonb,$4,$5) RETURNING id`,
      [n, over.reference ?? `INV-${String(n).padStart(6, '0')}`, eatDay(), over.status ?? 'sent', over.paidCents ?? 0],
    );
    return row.id;
  }

  it('needs history.export: the owner has it, a person without it is refused', async () => {
    const owner = await h(request(app).get('/api/requests/export.csv'));
    expect(owner.status).toBe(200);
    expect(owner.headers['content-type']).toContain('text/csv');
    expect(owner.headers['content-disposition']).toMatch(/^attachment; filename="history-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(owner.headers['cache-control']).toBe('no-store');

    const staff = await makePerson(deps.db, TEST_ORG_ID, { username: 'staffer', password: 'correct horse battery', role: 'custom' });
    await deps.db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'lookup.view')`, [staff]);
    const s2 = await loginAs(app, 'staffer', 'correct horse battery');
    const refused = await request(app).get('/api/requests/export.csv').set('Cookie', s2.cookie).set('x-csrf-token', s2.csrf);
    expect(refused.status).toBe(403);

    const invoicesRefused = await request(app).get('/api/invoices/export.csv').set('Cookie', s2.cookie).set('x-csrf-token', s2.csrf);
    expect(invoicesRefused.status).toBe(403);

    // The permission, once granted, is enough — no owner needed.
    await deps.db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'history.export')`, [staff]);
    const allowed = await request(app).get('/api/requests/export.csv').set('Cookie', s2.cookie).set('x-csrf-token', s2.csrf);
    expect(allowed.status).toBe(200);
    expect(allowed.text.split('\r\n')[0]).toBe('"When","What","Number","Name","Business","Amount","Status","Receipt","Note","Who made it"');
  });

  it('carries one line per row, with the owner own names first', async () => {
    await addRequest({ receipt: 'UIG517BUAZ', remarks: 'Rent for September' });
    const r = await h(request(app).get('/api/requests/export.csv'));
    const lines = r.text.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2); // header + the one row
    expect(lines[0]).toBe('"When","What","Number","Name","Business","Amount","Status","Receipt","Note","Who made it"');
    expect(lines[1]).toContain('"UIG517BUAZ"');
    expect(lines[1]).toContain('"300.00"');
    expect(lines[1]).toContain('"Joseph Ngumbao John"');
    expect(lines[1]).toContain('"Rent for September"');
    expect(lines[1]).toMatch(/^"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"/);
  });

  it('writes the words the screen shows, never the codes behind them', async () => {
    await addRequest({ receipt: 'EEEEEEEEEE', subtype: 'BusinessPayment', status: 'completed' });
    const r = await h(request(app).get('/api/requests/export.csv'));
    const row = r.text.split('\r\n')[1];
    expect(row).toContain('"Business payment"');
    expect(row).toContain('"Paid"');
    expect(row).not.toContain('"BusinessPayment"');
    expect(row).not.toContain('"completed"');
  });

  it('has a word for every type, kind and status the app can store', () => {
    for (const t of [...LEDGER_TYPES, 'balance', 'status_query', 'invoice_payment']) {
      expect(TYPE_LABELS[t], `type ${t}`).toBeTruthy();
    }
    for (const st of ['pending', 'sent', 'completed', 'failed', 'unknown', 'cancelled', 'rejected', 'awaiting_approval']) {
      expect(STATUS_LABELS[st], `status ${st}`).toBeTruthy();
    }
    for (const st of ['sent', 'partly_paid', 'paid', 'overdue', 'cancelled']) {
      expect(INVOICE_STATUS_LABELS[st], `invoice status ${st}`).toBeTruthy();
    }
    for (const st of ['BusinessPayment', 'SalaryPayment', 'PromotionPayment']) {
      expect(SUBTYPE_LABELS[st], `subtype ${st}`).toBeTruthy();
    }
  });

  it('honours the same filters the page does', async () => {
    await addRequest({ receipt: 'AAAAAAAAAA', status: 'completed' });
    await addRequest({ receipt: 'BBBBBBBBBB', status: 'failed' });

    const failed = await h(request(app).get('/api/requests/export.csv?status=failed'));
    expect(failed.text).toContain('BBBBBBBBBB');
    expect(failed.text).not.toContain('AAAAAAAAAA');

    // An older row drops out of a range that covers only today.
    await deps.db.query(`UPDATE requests SET created_at = now() - interval '10 days' WHERE receipt = 'BBBBBBBBBB'`);
    const today = eatDay();
    const recent = await h(request(app).get(`/api/requests/export.csv?from=${today}&to=${today}`));
    expect(recent.text).toContain('AAAAAAAAAA');
    expect(recent.text).not.toContain('BBBBBBBBBB');

    // The business filter of feature 2 narrows it the same way.
    const [b] = await deps.db.query<{ id: string }>(`INSERT INTO businesses(code, name) VALUES ('001','Shop') RETURNING id`);
    await deps.db.query(`UPDATE requests SET business_id=$1 WHERE receipt='AAAAAAAAAA'`, [b.id]);
    const only = await h(request(app).get(`/api/requests/export.csv?businessId=${b.id}`));
    expect(only.text).toContain('AAAAAAAAAA');
    expect(only.text).not.toContain('BBBBBBBBBB');
    expect(only.text).toContain('"Shop"');
  });

  it('a comma, a quote or a formula in the owner own text cannot break the file', async () => {
    await addRequest({ receipt: 'CCCCCCCCCC', remarks: 'Rent, "September" share', recipient_name: '=cmd|calc' });
    const r = await h(request(app).get('/api/requests/export.csv'));
    expect(r.text).toContain('"Rent, ""September"" share"');
    expect(r.text).toContain('"\'=cmd|calc"');
  });

  it('invoices: the filter decides the rows and the file carries the amount and what was paid', async () => {
    await addInvoice({ reference: 'INV-000001', status: 'sent' });
    await addInvoice({ reference: 'INV-000002', status: 'paid', paidCents: 500000 });

    const open = await h(request(app).get('/api/invoices/export.csv?filter=open'));
    expect(open.status).toBe(200);
    expect(open.headers['content-disposition']).toMatch(/^attachment; filename="invoices-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(open.text.split('\r\n')[0]).toBe('"Reference","Customer","Phone","Invoice name","Account reference","Billed period","Due date","Amount","Paid","Status","Sent","Paid at"');
    expect(open.text).toContain('INV-000001');
    expect(open.text).toContain('"Sent"');
    expect(open.text).not.toContain('INV-000002');

    const paid = await h(request(app).get('/api/invoices/export.csv?filter=paid'));
    expect(paid.text).toContain('INV-000002');
    expect(paid.text).toContain('"14000.00"');
    expect(paid.text).toContain('"5000.00"');
  });

  it('writes one audit row naming the filters, and never a phone number', async () => {
    await addRequest({ receipt: 'DDDDDDDDDD' });
    const day = eatDay();
    const before = (await deps.db.query(`SELECT id FROM audit_log WHERE action='history.exported'`)).length;
    const r = await h(request(app).get(`/api/requests/export.csv?status=completed&q=0704549060&from=${day}&to=${day}`));
    expect(r.status).toBe(200);
    const rows = await deps.db.query<{ after_json: Record<string, unknown> }>(`SELECT after_json FROM audit_log WHERE action='history.exported' ORDER BY id DESC`);
    expect(rows).toHaveLength(before + 1);
    expect(rows[0].after_json).toMatchObject({ status: 'completed', from: day, to: day, searched: true });
    const text = JSON.stringify(rows[0].after_json);
    expect(text).not.toContain('0704549060');
    expect(text).not.toContain('254704549060');

    await h(request(app).get('/api/invoices/export.csv?filter=open'));
    const inv = await deps.db.query<{ after_json: Record<string, unknown> }>(`SELECT after_json FROM audit_log WHERE action='invoices.exported' ORDER BY id DESC`);
    expect(inv[0].after_json).toMatchObject({ filter: 'open', searched: false });
  });
});
