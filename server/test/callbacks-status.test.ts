import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, resetTables } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });
const SAF_IP = '196.201.214.200';

function statusBody(queryOc: string, opts: { code?: number; status?: string; receipt?: string; amount?: number } = {}) {
  const code = opts.code ?? 0;
  return { Result: {
    ResultType: 0, ResultCode: code, ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'The format of parameter null is invalid.',
    OriginatorConversationID: queryOc, ConversationID: `AG_${queryOc}`, TransactionID: opts.receipt ?? '',
    ...(code === 0 ? { ResultParameters: { ResultParameter: [
      { Key: 'DebitPartyName', Value: '600999 - ACME' }, { Key: 'CreditPartyName', Value: '254700123456 - Jane Doe' },
      { Key: 'TransactionStatus', Value: opts.status ?? 'Completed' }, { Key: 'Amount', Value: opts.amount ?? 1 },
      { Key: 'ReceiptNo', Value: opts.receipt ?? 'RI6BZTPXNM' }, { Key: 'FinalisedTime', Value: 20260906142000 },
      { Key: 'ReasonType', Value: 'Business Payment to Customer via API' },
    ] } } : {}),
  } };
}

async function target(oc: string, status = 'sent', extra: Record<string, unknown> = {}) {
  const cols = ['type', 'subtype', 'originator_conversation_id', 'status', 'amount_cents', 'recipient_kind', 'recipient_value', 'sent_at', ...Object.keys(extra)];
  const vals: unknown[] = ['b2c', 'BusinessPayment', oc, status, 100, 'phone', '254700123456', new Date(Date.now() - 300_000), ...Object.values(extra)];
  const [r] = await deps.db.query<{ id: string }>(`INSERT INTO requests(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
  return r.id;
}
// A real pollTarget always records the ack's own conversation_id (round-1 C1) — mirrored here as
// `AG_<queryOc>`, matching statusBody's default ConversationID, so a live query row is reachable
// by conversation_id alone, the only key the round-3 decision allows once one is present.
async function query(queryOc: string, targetId: string | null, subtype = 'sweep') {
  const [r] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, payload_json, recipient_value) VALUES ('status_query',$1,$2,$3,'sent',now(),$4::jsonb,$5) RETURNING id`,
    [subtype, queryOc, `AG_${queryOc}`, JSON.stringify(targetId ? { targetRequestId: targetId } : { receipt: 'RI6BZTPXNM' }), targetId ? null : 'RI6BZTPXNM']);
  return r.id;
}

describe('/cb/status', () => {
  const alerts: string[] = [];
  beforeEach(async () => { await resetTables(deps.db); alerts.length = 0; });

  it('a Completed status finalises a sent target as completed with the receipt, source poll', async () => {
    const t = await target('OC-T1');
    const q = await query('Q1', t);
    const updated: string[] = [];
    const unsub = deps.events.subscribe((e) => { if (e.type === 'request.updated') updated.push((e.payload as { id: string }).id); });
    await deps.events.start();
    try {
      const r = await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q1'));
      expect(r.status).toBe(200);
      const [tr] = await deps.db.query<{ status: string; receipt: string; result_source: string; recipient_name: string }>('SELECT status, receipt, result_source, recipient_name FROM requests WHERE id=$1', [t]);
      expect(tr).toEqual({ status: 'completed', receipt: 'RI6BZTPXNM', result_source: 'poll', recipient_name: '254700123456 - Jane Doe' });
      const [qr] = await deps.db.query<{ status: string; raw_result_json: unknown }>('SELECT status, raw_result_json FROM requests WHERE id=$1', [q]);
      expect(qr.status).toBe('completed');
      expect(qr.raw_result_json).toBeTruthy();
      const [raw] = await deps.db.query<{ verdict: string; matched_request_id: string }>('SELECT verdict, matched_request_id FROM callbacks_raw');
      expect(raw.verdict).toBe('applied');
      expect(raw.matched_request_id).toBe(q);
      await new Promise((r2) => setTimeout(r2, 200));
      // M6: the query row's own status change is published too, not only the target's.
      expect(updated).toEqual(expect.arrayContaining([t, q]));
    } finally { unsub(); await deps.events.stop(); }
  });

  it('a Failed status finalises the target as failed with Safaricom\'s word as the said-line', async () => {
    const t = await target('OC-T2');
    await query('Q2', t);
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q2', { status: 'Failed' }));
    const [tr] = await deps.db.query<{ status: string; result_desc: string; result_code: string | null; meaning: string }>('SELECT status, result_desc, result_code, meaning FROM requests WHERE id=$1', [t]);
    expect(tr.status).toBe('failed');
    expect(tr.result_desc).toBe('Failed');
    expect(tr.result_code).toBeNull();
    expect(tr.meaning).toMatch(/Safaricom's own record/);
  });

  it('a poll result overrides a disagreeing callback result, keeps both raws, raises an alert', async () => {
    const t = await target('OC-T3', 'completed', { receipt: 'RI-CALLBACK', result_source: 'callback', result_code: '0', result_desc: 'The service request is processed successfully.', raw_result_json: JSON.stringify({ from: 'callback' }) });
    const q = await query('Q3', t);
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q3', { status: 'Failed' }));
      const [tr] = await deps.db.query<{ status: string; raw_result_json: { from: string } }>('SELECT status, raw_result_json FROM requests WHERE id=$1', [t]);
      expect(tr.status).toBe('failed');
      expect(tr.raw_result_json.from).toBe('callback');
      const [qr] = await deps.db.query<{ raw_result_json: { Result: unknown } }>('SELECT raw_result_json FROM requests WHERE id=$1', [q]);
      expect(qr.raw_result_json.Result).toBeTruthy();
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContain('result_disagreement');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('an agreeing poll result changes nothing on a final target', async () => {
    const t = await target('OC-T4', 'completed', { receipt: 'RI6BZTPXNM', result_source: 'callback', result_code: '0', result_desc: 'x' });
    await query('Q4', t);
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q4'));
    const [tr] = await deps.db.query<{ result_source: string; result_desc: string }>('SELECT result_source, result_desc FROM requests WHERE id=$1', [t]);
    expect(tr.result_source).toBe('callback');
    expect(tr.result_desc).toBe('x');
  });

  it('an unclear status leaves the target alone and raises status_unclear; a rejected query fails only the query row', async () => {
    const t = await target('OC-T5');
    await query('Q5', t);
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q5', { status: 'Pending' }));
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]))[0].status).toBe('sent');
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContain('status_unclear');
      const q6 = await query('Q6', t);
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q6', { code: 25 }));
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [q6]))[0].status).toBe('failed');
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]))[0].status).toBe('sent');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('a targetless lookup row becomes the result itself', async () => {
    const q = await query('Q7', null, 'lookup');
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q7', { amount: 250 }));
    const [qr] = await deps.db.query<{ status: string; receipt: string; amount_cents: string; recipient_name: string; meaning: string }>('SELECT status, receipt, amount_cents, recipient_name, meaning FROM requests WHERE id=$1', [q]);
    expect(qr.status).toBe('completed');
    expect(qr.receipt).toBe('RI6BZTPXNM');
    expect(Number(qr.amount_cents)).toBe(25000);
    expect(qr.recipient_name).toBe('254700123456 - Jane Doe');
    expect(qr.meaning).toMatch(/Completed/);
  });

  it('an amount disagreement still applies the outcome, but raises status_amount_mismatch', async () => {
    const t = await target('OC-T8'); // amount_cents 100 (KES 1)
    await query('Q8', t);
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q8', { amount: 5 })); // KES 5 = 500 cents
      const [tr] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]);
      expect(tr.status).toBe('completed');
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContain('status_amount_mismatch');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('a result with neither OriginatorConversationID nor ConversationID matches nothing (C2a)', async () => {
    const t = await target('OC-T9');
    await query('Q9', t);
    const body = { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.', OriginatorConversationID: '', ConversationID: '', TransactionID: '' } };
    const r = await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(body);
    expect(r.status).toBe(200);
    expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]))[0].status).toBe('sent');
    expect((await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'))[0].verdict).toBe('unmatched');
  });

  it('a result matched only by ConversationID (no OriginatorConversationID match) still resolves its target (C2b)', async () => {
    const t = await target('OC-T10');
    await deps.db.query(
      `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, payload_json) VALUES ('status_query','sweep','Q10-OWN','AG_CONVONLY','sent',now(),$1::jsonb)`,
      [JSON.stringify({ targetRequestId: t })]);
    const body = statusBody('', { status: 'Completed' });
    body.Result.ConversationID = 'AG_CONVONLY';
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(body);
    const [tr] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]);
    expect(tr.status).toBe('completed');
  });

  it('a result with no matching query row, naming a live b2c row\'s own OriginatorConversationID, resolves it directly (C2c — the query INSERT never landed)', async () => {
    const t = await target('OC-T11');
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('OC-T11'));
      const [tr] = await deps.db.query<{ status: string; result_source: string; receipt: string }>('SELECT status, result_source, receipt FROM requests WHERE id=$1', [t]);
      expect(tr.status).toBe('completed');
      expect(tr.result_source).toBe('poll');
      expect(tr.receipt).toBe('RI6BZTPXNM');
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContain('status_query_unrecorded');
      // N3: the audit trail names the real verdict, exercising migration 005.
      expect((await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'))[0].verdict).toBe('applied_direct');
    } finally { unsub(); await deps.events.stop(); }
  });

  // A v1 send stores Safaricom's own OriginatorConversationID as
  // payload_json.ackOriginatorConversationId, distinct from our own row id — the direct-match
  // fallback (no query row landed) must also find the row by that ack id, not just by our own.
  it('a result naming the ack OriginatorConversationID of a v1 sent row (no query row) resolves it directly', async () => {
    const t = await target('OUR-OWN-UUID-V1', 'sent', { payload_json: JSON.stringify({ ackOriginatorConversationId: 'SAF-ACK-DIRECT' }) });
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('SAF-ACK-DIRECT'));
    const [tr] = await deps.db.query<{ status: string; result_source: string; receipt: string }>('SELECT status, result_source, receipt FROM requests WHERE id=$1', [t]);
    expect(tr.status).toBe('completed');
    expect(tr.result_source).toBe('poll');
    expect(tr.receipt).toBe('RI6BZTPXNM');
    expect((await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'))[0].verdict).toBe('applied_direct');
  });

  it('a result naming an already-final money row with no matching query row is left alone (unmatched_final, N3)', async () => {
    const t = await target('OC-T16', 'completed', { receipt: 'RI-FINAL', result_source: 'callback', result_code: '0', result_desc: 'x' });
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('OC-T16'));
      const [tr] = await deps.db.query<{ status: string; receipt: string }>('SELECT status, receipt FROM requests WHERE id=$1', [t]);
      expect(tr.status).toBe('completed');
      expect(tr.receipt).toBe('RI-FINAL');
      expect((await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'))[0].verdict).toBe('unmatched_final');
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContain('status_result_for_final');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('the direct path with an unclear status text writes nothing, verdict unmatched, alerts status_unclear', async () => {
    const t = await target('OC-T17');
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('OC-T17', { status: 'Pending' }));
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]))[0].status).toBe('sent');
      expect((await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'))[0].verdict).toBe('unmatched');
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContain('status_unclear');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('the sandbox off-range alert also fires for a direct (applied_direct) resolution (router decision 4)', async () => {
    const t = await target('OC-T18');
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', '1.2.3.4').send(statusBody('OC-T18'));
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]))[0].status).toBe('completed');
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContain('callback_off_range_applied');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('two live query rows for the same target resolve by conversation_id, not the shared OCID (N1, distinct conversation ids)', async () => {
    const t = await target('OC-T19');
    const [q1] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, payload_json, created_at)
       VALUES ('status_query','sweep','Q19-1','AG_Q19A','sent',now(),$1::jsonb, now() - interval '2 minutes') RETURNING id`,
      [JSON.stringify({ targetRequestId: t, ackOriginatorConversationId: 'OC-T19' })]);
    const [q2] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, payload_json, created_at)
       VALUES ('status_query','sweep','Q19-2','AG_Q19B','sent',now(),$1::jsonb, now() - interval '1 minute') RETURNING id`,
      [JSON.stringify({ targetRequestId: t, ackOriginatorConversationId: 'OC-T19' })]);
    const unsub = deps.events.subscribe((e) => { if (e.type === 'alert') alerts.push((e.payload as { kind: string }).kind); });
    await deps.events.start();
    try {
      const body1 = statusBody('OC-T19', { status: 'Pending' });
      body1.Result.ConversationID = 'AG_Q19A';
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(body1);
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [q1.id]))[0].status).toBe('completed');
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [q2.id]))[0].status).toBe('sent');
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]))[0].status).toBe('sent');
      await new Promise((r) => setTimeout(r, 200));
      expect(alerts).toContain('status_unclear');

      const body2 = statusBody('OC-T19', { status: 'Completed' });
      body2.Result.ConversationID = 'AG_Q19B';
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(body2);
      expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [q2.id]))[0].status).toBe('completed');
      const [tr] = await deps.db.query<{ status: string; result_source: string }>('SELECT status, result_source FROM requests WHERE id=$1', [t]);
      expect(tr.status).toBe('completed');
      expect(tr.result_source).toBe('poll');
      const [raw2] = await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw ORDER BY received_at DESC LIMIT 1');
      expect(raw2.verdict).toBe('applied');
    } finally { unsub(); await deps.events.stop(); }
  });

  it('two live query rows for the same target, matched only by the shared OCID, resolve oldest first (N1, no conversation ids)', async () => {
    const t = await target('OC-T20');
    const [q1] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, sent_at, payload_json, created_at)
       VALUES ('status_query','sweep','Q20-1','sent',now(),$1::jsonb, now() - interval '2 minutes') RETURNING id`,
      [JSON.stringify({ targetRequestId: t, ackOriginatorConversationId: 'OC-T20' })]);
    const [q2] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, sent_at, payload_json, created_at)
       VALUES ('status_query','sweep','Q20-2','sent',now(),$1::jsonb, now() - interval '1 minute') RETURNING id`,
      [JSON.stringify({ targetRequestId: t, ackOriginatorConversationId: 'OC-T20' })]);

    const body1 = statusBody('OC-T20', { status: 'Pending' });
    body1.Result.ConversationID = '';
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(body1);
    expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [q1.id]))[0].status).toBe('completed');
    expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [q2.id]))[0].status).toBe('sent');

    const body2 = statusBody('OC-T20', { status: 'Completed' });
    body2.Result.ConversationID = '';
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(body2);
    expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [q2.id]))[0].status).toBe('completed');
    const [tr] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]);
    expect(tr.status).toBe('completed');
  });

  it('a redelivered result for an already-answered query does not hijack a different outstanding query for the same payment', async () => {
    const t = await target('OC-T21');
    const [qa] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, payload_json, created_at)
       VALUES ('status_query','sweep','Q21-A','conv-A','completed',now(),$1::jsonb, now() - interval '2 minutes') RETURNING id`,
      [JSON.stringify({ targetRequestId: t, ackOriginatorConversationId: 'OC-T21' })]);
    const [qb] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, payload_json, created_at)
       VALUES ('status_query','sweep','Q21-B','conv-B','sent',now(),$1::jsonb, now() - interval '1 minute') RETURNING id`,
      [JSON.stringify({ targetRequestId: t, ackOriginatorConversationId: 'OC-T21' })]);

    // A redelivery of A's already-answered Pending result must not be mistaken for B's answer.
    const bodyA = statusBody('OC-T21', { status: 'Pending' });
    bodyA.Result.ConversationID = 'conv-A';
    const rA = await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(bodyA);
    expect(rA.status).toBe(200);
    expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [qb.id]))[0].status).toBe('sent');
    expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [t]))[0].status).toBe('sent');
    expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [qa.id]))[0].status).toBe('completed');
    const [rawA] = await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw ORDER BY received_at DESC LIMIT 1');
    expect(rawA.verdict).toBe('duplicate');

    // B's real, still-outstanding answer must still land.
    const bodyB = statusBody('OC-T21', { status: 'Completed' });
    bodyB.Result.ConversationID = 'conv-B';
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(bodyB);
    const [tr] = await deps.db.query<{ status: string; result_source: string }>('SELECT status, result_source FROM requests WHERE id=$1', [t]);
    expect(tr.status).toBe('completed');
    expect(tr.result_source).toBe('poll');
    const [rawB] = await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw ORDER BY received_at DESC LIMIT 1');
    expect(rawB.verdict).toBe('applied');
  });

  it('a non-empty conversation_id matching no query row at all still falls through to the direct-by-OCID path, never the query-row OCID fallbacks (N7 second test)', async () => {
    const t = await target('OC-T22');
    await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('OC-T22'));
    const [tr] = await deps.db.query<{ status: string; result_source: string }>('SELECT status, result_source FROM requests WHERE id=$1', [t]);
    expect(tr.status).toBe('completed');
    expect(tr.result_source).toBe('poll');
    const [raw] = await deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw');
    expect(raw.verdict).toBe('applied_direct');
  });

  it('a poll result resolves a previously expired (unknown) target', async () => {
    const t = await target('OC-T12', 'unknown', { result_at: new Date(), meaning: 'No answer from Safaricom after 5 checks. Check the Safaricom portal, then Mark as checked.' });
    await query('Q12', t);
    const updated: string[] = [];
    const unsub = deps.events.subscribe((e) => { if (e.type === 'request.updated') updated.push((e.payload as { id: string }).id); });
    await deps.events.start();
    try {
      await request(app).post('/cb/sekret/status').set('X-Forwarded-For', SAF_IP).send(statusBody('Q12'));
      const [tr] = await deps.db.query<{ status: string; result_source: string; receipt: string }>('SELECT status, result_source, receipt FROM requests WHERE id=$1', [t]);
      expect(tr.status).toBe('completed');
      expect(tr.result_source).toBe('poll');
      expect(tr.receipt).toBe('RI6BZTPXNM');
      await new Promise((r) => setTimeout(r, 200));
      expect(updated).toContain(t);
    } finally { unsub(); await deps.events.stop(); }
  });
});
