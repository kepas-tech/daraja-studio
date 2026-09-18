import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, loginAs, makePerson, TEST_ORG_ID } from './helpers.js';

/**
 * Round 3, phase D-5: the case file on a payment that went wrong.
 *
 * Opened on the payment, recorded on as things are done, closed with how it ended. It is paper:
 * no money moves, and nothing on it changes the payment it is about.
 */
const { app, deps, close } = makeApp();
afterAll(close);

async function payment(status = 'failed') {
  const [row] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_value, recipient_name, sent_at, result_at)
     VALUES ('b2c','BusinessPayment',$1,$2,10000,'KES','254700123456','Jane Doe', now(), now()) RETURNING id`,
    ['oc-case-' + Math.random().toString(36).slice(2), status],
  );
  return row.id;
}

describe('the case file on a payment', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });
  const h = (r: request.Test) => r.set('Cookie', cookie).set('x-csrf-token', csrf);

  it('opens a case, records what was done, and closes it with how it ended', async () => {
    const id = await payment();
    expect((await h(request(app).get(`/api/requests/${id}/case`))).body).toBeNull();

    const opened = await h(request(app).post(`/api/requests/${id}/case`)).send({ title: 'Customer says the money never arrived' });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({
      requestId: id, status: 'open', title: 'Customer says the money never arrived',
      openedBy: { displayName: 'Owner' }, closedAt: null, outcome: null, notes: [],
    });
    const caseId = opened.body.id;

    const noted = await h(request(app).post(`/api/cases/${caseId}/notes`)).send({ note: 'Asked Safaricom support; waiting on ticket 4471.' });
    expect(noted.status).toBe(200);
    expect(noted.body.notes.map((n: { note: string }) => n.note)).toEqual(['Asked Safaricom support; waiting on ticket 4471.']);
    expect(noted.body.notes[0].by.displayName).toBe('Owner');
    await h(request(app).post(`/api/cases/${caseId}/notes`)).send({ note: 'Statement shows it went to the wrong number.' });

    const closed = await h(request(app).post(`/api/cases/${caseId}/close`)).send({ outcome: 'Paid again to the right number; Safaricom refunded the wrong one.' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', outcome: 'Paid again to the right number; Safaricom refunded the wrong one.', closedBy: { displayName: 'Owner' } });
    expect(closed.body.closedAt).toBeTruthy();
    expect(closed.body.notes).toHaveLength(2);

    // The payment keeps the case and its notes after it is closed, and every act is in the log.
    const again = await h(request(app).get(`/api/requests/${id}/case`));
    expect(again.body).toMatchObject({ id: caseId, status: 'closed' });
    expect(again.body.notes).toHaveLength(2);
    const audit = await deps.db.query<{ action: string }>('SELECT action FROM audit_log WHERE target=$1 ORDER BY action', [caseId]);
    expect(audit.map((a) => a.action)).toEqual(['case.closed', 'case.noted', 'case.noted', 'case.opened']);
  });

  it('refuses a second open case, and lets a new one follow a closed one', async () => {
    const id = await payment();
    await h(request(app).post(`/api/requests/${id}/case`)).send({ title: 'First' });
    const second = await h(request(app).post(`/api/requests/${id}/case`)).send({ title: 'Second' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_open');
    const ghost = await h(request(app).post('/api/requests/00000000-0000-4000-8000-0000000000ff/case')).send({ title: 'Nowhere' });
    expect(ghost.status).toBe(404);

    // The same payment can go wrong twice: closing the first case frees the payment for a second.
    const [first] = await deps.db.query<{ id: string }>('SELECT id FROM request_cases WHERE request_id=$1', [id]);
    await h(request(app).post(`/api/cases/${first.id}/close`)).send({ outcome: 'Sorted.' });
    const third = await h(request(app).post(`/api/requests/${id}/case`)).send({ title: 'It happened again' });
    expect(third.status).toBe(201);
    // The page shows the case in hand, not the one already closed.
    expect((await h(request(app).get(`/api/requests/${id}/case`))).body).toMatchObject({ id: third.body.id, status: 'open' });
  });

  it('takes nothing more on a closed case', async () => {
    const id = await payment();
    const opened = await h(request(app).post(`/api/requests/${id}/case`)).send({ title: 'Something went wrong' });
    const caseId = opened.body.id;
    await h(request(app).post(`/api/cases/${caseId}/close`)).send({ outcome: 'Explained to the customer.' });

    const note = await h(request(app).post(`/api/cases/${caseId}/notes`)).send({ note: 'One more thing.' });
    expect(note.status).toBe(409);
    expect(note.body.error.code).toBe('closed');
    const closeAgain = await h(request(app).post(`/api/cases/${caseId}/close`)).send({ outcome: 'Changed my mind.' });
    expect(closeAgain.status).toBe(409);
    // The first outcome stands.
    expect((await h(request(app).get(`/api/requests/${id}/case`))).body.outcome).toBe('Explained to the customer.');
    expect((await h(request(app).post('/api/cases/00000000-0000-4000-8000-0000000000ff/notes')).send({ note: 'x' })).status).toBe(404);
  });

  it('lets somebody with cases.manage run the file, and refuses those without it', async () => {
    const id = await payment();
    await makePerson(deps.db, TEST_ORG_ID, { username: 'viewer', password: 'correct horse', role: 'custom' });
    await deps.db.query(`INSERT INTO permissions(person_id, permission) SELECT id, 'lookup.view' FROM people WHERE username='viewer'`);
    const v = await loginAs(app, 'viewer', 'correct horse');
    const vh = (r: request.Test) => r.set('Cookie', v.cookie).set('x-csrf-token', v.csrf);
    // Reading the file needs only the permission the payment's own page already needs.
    expect((await vh(request(app).get(`/api/requests/${id}/case`))).status).toBe(200);
    expect((await vh(request(app).post(`/api/requests/${id}/case`)).send({ title: 'Not mine to open' })).status).toBe(403);

    await makePerson(deps.db, TEST_ORG_ID, { username: 'op', password: 'correct horse', role: 'operator' });
    await deps.db.query(`INSERT INTO permissions(person_id, permission) SELECT id, 'cases.manage' FROM people WHERE username='op'`);
    const o = await loginAs(app, 'op', 'correct horse');
    const opened = await request(app).post(`/api/requests/${id}/case`).set('Cookie', o.cookie).set('x-csrf-token', o.csrf).send({ title: 'From the operator' });
    expect(opened.status).toBe(201);
    expect(opened.body.openedBy.displayName).toBe('op');

    expect((await request(app).get(`/api/requests/${id}/case`)).status).toBe(401);
  });
});
