import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, loginAs } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';

const { app, deps, close } = makeApp();
afterAll(close);

let owner: { cookie: string; csrf: string };

/**
 * One row in the state under test, written straight to the table: the send path and the sweep are
 * what produce these in real life, and both have their own tests. `sentMinutesAgo` is the age the
 * page sorts by; a checked row is one a person has already dealt with.
 */
async function row(opts: { type?: string; status: string; sentMinutesAgo?: number; checked?: boolean }): Promise<string> {
  const [r] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency,
                         recipient_kind, recipient_value, sent_at, checked_by, checked_at, checked_note)
     VALUES ($1,'BusinessPayment',gen_random_uuid()::text,$2,500000,'KES','phone','254700123456',
             now() - make_interval(mins => $3::int),
             NULL, CASE WHEN $4 THEN now() ELSE NULL END, CASE WHEN $4 THEN 'seen in the portal' ELSE NULL END)
     RETURNING id`,
    [opts.type ?? 'b2c', opts.status, opts.sentMinutesAgo ?? 5, opts.checked ?? false]);
  return r.id;
}

const ids = (items: { id: string }[]) => items.map((r) => r.id);

/** A second person with exactly the permissions named, and their session. */
async function person(username: string, permissions: string[]): Promise<{ cookie: string; csrf: string }> {
  const [p] = await deps.db.query<{ id: string }>(
    `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ($1,$1,$2,false) RETURNING id`,
    [username, await hashPassword('correct horse')]);
  for (const permission of permissions) await deps.db.query('INSERT INTO permissions(person_id, permission) VALUES ($1,$2)', [p.id, permission]);
  return loginAs(app, username, 'correct horse');
}

describe('the Waiting page', () => {
  beforeEach(async () => { owner = await loginAsOwner(app, deps); });

  it('puts each unfinished row in its own section, newest first, and nowhere else', async () => {
    const older = await row({ status: 'sent', sentMinutesAgo: 60 });
    const newer = await row({ status: 'sent', sentMinutesAgo: 5 });
    const unknown = await row({ status: 'unknown', sentMinutesAgo: 30 });
    const checked = await row({ status: 'unknown', sentMinutesAgo: 40, checked: true });
    const held = await row({ status: 'awaiting_approval' });
    const balance = await row({ type: 'balance', status: 'sent' });
    const r = await request(app).get('/api/waiting').set('Cookie', owner.cookie);
    expect(r.status).toBe(200);
    expect(ids(r.body.sent.items)).toEqual([newer, older]);
    expect(ids(r.body.noAnswer.items)).toEqual([unknown]);
    expect(ids(r.body.approvals.items)).toEqual([held]);
    expect(r.body.approvals.canDecide).toBe(true);
    const shown = ids([...r.body.sent.items, ...r.body.noAnswer.items, ...r.body.approvals.items]);
    expect(shown).not.toContain(checked);
    expect(shown).not.toContain(balance);
    expect(r.body.sent.count).toBe(2);
    expect(r.body.noAnswer.count).toBe(1);
    expect(r.body.badge).toBe(2);
  });

  it('a row a person has already checked leaves the page and the badge', async () => {
    const sent = await row({ status: 'sent' });
    await row({ status: 'sent', checked: true });
    await row({ status: 'unknown', checked: true });
    const r = await request(app).get('/api/waiting').set('Cookie', owner.cookie);
    expect(ids(r.body.sent.items)).toEqual([sent]);
    expect(r.body.noAnswer.items).toEqual([]);
    expect(r.body.sent.count).toBe(1);
    expect(r.body.noAnswer.count).toBe(0);
    const count = await request(app).get('/api/waiting/count').set('Cookie', owner.cookie);
    expect(count.body).toEqual({ badge: 0 });
  });

  it('an operator sees both Safaricom sections and no decision buttons; an approver sees the held send', async () => {
    const sent = await row({ status: 'sent' });
    const unknown = await row({ status: 'unknown' });
    const held = await row({ status: 'awaiting_approval' });
    const operator = await person('waitoperator', ['lookup.view']);
    const asOperator = await request(app).get('/api/waiting').set('Cookie', operator.cookie);
    expect(asOperator.status).toBe(200);
    expect(ids(asOperator.body.sent.items)).toEqual([sent]);
    expect(ids(asOperator.body.noAnswer.items)).toEqual([unknown]);
    expect(asOperator.body.approvals).toEqual({ items: [], canDecide: false });
    // The badge counts the held send and the no-answer one, whoever is asking: it is somebody's work.
    expect(asOperator.body.badge).toBe(2);
    const approver = await person('waitapprover', ['lookup.view', 'send.approve']);
    const asApprover = await request(app).get('/api/waiting').set('Cookie', approver.cookie);
    expect(ids(asApprover.body.approvals.items)).toEqual([held]);
    expect(asApprover.body.approvals.canDecide).toBe(true);
    expect(ids(asApprover.body.sent.items)).toEqual([sent]);
  });

  it('the list needs lookup.view; the count needs only a session', async () => {
    const nobody = await person('waitnobody', []);
    expect((await request(app).get('/api/waiting').set('Cookie', nobody.cookie)).status).toBe(403);
    expect((await request(app).get('/api/waiting/count').set('Cookie', nobody.cookie)).status).toBe(200);
  });
});
