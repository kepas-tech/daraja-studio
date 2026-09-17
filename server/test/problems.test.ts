import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner, loginAs, makePerson, resetTables, TEST_ORG_ID } from './helpers.js';
import { QUIET_MINUTES } from '../src/health/problems.js';
import { encrypt } from '../src/crypto/secrets.js';

/**
 * Brief 2, item 2: the three states Home's banner reports — an operator DOWN, sends pending with no
 * answer from Safaricom, and a refused balance query — plus the rule that only the owner is sent the
 * specifics behind the sentence. Real PostgreSQL; nothing here moves money or calls Safaricom.
 */

const { app, deps, close } = makeApp();
afterAll(close);

let s: { cookie: string; csrf: string };
beforeEach(async () => {
  await resetTables(deps.db);
  s = await loginAsOwner(app, deps);
  await deps.settings.set('public.url', 'https://studio.example');
  await deps.settings.set('public.verifiedAt', new Date().toISOString());
});

const items = async () => (await request(app).get('/api/health/problems').set('Cookie', s.cookie)).body.items as
  { kind: string; detail: { name: string | null; minutes: number | null } | null }[];

/** One operator, DOWN since `minutes` ago. */
const downOperator = async (name = 'APIONE', minutes = 30) =>
  deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority, down_since, consecutive_failures)
     VALUES ($1,$2,'failed',1, now() - make_interval(mins => $3), 9)`, [name, encrypt(deps.config.secretKey, 'c'), minutes]);

/** One send Safaricom accepted and never answered, `minutes` ago. */
const pendingSend = async (minutes = 30) =>
  deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, sent_at)
     VALUES ('b2c','BusinessPayment',gen_random_uuid()::text,'sent',10000,'KES','phone','254700123456', now() - make_interval(mins => $1))`, [minutes]);

/** One callback, received `minutes` ago. */
const callback = async (minutes: number) =>
  deps.db.query(`INSERT INTO callbacks_raw(path, verdict, received_at) VALUES ('/cb/sekret/b2c','applied', now() - make_interval(mins => $1))`, [minutes]);

/** The newest balance row, with the status the result callback would have stored. */
const balanceRow = async (status: string, minutes: number) =>
  deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, sent_at, result_at)
     VALUES ('balance','refresh',gen_random_uuid()::text,$1,0,'KES','phone',NULL, now() - make_interval(mins => $2), now() - make_interval(mins => $2))`, [status, minutes]);

describe('the three things that mean something is wrong', () => {
  it('says nothing at all when everything is fine', async () => {
    expect(await items()).toEqual([]);
  });

  it('names an operator that is DOWN, and how long, to the owner only', async () => {
    await downOperator('APIONE', 42);
    const [owner] = await items();
    expect(owner.kind).toBe('operator_down');
    expect(owner.detail).toMatchObject({ name: 'APIONE' });
    expect(owner.detail!.minutes).toBeGreaterThanOrEqual(41);
    expect(owner.detail!.minutes).toBeLessThan(60);

    // Everybody sees the sentence; the specifics are the server's to withhold, not the page's to hide.
    await makePerson(deps.db, TEST_ORG_ID, { username: 'viewer', password: 'a long enough one', role: 'viewer' });
    const v = await loginAs(app, 'viewer', 'a long enough one');
    const seen = await request(app).get('/api/health/problems').set('Cookie', v.cookie);
    expect(seen.status).toBe(200);
    expect(seen.body.items).toEqual([{ kind: 'operator_down', detail: null }]);
  });

  it('is quiet about a healthy operator and about one only recently probed', async () => {
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('APIONE',$1,'verified',1)`, [encrypt(deps.config.secretKey, 'c')]);
    expect(await items()).toEqual([]);
  });

  it('says so when sends are pending and no callback has arrived for longer than the sweep expects', async () => {
    await pendingSend(QUIET_MINUTES + 20);
    await callback(QUIET_MINUTES + 20);
    const [p] = await items();
    expect(p.kind).toBe('no_callback');
    expect(p.detail!.minutes).toBeGreaterThanOrEqual(QUIET_MINUTES + 19);
  });

  it('a send made a minute ago has not waited for anything, and a fresh answer clears it', async () => {
    await pendingSend(1);
    expect(await items()).toEqual([]);
    // Old enough to raise it, but Safaricom answered two minutes ago: nothing is wrong yet.
    await pendingSend(QUIET_MINUTES + 20);
    await callback(2);
    expect(await items()).toEqual([]);
    // Now the answers stop: the same pending send with a stale callback is worth saying out loud.
    await deps.db.query(`UPDATE callbacks_raw SET received_at = now() - make_interval(mins => $1)`, [QUIET_MINUTES + 20]);
    expect((await items()).map((x) => x.kind)).toEqual(['no_callback']);
    // And when Safaricom answers, it goes away on its own.
    await callback(0);
    expect(await items()).toEqual([]);
  });

  it('reports the last balance query when it was refused, and forgets it after a later success', async () => {
    await balanceRow('failed', 12);
    const [p] = await items();
    expect(p.kind).toBe('balance_refused');
    expect(p.detail!.minutes).toBeGreaterThanOrEqual(11);
    await balanceRow('completed', 0);
    expect(await items()).toEqual([]);
  });

  it('does not count an operator probe as a refused balance query', async () => {
    await deps.db.query(`INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, currency, recipient_kind, recipient_value, sent_at, result_at)
       VALUES ('balance','operator_probe',gen_random_uuid()::text,'failed',0,'KES','phone',NULL, now(), now())`);
    expect(await items()).toEqual([]);
  });

  it('needs a session', async () => {
    expect((await request(app).get('/api/health/problems')).status).toBe(401);
  });
});
