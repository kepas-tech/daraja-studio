import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, loginAs, makePerson, resetTables, TEST_ORG_ID } from './helpers.js';

/**
 * Feature 6: the numbers on the Reports page and the strip on Home. Real PostgreSQL, and every row
 * is written straight to the table, so no Safaricom call happens and nothing can move money.
 */

describe('reports', () => {
  const { app, deps, close } = makeApp();
  afterAll(close);
  let s: { cookie: string; csrf: string };
  let oc = 0;
  beforeEach(async () => {
    await resetTables(deps.db);
    s = await loginAsOwner(app, deps);
  });
  const h = (r: request.Test) => r.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);

  /** One request row, straight to the table: no send path and no Safaricom. */
  async function addRequest(over: Record<string, unknown> = {}): Promise<string> {
    const cols: Record<string, unknown> = {
      type: 'b2c', subtype: 'BusinessPayment', originator_conversation_id: 'OC-' + (++oc), status: 'completed',
      amount_cents: 30000, recipient_kind: 'phone', recipient_value: '254704549060', ...over,
    };
    const keys = Object.keys(cols);
    const placeholders = keys.map((_, i) => '$' + (i + 1)).join(',');
    const [row] = await deps.db.query<{ id: string }>(
      'INSERT INTO requests(' + keys.join(',') + ') VALUES (' + placeholders + ') RETURNING id',
      keys.map((k) => cols[k]),
    );
    return row.id;
  }

  /** A business, straight to the table. */
  async function addBusiness(code: string, name: string): Promise<string> {
    const [row] = await deps.db.query<{ id: string }>('INSERT INTO businesses(code, name) VALUES ($1, $2) RETURNING id', [code, name]);
    return row.id;
  }

  const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);
  /** n whole days back. Shifting an instant by whole days shifts its Nairobi day by the same n. */
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
  const view = async (query = '') => (await h(request(app).get('/api/reports' + query))).body;

  it('adds up a day, and the rate is made of the two numbers it names', async () => {
    await addRequest({ type: 'c2b', status: 'completed', amount_cents: 50000 });
    await addRequest({ type: 'b2c', status: 'completed', amount_cents: 30000 });
    await addRequest({ type: 'b2c', status: 'failed', amount_cents: 20000 });
    const v = await view();
    expect(v.window.days).toBe(7);
    expect(v.days).toHaveLength(7);
    const today = v.days[6];
    expect(today.inCents).toBe(50000);
    expect(today.inCount).toBe(1);
    expect(today.outCents).toBe(30000);
    expect(today.outCount).toBe(1);
    expect(today.completed).toBe(2);
    expect(today.failed).toBe(1);
    expect(today.unknown).toBe(0);
    // The rate the page shows is completed over completed plus failed: 2 of 3.
    expect(v.totals).toMatchObject({ inCents: 50000, outCents: 30000, completed: 2, failed: 1, unknown: 0 });
    // One business means routing is off, so there is no split to show.
    expect(v.byBusiness).toEqual([]);
  });

  it('gives a row that never got an answer its own column and leaves the rate alone', async () => {
    await addRequest({ type: 'c2b', status: 'completed', amount_cents: 10000 });
    await addRequest({ type: 'c2b', status: 'unknown', amount_cents: 40000 });
    const v = await view();
    expect(v.totals.unknown).toBe(1);
    expect(v.totals.completed).toBe(1);
    expect(v.totals.failed).toBe(0);
    // Unknown money never arrived, so it is not counted as arrived; the page says so in its column.
    expect(v.totals.inCents).toBe(10000);
    expect(v.totals.inCount).toBe(1);
  });

  it('never counts a balance check or a lookup as money', async () => {
    await addRequest({ type: 'balance', status: 'completed', amount_cents: 99999 });
    await addRequest({ type: 'status_query', status: 'completed', amount_cents: 88888 });
    const v = await view();
    expect(v.totals).toMatchObject({ inCents: 0, inCount: 0, outCents: 0, outCount: 0, completed: 0, failed: 0, unknown: 0 });
    expect(v.days.every((d: { inCents: number; outCents: number; completed: number }) => d.inCents === 0 && d.outCents === 0 && d.completed === 0)).toBe(true);
  });

  it('keeps a line for every day in the window, zeros included', async () => {
    await addRequest({ type: 'c2b', status: 'completed', amount_cents: 7000, created_at: daysAgo(3) });
    const seven = await view();
    expect(seven.days).toHaveLength(7);
    expect(seven.days[3].inCents).toBe(7000);
    expect(seven.days.filter((d: { inCents: number }) => d.inCents === 0)).toHaveLength(6);
    const thirty = await view('?days=30');
    expect(thirty.window.days).toBe(30);
    expect(thirty.days).toHaveLength(30);
    expect(thirty.totals.inCents).toBe(7000);
  });

  it('says why things failed, biggest group first, with the money it affected', async () => {
    await addRequest({ type: 'b2c', status: 'failed', amount_cents: 10000, result_desc: 'Insufficient balance' });
    await addRequest({ type: 'b2c', status: 'failed', amount_cents: 20000, result_desc: 'Insufficient balance' });
    await addRequest({ type: 'c2b', status: 'failed', amount_cents: 5000, result_desc: 'Timeout' });
    await addRequest({ type: 'b2c', status: 'failed', amount_cents: 7000, result_desc: null });
    // Older than the seven-day window: not this week's problem, so not in this week's list.
    await addRequest({ type: 'b2c', status: 'failed', amount_cents: 99999, result_desc: 'Insufficient balance', created_at: daysAgo(8) });
    const v = await view();
    expect(v.failures).toHaveLength(3);
    expect(v.failures[0]).toEqual({ reason: 'Insufficient balance', count: 2, amountCents: 30000 });
    expect(v.failures.find((f: { reason: string }) => f.reason === 'Timeout').amountCents).toBe(5000);
    expect(v.failures.find((f: { reason: string }) => f.reason === 'Safaricom did not say why.').count).toBe(1);
  });

  it('narrows to one business, and splits by business only without a filter', async () => {
    const zero = await addBusiness('000', 'Shop');
    const one = await addBusiness('001', 'Rentals');
    await addRequest({ type: 'c2b', status: 'completed', amount_cents: 10000, business_id: zero });
    await addRequest({ type: 'c2b', status: 'completed', amount_cents: 20000, business_id: one });
    await addRequest({ type: 'b2c', status: 'completed', amount_cents: 15000, business_id: one });

    const all = await view();
    expect(all.byBusiness).toEqual([
      { businessId: zero, code: '000', name: 'Shop', inCents: 10000, outCents: 0 },
      { businessId: one, code: '001', name: 'Rentals', inCents: 20000, outCents: 15000 },
    ]);

    const narrowed = await view('?businessId=' + zero);
    expect(narrowed.totals.inCents).toBe(10000);
    expect(narrowed.totals.outCents).toBe(0);
    expect(narrowed.byBusiness).toEqual([]);
  });

  it('counts a paid prompt and its confirmation once, not twice', async () => {
    // What sinro's first Studio top-up left behind: the prompt, completed, and the confirmation
    // Safaricom posted for the same money, one receipt between them.
    await addRequest({ type: 'stk', subtype: null, amount_cents: 1000, receipt: 'UIO498FXH8' });
    await addRequest({ type: 'c2b', subtype: null, originator_conversation_id: 'c2b:UIO498FXH8', amount_cents: 1000, receipt: 'UIO498FXH8' });
    // A prompt with no confirmation behind it still counts on its own.
    await addRequest({ type: 'stk', subtype: null, amount_cents: 500, receipt: 'UIO498FXH9' });
    const sum = (await h(request(app).get('/api/reports/summary'))).body;
    expect(sum.inCents).toBe(1500);
    expect(sum.inCount).toBe(2);
    expect((await view('?days=7')).totals).toMatchObject({ inCents: 1500, inCount: 2 });
  });

  it('counts the last 24 hours for the strip on Home', async () => {
    await addRequest({ type: 'c2b', status: 'completed', amount_cents: 12000, created_at: hoursAgo(1) });
    await addRequest({ type: 'c2b', status: 'completed', amount_cents: 99000, created_at: hoursAgo(30) });
    await addRequest({ type: 'b2c', status: 'sent', amount_cents: 5000, created_at: hoursAgo(2) });
    await addRequest({ type: 'b2c', status: 'failed', amount_cents: 4000, created_at: hoursAgo(2) });
    await addRequest({ type: 'b2c', status: 'awaiting_approval', amount_cents: 3000 });
    const r = await h(request(app).get('/api/reports/summary'));
    expect(r.status).toBe(200);
    expect(r.body.inCents).toBe(12000);
    expect(r.body.inCount).toBe(1);
    expect(r.body.outCents).toBe(5000);
    expect(r.body.outCount).toBe(1);
    // Two have not finished: the send waiting at Safaricom and the send waiting for approval.
    expect(r.body.pending).toBe(2);
    expect(r.body.failed).toBe(1);
  });

  it('hands the same table back as a file, behind history.export', async () => {
    await addRequest({ type: 'c2b', status: 'completed', amount_cents: 50000 });
    const r = await h(request(app).get('/api/reports/export.csv'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="reports-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = r.text.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(8); // the header and the seven days
    expect(lines[0]).toBe('"Day","Money in","Payments in","Money out","Payments out","Paid","Failed","Needs a check"');
    expect(lines[7]).toContain('"500.00"');

    const staff = await makePerson(deps.db, TEST_ORG_ID, { username: 'staffer', password: 'correct horse battery', role: 'custom' });
    await deps.db.query("INSERT INTO permissions(person_id, permission) VALUES ($1,'lookup.view')", [staff]);
    const s2 = await loginAs(app, 'staffer', 'correct horse battery');
    const refused = await request(app).get('/api/reports/export.csv').set('Cookie', s2.cookie).set('x-csrf-token', s2.csrf);
    expect(refused.status).toBe(403);
    await deps.db.query("INSERT INTO permissions(person_id, permission) VALUES ($1,'history.export')", [staff]);
    const allowed = await request(app).get('/api/reports/export.csv').set('Cookie', s2.cookie).set('x-csrf-token', s2.csrf);
    expect(allowed.status).toBe(200);
  });

  it('refuses a window it does not offer, and keeps the numbers behind lookup.view', async () => {
    const bad = await h(request(app).get('/api/reports?days=14'));
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('Choose 7, 30 or 90 days.');
    expect((await h(request(app).get('/api/reports?days=abc'))).status).toBe(400);
    expect((await h(request(app).get('/api/reports?businessId=nope'))).status).toBe(400);

    const nobody = await makePerson(deps.db, TEST_ORG_ID, { username: 'nobody', password: 'correct horse battery', role: 'custom' });
    void nobody;
    const s3 = await loginAs(app, 'nobody', 'correct horse battery');
    expect((await request(app).get('/api/reports').set('Cookie', s3.cookie).set('x-csrf-token', s3.csrf)).status).toBe(403);
    expect((await request(app).get('/api/reports/summary').set('Cookie', s3.cookie).set('x-csrf-token', s3.csrf)).status).toBe(403);
  });
});
