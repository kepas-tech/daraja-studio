import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createEventHub } from '../src/events/hub.js';
import { createMoneyOutService, UNCONFIRMED, NO_ANSWER_AFTER_POLLS } from '../src/money_out/service.js';
import { requestTimeoutHandler, housekeepingHandler } from '../src/scheduler/handlers.js';
import { testDeps, resetTables } from './helpers.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { HttpError } from '../src/util/errors.js';
import { encrypt } from '../src/crypto/secrets.js';

const deps = testDeps();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(() => deps.db.end());

const statusAck = vi.fn(async () => ({ conversationId: 'AG_Q', originatorConversationId: `q-${Math.random().toString(36).slice(2)}`, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
const factory = (transaction = statusAck): DarajaFactory => ({
  get: async () => ({}) as never,
  getForOperator: async () => ({ status: { transaction }, config: { initiator: 'KEPAS' } }) as never,
  invalidate: () => {}, stkEnabled: async () => false,
});
const noOperator: DarajaFactory = { get: async () => ({}) as never, getForOperator: async () => { throw new HttpError(409, 'no_operator', 'x'); }, invalidate: () => {}, stkEnabled: async () => false };

async function sentB2c(oc: string, minutesAgo: number, extra = '') {
  const [r] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, sent_at ${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ('b2c','BusinessPayment',$1,'sent',100,'phone','254700123456', now() - ($2 || ' minutes')::interval ${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`, [oc, String(minutesAgo)]);
  return r.id;
}

async function pendingB2c(oc: string, minutesAgo: number) {
  const [r] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, created_at)
     VALUES ('b2c','BusinessPayment',$1,'pending',100,'phone','254700123456', now() - ($2 || ' minutes')::interval) RETURNING id`, [oc, String(minutesAgo)]);
  return r.id;
}

describe('money out: sweep', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS',$1,'verified')`, [encrypt(deps.config.secretKey, 'c')]);
    statusAck.mockClear();
  });

  it('polls sent requests older than 2 minutes by OriginatorConversationID and records a status_query row', async () => {
    const old = await sentB2c('OC-OLD', 3);
    const fresh = await sentB2c('OC-NEW', 1);
    const svc = createMoneyOutService({ ...deps, daraja: factory(), events });
    const r = await svc.sweep();
    expect(r).toEqual({ polled: 1, expired: 0 });
    expect(statusAck).toHaveBeenCalledWith(expect.objectContaining({ originatorConversationId: 'OC-OLD', resultUrl: 'https://studio.example/cb/sekret/status', queueTimeoutUrl: 'https://studio.example/cb/sekret/status' }));
    const [t] = await deps.db.query<{ poll_attempts: number; last_poll_at: Date | null }>('SELECT poll_attempts, last_poll_at FROM requests WHERE id=$1', [old]);
    expect(t.poll_attempts).toBe(1);
    expect(t.last_poll_at).not.toBeNull();
    const [q] = await deps.db.query<{ subtype: string; status: string; payload_json: { targetRequestId: string } }>(`SELECT subtype, status, payload_json FROM requests WHERE type='status_query'`);
    expect(q.subtype).toBe('sweep');
    expect(q.status).toBe('sent');
    expect(q.payload_json.targetRequestId).toBe(old);
    const [f] = await deps.db.query<{ poll_attempts: number }>('SELECT poll_attempts FROM requests WHERE id=$1', [fresh]);
    expect(f.poll_attempts).toBe(0);
    // Spacing: an immediate second sweep does not poll the same request again.
    expect((await svc.sweep()).polled).toBe(0);
  });

  // A v1 send has Safaricom's own OriginatorConversationID in payload_json, differing from
  // our own row id — the sweep must poll by Safaricom's id (SAFARICOM_OCID), not ours, or the
  // status query would name an id Safaricom never issued.
  it('polls a v1 row by Safaricom\'s ack OriginatorConversationID, not our own row id', async () => {
    const [row] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, sent_at, payload_json)
       VALUES ('b2c','BusinessPayment','OUR-OWN-UUID','sent',100,'phone','254700123456', now() - interval '3 minutes', $1::jsonb) RETURNING id`,
      [JSON.stringify({ ackOriginatorConversationId: 'SAF-ACK-OC', b2cApiUsed: 'v1' })]);
    const svc = createMoneyOutService({ ...deps, daraja: factory(), events });
    expect(await svc.sweep()).toEqual({ polled: 1, expired: 0 });
    expect(statusAck).toHaveBeenCalledWith(expect.objectContaining({ originatorConversationId: 'SAF-ACK-OC' }));
    const [t] = await deps.db.query<{ poll_attempts: number }>('SELECT poll_attempts FROM requests WHERE id=$1', [row.id]);
    expect(t.poll_attempts).toBe(1);
  });

  it('pollOne (manual check) also polls a v1 row by Safaricom\'s ack OriginatorConversationID', async () => {
    const [row] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, sent_at, payload_json)
       VALUES ('b2c','BusinessPayment','OUR-OWN-UUID-2','sent',100,'phone','254700123456', now() - interval '1 minute', $1::jsonb) RETURNING id`,
      [JSON.stringify({ ackOriginatorConversationId: 'SAF-ACK-OC-2' })]);
    const svc = createMoneyOutService({ ...deps, daraja: factory(), events });
    await svc.pollOne(row.id);
    expect(statusAck).toHaveBeenCalledWith(expect.objectContaining({ originatorConversationId: 'SAF-ACK-OC-2' }));
  });

  it('after five silent polls a request becomes unknown with an alert and is not polled again', async () => {
    const id = await sentB2c('OC-5', 20);
    await deps.db.query(`UPDATE requests SET poll_attempts=5, last_poll_at = now() - interval '3 minutes' WHERE id=$1`, [id]);
    // A human-checked row must never get the five-polls alert (decision 5).
    const checkedId = await sentB2c('OC-5-CHECKED', 20);
    const [checker] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash) VALUES ('checker','Checker','x') RETURNING id`);
    await deps.db.query(
      `UPDATE requests SET poll_attempts=5, last_poll_at = now() - interval '3 minutes', checked_by=$2, checked_at=now(), checked_note='ok' WHERE id=$1`,
      [checkedId, checker.id]);
    const seen: string[] = [];
    const unsub = events.subscribe((e) => { if (e.type === 'alert') seen.push((e.payload as { kind: string }).kind); });
    await events.start();
    try {
      const svc = createMoneyOutService({ ...deps, daraja: factory(), events });
      expect(await svc.sweep()).toEqual({ polled: 0, expired: 1 });
      const [row] = await deps.db.query<{ status: string; meaning: string }>('SELECT status, meaning FROM requests WHERE id=$1', [id]);
      expect(row.status).toBe('unknown');
      expect(row.meaning).toMatch(/after 5 checks/);
      const [checkedRow] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [checkedId]);
      expect(checkedRow.status).toBe('sent');
      await new Promise((r) => setTimeout(r, 200));
      expect(seen).toContain('request_unknown');
      expect(statusAck).not.toHaveBeenCalled();
    } finally { unsub(); await events.stop(); }
  });

  it('a rejected status query counts the attempt, but not as a recorded poll, and does not throw', async () => {
    const id = await sentB2c('OC-REJ', 3);
    const svc = createMoneyOutService({ ...deps, daraja: factory(vi.fn(async () => { throw new Error('boom'); })), events });
    expect((await svc.sweep()).polled).toBe(0);
    const [t] = await deps.db.query<{ poll_attempts: number }>('SELECT poll_attempts FROM requests WHERE id=$1', [id]);
    expect(t.poll_attempts).toBe(1);
    expect((await deps.db.query(`SELECT 1 FROM requests WHERE type='status_query'`)).length).toBe(0);
  });

  it('generates its own id for the query row even when Safaricom echoes the target\'s own OriginatorConversationID back on the ack (C1 scenario A)', async () => {
    const old = await sentB2c('OC-ECHO', 3);
    const echoAck = vi.fn(async (input: { originatorConversationId: string }) => ({ conversationId: 'AG_ECHO', originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
    const svc = createMoneyOutService({ ...deps, daraja: factory(echoAck), events });
    expect(await svc.sweep()).toEqual({ polled: 1, expired: 0 });
    const [q] = await deps.db.query<{ originator_conversation_id: string; conversation_id: string; payload_json: { targetRequestId: string; ackOriginatorConversationId: string } }>(
      `SELECT originator_conversation_id, conversation_id, payload_json FROM requests WHERE type='status_query'`);
    expect(q.originator_conversation_id).not.toBe('OC-ECHO');
    expect(q.payload_json.targetRequestId).toBe(old);
    expect(q.payload_json.ackOriginatorConversationId).toBe('OC-ECHO');
    expect(q.conversation_id).toBe('AG_ECHO');
  });

  it('two acks that both omit OriginatorConversationID do not collide with each other (C1 scenario B)', async () => {
    await sentB2c('OC-EMPTY-A', 3);
    await sentB2c('OC-EMPTY-B', 3);
    const emptyAck = vi.fn(async () => ({ conversationId: 'AG_EMPTY', originatorConversationId: '', responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
    const svc = createMoneyOutService({ ...deps, daraja: factory(emptyAck), events });
    expect(await svc.sweep()).toEqual({ polled: 2, expired: 0 });
    const rows = await deps.db.query<{ id: string; originator_conversation_id: string }>(`SELECT id, originator_conversation_id FROM requests WHERE type='status_query'`);
    expect(rows.length).toBe(2);
    expect(rows[0].originator_conversation_id).not.toBe(rows[1].originator_conversation_id);
  });

  it('a maybe-queued unknown row (send()\'s connection-error path) is swept and expires exactly once', async () => {
    const [row] = await deps.db.query<{ id: string }>(
      `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, sent_at, meaning)
       VALUES ('b2c','BusinessPayment','OC-UNK','unknown',100,'phone','254700123456', now() - interval '3 minutes', $1) RETURNING id`, [UNCONFIRMED]);
    const svc = createMoneyOutService({ ...deps, daraja: factory(), events });
    expect(await svc.sweep()).toEqual({ polled: 1, expired: 0 });
    const seen: string[] = [];
    const unsub = events.subscribe((e) => { if (e.type === 'alert') seen.push((e.payload as { kind: string }).kind); });
    await events.start();
    try {
      await deps.db.query(`UPDATE requests SET poll_attempts=5, last_poll_at = now() - interval '3 minutes' WHERE id=$1`, [row.id]);
      expect(await svc.sweep()).toEqual({ polled: 0, expired: 1 });
      const [r2] = await deps.db.query<{ status: string; meaning: string; result_at: Date | null }>('SELECT status, meaning, result_at FROM requests WHERE id=$1', [row.id]);
      expect(r2.status).toBe('unknown');
      expect(r2.meaning).toBe(NO_ANSWER_AFTER_POLLS);
      expect(r2.result_at).not.toBeNull();
      await new Promise((r) => setTimeout(r, 200));
      expect(seen.filter((k) => k === 'request_unknown').length).toBe(1);
      // A sixth sweep does not re-alert: result_at is now set, and poll_attempts is at the cap.
      expect(await svc.sweep()).toEqual({ polled: 0, expired: 0 });
      await new Promise((r) => setTimeout(r, 200));
      expect(seen.filter((k) => k === 'request_unknown').length).toBe(1);
    } finally { unsub(); await events.stop(); }
  });

  it('without a verified operator the sweep skips polling and marks nothing', async () => {
    const id = await sentB2c('OC-NOOP', 3);
    const svc = createMoneyOutService({ ...deps, daraja: noOperator, events });
    expect(await svc.sweep()).toEqual({ polled: 0, expired: 0 });
    const [t] = await deps.db.query<{ status: string; poll_attempts: number }>('SELECT status, poll_attempts FROM requests WHERE id=$1', [id]);
    expect(t.status).toBe('sent');
    expect(t.poll_attempts).toBe(0);
  });

  it('a pending row (crash between ack and our sent update) is polled too', async () => {
    const id = await pendingB2c('OC-PEND', 3);
    const svc = createMoneyOutService({ ...deps, daraja: factory(), events });
    expect(await svc.sweep()).toEqual({ polled: 1, expired: 0 });
    const [t] = await deps.db.query<{ poll_attempts: number; status: string }>('SELECT poll_attempts, status FROM requests WHERE id=$1', [id]);
    expect(t.poll_attempts).toBe(1);
    expect(t.status).toBe('pending');
  });

  it('pollOne enforces a two-minute cooldown, then the 5-poll cap, then refuses once final', async () => {
    const id = await sentB2c('OC-MAN', 1);
    const svc = createMoneyOutService({ ...deps, daraja: factory(), events });
    const { queryId } = await svc.pollOne(id);
    expect(queryId).toBeTruthy();
    // M8: a manual check is recorded distinctly from an automatic sweep poll.
    const [q] = await deps.db.query<{ subtype: string }>('SELECT subtype FROM requests WHERE id=$1', [queryId]);
    expect(q.subtype).toBe('manual');
    // F4: a second check right away is refused before it ever reaches Safaricom again.
    await expect(svc.pollOne(id)).rejects.toMatchObject({ status: 409, code: 'poll_too_soon' });
    await deps.db.query(`UPDATE requests SET poll_attempts=5, last_poll_at = now() - interval '3 minutes' WHERE id=$1`, [id]);
    await expect(svc.pollOne(id)).rejects.toMatchObject({ status: 409, code: 'poll_cap' });
    await deps.db.query(`UPDATE requests SET status='completed', result_source='callback' WHERE id=$1`, [id]);
    await expect(svc.pollOne(id)).rejects.toMatchObject({ status: 409, code: 'not_pending' });
  });

  it('request_timeout marks a sent non-money request unknown, once', async () => {
    const [b] = await deps.db.query<{ id: string }>(`INSERT INTO requests(type, subtype, originator_conversation_id, status, sent_at) VALUES ('balance','refresh','OC-BAL','sent',now()) RETURNING id`);
    const h = requestTimeoutHandler({ db: deps.db, events });
    await h({ requestId: b.id }, { id: 'j', kind: 'request_timeout', payload: {}, attempts: 1, max_attempts: 1, recurring: false });
    const [row] = await deps.db.query<{ status: string; meaning: string }>('SELECT status, meaning FROM requests WHERE id=$1', [b.id]);
    expect(row.status).toBe('unknown');
    expect(row.meaning).toMatch(/within 5 minutes/);
    await deps.db.query(`UPDATE requests SET status='completed', result_source='callback' WHERE id=$1`, [b.id]);
    await h({ requestId: b.id }, { id: 'j', kind: 'request_timeout', payload: {}, attempts: 1, max_attempts: 1, recurring: false });
    expect((await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [b.id]))[0].status).toBe('completed');
  });

  it('housekeeping deletes expired sessions and cache rows only', async () => {
    const [p] = await deps.db.query<{ id: string }>(`INSERT INTO people(username, display_name, password_hash) VALUES ('a','A','x') RETURNING id`);
    await deps.db.query(`INSERT INTO sessions(id, person_id, csrf_token, expires_at) VALUES ('old',$1,'c', now() - interval '1 hour'), ('live',$1,'c', now() + interval '1 hour')`, [p.id]);
    await deps.db.query(`INSERT INTO cache(key, value, expires_at) VALUES ('old','{}'::jsonb, now() - interval '1 minute'), ('live','{}'::jsonb, now() + interval '1 minute')`);
    await housekeepingHandler({ db: deps.db })({}, { id: 'j', kind: 'housekeeping', payload: {}, attempts: 1, max_attempts: 1, recurring: true });
    expect((await deps.db.query<{ id: string }>('SELECT id FROM sessions')).map((r) => r.id)).toEqual(['live']);
    expect((await deps.db.query<{ key: string }>('SELECT key FROM cache')).map((r) => r.key)).toEqual(['live']);
  });
});
