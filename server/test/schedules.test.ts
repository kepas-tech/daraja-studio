import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type express from 'express';
import { makeApp, loginAsOwner, loginAs, makePerson, TEST_ORG_ID } from './helpers.js';
import { createFakeSafaricom } from '../src/dev/fakeSafaricom.js';
import { encrypt } from '../src/crypto/secrets.js';
import { addDays, todayNairobi } from '../src/schedules/timetable.js';
import { FLOAT_UNKNOWN, type ScheduleInput } from '../src/schedules/service.js';
import { classify } from '../src/notifications/classify.js';

const SAF_IP = '196.201.214.200';
// eslint-disable-next-line prefer-const -- forward-referenced by the fake's post closure, assigned once makeApp returns
let app: express.Express;
const fake = createFakeSafaricom({ post: async (path, body) => { await request(app).post(path).set('X-Forwarded-For', SAF_IP).send(body as object); } });
const made = makeApp({ fetchImpl: fake.fetchImpl });
app = made.app;
const { deps, close } = made;
afterAll(close);

const PASSWORD = 'correct horse';
const TODAY = todayNairobi(new Date());
/** 09:00 on a Nairobi date, as an instant. */
const nine = (date: string, minutes = 5) => new Date(Date.parse(date + 'T06:00:00Z') + minutes * 60_000);
/** Midnight on a Nairobi date, as an instant: when the tests "create" a schedule. */
const midnight = (date: string) => new Date(Date.parse(date + 'T00:00:00Z') - 3 * 3_600_000);
const OWNER = { personId: '', ip: '1.1.1.1' };

async function ready() {
  await deps.settings.set('env.sandbox.shortcode', '600999');
  await deps.settings.set('daraja.environment', 'sandbox');
  await deps.settings.set('env.sandbox.consumerKey', 'k');
  await deps.settings.set('env.sandbox.consumerSecret', 's');
  await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
  await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('testapi',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'Y3JlZA==')]);
}
async function contact(name: string, kind: 'phone' | 'paybill', value: string, account: string | null = null): Promise<string> {
  const [c] = await deps.db.query<{ id: string }>(
    `INSERT INTO contacts(kind, name, phone, shortcode, account_reference) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [kind, name, kind === 'phone' ? value : null, kind === 'phone' ? null : value, account]);
  return c.id;
}
async function balance(utilityCents: number, workingCents: number, at: Date) {
  await deps.db.query(`INSERT INTO balances(working_cents, utility_cents, charges_paid_cents, raw, queried_at) VALUES ($1,$2,0,'{}'::jsonb,$3)`, [workingCents, utilityCents, at]);
}
const daily = (lines: ScheduleInput['lines'], extra: Partial<ScheduleInput> = {}): ScheduleInput => ({
  name: 'Daily casuals', every: 'daily', weekday: 0, dayOfMonth: 1, hour: 9, weekendRule: 'on_day', phoneCommand: 'SalaryPayment', startOn: TODAY, endOn: null, lines, ...extra,
});
const b2cCalls = () => fake.calls.filter((c) => /\/b2c\/v[13]\/paymentrequest$/.test(c.path));
const b2bCalls = () => fake.calls.filter((c) => c.path.endsWith('/b2b/v1/paymentrequest'));
const runsOf = (scheduleId: string) => deps.db.query<{ id: string; state: string; reason: string | null; gap_cents: string | null }>(`SELECT id, state, reason, gap_cents FROM pay_runs WHERE schedule_id=$1`, [scheduleId]);

describe('scheduled payments', () => {
  let cookie: string; let csrf: string;
  let jane: string; let john: string; let kplc: string;
  beforeEach(async () => {
    ({ cookie, csrf } = await loginAsOwner(app, deps));
    OWNER.personId = (await deps.db.query<{ id: string }>(`SELECT id FROM people WHERE is_owner LIMIT 1`))[0].id;
    await ready(); fake.reset();
    jane = await contact('Jane Wanjiru', 'phone', '254700123456');
    john = await contact('John Otieno', 'phone', '254700123457');
    kplc = await contact('KPLC token', 'paybill', '888880', 'METER42');
  });

  it('rule 2 and 4: a due run pays on its own, once, with the audit naming the schedule and its consent', async () => {
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }, { contactId: kplc, amountCents: 100000 }]), OWNER, midnight(TODAY));
    expect(s.nextPayOn).toBe(TODAY);
    await balance(10_000_00, 10_000_00, nine(TODAY));

    const first = await deps.schedules.pass(nine(TODAY));
    const second = await deps.schedules.pass(nine(TODAY, 6));
    expect(first).toMatchObject({ runs: 1, sent: 1 });
    expect(second.runs).toBe(0);
    expect(b2cCalls()).toHaveLength(1);
    expect(b2cCalls()[0].body).toMatchObject({ CommandID: 'SalaryPayment', Amount: 500 });
    expect(b2bCalls()).toHaveLength(1);
    expect(b2bCalls()[0].body).toMatchObject({ AccountReference: 'METER42', Amount: 1000 });
    expect(await runsOf(s.id)).toHaveLength(1);

    // Nobody pressed anything: the rows carry no person, and the audit names who consented.
    const rows = await deps.db.query<{ created_by: string | null }>(`SELECT created_by FROM requests WHERE type IN ('b2c','b2b')`);
    expect(rows.every((r) => r.created_by === null)).toBe(true);
    const [a] = await deps.db.query<{ person_id: string | null; after_json: { scheduleId: string; consentedBy: string; createdBy: string } }>(`SELECT person_id, after_json FROM audit_log WHERE action='schedule.run' AND target=$1`, [(await runsOf(s.id))[0].id]);
    expect(a.person_id).toBeNull();
    expect(a.after_json).toMatchObject({ scheduleId: s.id, consentedBy: OWNER.personId, createdBy: OWNER.personId });

    // The answers arrive, the run settles, and the next date is tomorrow.
    await fake.settle();
    await deps.schedules.pass(nine(TODAY, 10));
    const run = await deps.schedules.run((await runsOf(s.id))[0].id);
    expect(run.state).toBe('done');
    expect(run.lines.map((l) => l.state)).toEqual(['paid', 'paid']);
    expect(run.lines[0].receipt).toMatch(/^RI/);
    expect((await deps.schedules.get(s.id)).nextPayOn).toBe(addDays(TODAY, 1));
  });

  it('rule 3: creating needs the step-up, the warning accepted, and the send permission', async () => {
    const body = { ...daily([{ contactId: jane, amountCents: 50000 }]), startOn: addDays(TODAY, 1), accepted: true };
    const post = (b: object, who = { cookie, csrf }) => request(app).post('/api/schedules').set('Cookie', who.cookie).set('x-csrf-token', who.csrf).send(b);
    expect((await post(body)).body.error.code).toBe('step_up_required');
    const unaccepted = await post({ ...body, accepted: false, password: PASSWORD });
    expect(unaccepted.status).toBe(400);
    const id = await makePerson(deps.db, TEST_ORG_ID, { username: 'clerk', password: PASSWORD });
    await deps.db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'pay.paybill')`, [id]);
    const clerk = await loginAs(app, 'clerk', PASSWORD);
    const refused = await post({ ...body, password: PASSWORD }, clerk);
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.permission).toBe('send.phone');
    expect((await deps.db.query('SELECT 1 FROM schedules')).length).toBe(0);
    const ok = await post({ ...body, password: PASSWORD });
    expect(ok.status).toBe(201);
    expect(ok.body.upcoming).toHaveLength(3);
    // Resuming is consent again, and needs the step-up too.
    await request(app).post(`/api/schedules/${ok.body.id}/pause`).set('Cookie', cookie).set('x-csrf-token', csrf).send({});
    expect((await request(app).post(`/api/schedules/${ok.body.id}/resume`).set('Cookie', cookie).set('x-csrf-token', csrf).send({})).status).toBe(403);
    expect((await request(app).post(`/api/schedules/${ok.body.id}/resume`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ password: PASSWORD })).status).toBe(200);
  });

  it('rule 5: a short float refuses the whole run with the gap named, sends nothing, and Try again sends it', async () => {
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }, { contactId: john, amountCents: 50000 }]), OWNER, midnight(TODAY));
    await balance(600_00, 10_000_00, nine(TODAY));
    const out = await deps.schedules.pass(nine(TODAY));
    expect(out.refused).toBe(1);
    expect(b2cCalls()).toHaveLength(0);
    const [run] = await runsOf(s.id);
    expect(run.state).toBe('refused');
    expect(run.reason).toMatch(/^Utility is KES [\d,]+ short for the phones, so nobody was paid/);
    expect(Number(run.gap_cents)).toBeGreaterThan(400_00);

    // A reading nobody can trust refuses too, and says so.
    await deps.db.query('DELETE FROM balances');
    const s2 = await deps.schedules.create(daily([{ contactId: kplc, amountCents: 50000 }], { name: 'Power' }), OWNER, midnight(TODAY));
    await deps.schedules.pass(nine(TODAY, 40));
    expect((await runsOf(s2.id))[0]).toMatchObject({ state: 'refused', reason: FLOAT_UNKNOWN });

    // Topped up: one press sends the refused run, and a second press finds nothing to send.
    await balance(10_000_00, 10_000_00, new Date());
    const retried = await deps.schedules.retry(run.id, OWNER);
    expect(retried.state).toBe('sending');
    expect(b2cCalls()).toHaveLength(2);
    await expect(deps.schedules.retry(run.id, OWNER)).rejects.toMatchObject({ code: 'not_refused' });
  });

  it('rule 6: editing a schedule does not change a run already made', async () => {
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }]), OWNER, midnight(TODAY));
    await balance(10_000_00, 10_000_00, nine(TODAY));
    await deps.schedules.pass(nine(TODAY));
    await deps.schedules.update(s.id, daily([{ contactId: jane, amountCents: 90000 }]), OWNER, nine(TODAY, 30));
    const run = await deps.schedules.run((await runsOf(s.id))[0].id);
    expect(run.totalCents).toBe(50000);
    expect(run.lines[0].amountCents).toBe(50000);
    expect((await deps.schedules.get(s.id)).totalCents).toBe(90000);
  });

  it('rule 7: a paused schedule produces nothing, and resuming loses nothing and pays no missed dates', async () => {
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }]), OWNER, midnight(TODAY));
    await deps.schedules.pause(s.id, OWNER);
    await balance(10_000_00, 10_000_00, nine(TODAY));
    expect((await deps.schedules.pass(nine(TODAY))).runs).toBe(0);
    expect((await deps.schedules.pass(nine(addDays(TODAY, 1)))).runs).toBe(0);
    const resumed = await deps.schedules.resume(s.id, OWNER, nine(addDays(TODAY, 1), 30));
    expect(resumed.lines).toHaveLength(1);
    expect(resumed.nextPayOn).toBe(addDays(TODAY, 2));
    expect(b2cCalls()).toHaveLength(0);
  });

  it('rule 8: a failed line does not block the others, and is never sent again by itself', async () => {
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }, { contactId: john, amountCents: 50000 }]), OWNER, midnight(TODAY));
    await balance(10_000_00, 10_000_00, nine(TODAY));
    fake.rejectsSync('2040', 'Receiver is not a registered M-PESA customer.');
    await deps.schedules.pass(nine(TODAY));
    expect(b2cCalls()).toHaveLength(2);
    await fake.settle();
    await deps.schedules.pass(nine(TODAY, 20));
    await deps.schedules.pass(nine(TODAY, 30));
    expect(b2cCalls()).toHaveLength(2);
    const run = await deps.schedules.run((await runsOf(s.id))[0].id);
    expect(run.state).toBe('partly_failed');
    expect(run.lines.map((l) => l.state)).toEqual(['failed', 'paid']);
    expect(run.lines[0].failure).toBeTruthy();
  });

  it('rule 9: every create, edit, pause, stop and run writes an audit row naming the person', async () => {
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }]), OWNER, midnight(TODAY));
    await deps.schedules.update(s.id, daily([{ contactId: jane, amountCents: 60000 }]), OWNER, midnight(TODAY));
    await deps.schedules.pause(s.id, OWNER);
    await expect(deps.schedules.stop(s.id, 'not the name', OWNER)).rejects.toMatchObject({ code: 'name_mismatch' });
    await deps.schedules.stop(s.id, ' daily CASUALS ', OWNER);
    const actions = (await deps.db.query<{ action: string; person_id: string }>(`SELECT action, person_id FROM audit_log WHERE action LIKE 'schedule.%' AND target=$1 ORDER BY at`, [s.id]));
    expect(actions.map((a) => a.action)).toEqual(['schedule.created', 'schedule.edited', 'schedule.paused', 'schedule.stopped']);
    expect(actions.every((a) => a.person_id === OWNER.personId)).toBe(true);
  });

  it('rule 10: Home shows the line while any schedule is on, and stops when the last is stopped', async () => {
    const summary = () => request(app).get('/api/schedules/summary').set('Cookie', cookie);
    expect((await summary()).body).toEqual({ active: 0, paused: 0, next: null });
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }, { contactId: john, amountCents: 70000 }], { startOn: addDays(TODAY, 1) }), OWNER);
    expect((await summary()).body).toMatchObject({ active: 1, next: { id: s.id, name: 'Daily casuals', totalCents: 120000, people: 2, payOn: addDays(TODAY, 1) } });
    await request(app).post(`/api/schedules/${s.id}/stop`).set('Cookie', cookie).set('x-csrf-token', csrf).send({ name: 'Daily casuals', password: PASSWORD });
    expect((await summary()).body).toEqual({ active: 0, paused: 0, next: null });
  });

  it('the module off stops the scheduler as well as the screens, and on again resumes with nothing lost', async () => {
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }]), OWNER, midnight(TODAY));
    await balance(10_000_00, 10_000_00, nine(TODAY));
    await deps.db.query(`INSERT INTO modules(key, enabled) VALUES ('scheduled_payments', false)`);
    expect((await deps.schedules.pass(nine(TODAY))).runs).toBe(0);
    expect((await request(app).get('/api/schedules').set('Cookie', cookie)).body.error.code).toBe('module_off');
    await deps.db.query(`DELETE FROM modules WHERE key='scheduled_payments'`);
    expect((await deps.schedules.pass(nine(TODAY, 20))).runs).toBe(1);
    expect((await deps.schedules.get(s.id)).lines).toHaveLength(1);
  });

  it('a date Studio was not running for is recorded as missed and not paid late on its own', async () => {
    const s = await deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }]), OWNER, midnight(TODAY));
    await balance(10_000_00, 10_000_00, nine(addDays(TODAY, 5)));
    const out = await deps.schedules.pass(nine(addDays(TODAY, 5)));
    expect(out.missed).toBe(1);
    expect((await runsOf(s.id))[0].state).toBe('missed');
    expect(b2cCalls()).toHaveLength(0);
  });

  it('refuses a phone line below what M-Pesa sends, a past start, and a contact twice', async () => {
    await expect(deps.schedules.create(daily([{ contactId: jane, amountCents: 500 }]), OWNER)).rejects.toMatchObject({ code: 'below_minimum' });
    await expect(deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }], { startOn: addDays(TODAY, -1) }), OWNER)).rejects.toMatchObject({ code: 'start_past' });
    await expect(deps.schedules.create(daily([{ contactId: jane, amountCents: 50000 }, { contactId: jane, amountCents: 50000 }]), OWNER)).rejects.toMatchObject({ code: 'duplicate_line' });
  });

  it('every run tells the owner afterwards: done, some failed, refused, missed', () => {
    const run = (payload: Record<string, unknown>) => classify({ type: 'alert', payload: { scheduleName: 'Salaries', runId: 'r1', scheduleId: 's1', ...payload } });
    expect(run({ kind: 'schedule_run', state: 'done', totalCents: 312_000_00, lines: 14, failed: 0 })).toMatchObject({ severity: 'success', title: 'Scheduled payment done', body: 'Salaries: KES 312,000 to 14 payees, all paid.' });
    expect(run({ kind: 'schedule_run', state: 'partly_failed', totalCents: 312_000_00, lines: 14, failed: 3 })).toMatchObject({ severity: 'critical', body: 'Salaries: KES 312,000 to 14 payees, 3 failed. Open the run to see why.' });
    expect(run({ kind: 'schedule_refused', reason: 'Utility is KES 5,000 short for the phones, so nobody was paid.' })).toMatchObject({ severity: 'critical', title: 'Scheduled payment not sent' });
    expect(run({ kind: 'schedule_missed', payOn: '2026-09-30' })).toMatchObject({ severity: 'critical', title: 'Scheduled payment missed' });
  });
});
