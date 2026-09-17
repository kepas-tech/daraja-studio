import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { makeApp, loginAsOwner, loginAs, makePerson, TEST_ORG_ID } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(close);

/**
 * audit_log is append-only — its trigger refuses every UPDATE and DELETE — so this file cannot
 * clean up after itself. Every row it writes carries this run's marker, and every read is narrowed
 * to one test's own marker, so rows this file or any other suite left behind can never change an
 * assertion.
 */
const RUN = `auditpage-${randomUUID().slice(0, 8)}`;
const mark = (name: string) => `${RUN}-${name}`;
const FIRST = `audit-page.${RUN}.first`;
const SECOND = `audit-page.${RUN}.second`;

let owner: { cookie: string; csrf: string };

async function insert(opts: {
  action?: string; personId?: string | null; target?: string | null;
  before?: unknown; after?: unknown; at?: string; ip?: string | null;
} = {}): Promise<string> {
  const [row] = await deps.db.query<{ id: string }>(
    `INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip, at)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6, COALESCE($7::timestamptz, now())) RETURNING id::text AS id`,
    [opts.personId ?? null, opts.action ?? FIRST, opts.target ?? RUN,
     opts.before === undefined ? null : JSON.stringify(opts.before),
     opts.after === undefined ? null : JSON.stringify(opts.after),
     opts.ip === undefined ? '127.0.0.1' : opts.ip, opts.at ?? null],
  );
  return row.id;
}

const get = (qs: string) => request(app).get(`/api/audit${qs}`).set('Cookie', owner.cookie);
const ids = (items: { id: string }[]) => items.map((r) => r.id);

describe('the Who did what page', () => {
  beforeEach(async () => { owner = await loginAsOwner(app, deps); });

  it('reads the rows newest first, and refuses anybody who is not the owner', async () => {
    const m = mark('newest');
    const older = await insert({ at: '2026-01-02T12:00:00.000001Z', target: `${m}-older` });
    const newer = await insert({ at: '2026-01-03T12:00:00.000002Z', target: `${m}-newer` });

    const r = await get(`?q=${m}`);
    expect(r.status).toBe(200);
    expect(ids(r.body.items)).toEqual([newer, older]);
    expect(r.body.items[0]).toMatchObject({ action: FIRST, target: `${m}-newer`, ip: '127.0.0.1' });
    expect(r.body.items[0].at).toBe('2026-01-03T12:00:00.000Z');

    const username = `who-${RUN}`;
    await makePerson(deps.db, TEST_ORG_ID, { username, password: 'correct horse', displayName: 'Amina' });
    const nobody = await loginAs(app, username, 'correct horse');
    expect((await request(app).get('/api/audit').set('Cookie', nobody.cookie)).status).toBe(403);
    expect((await request(app).get('/api/audit/actions').set('Cookie', nobody.cookie)).status).toBe(403);
  });

  it('narrows by person, by action and by day', async () => {
    const m = mark('filter');
    const username = `whofilter-${RUN}`;
    const personId = await makePerson(deps.db, TEST_ORG_ID, { username, password: 'correct horse', displayName: 'Amina' });
    const first = await insert({ personId, action: FIRST, target: `${m}-one`, at: '2026-02-01T12:00:00.000001Z' });
    const second = await insert({ personId, action: SECOND, target: `${m}-two`, at: '2026-02-02T12:00:00.000001Z' });
    const third = await insert({ action: FIRST, target: `${m}-three`, at: '2026-02-03T12:00:00.000001Z' });

    expect((await get(`?q=${m}`)).body.items).toHaveLength(3);

    const byPerson = await get(`?q=${m}&personId=${personId}`);
    expect(ids(byPerson.body.items)).toEqual([second, first]);
    expect(byPerson.body.items[0].person).toEqual({ id: personId, displayName: 'Amina' });

    const byAction = await get(`?q=${m}&action=${FIRST}`);
    expect(ids(byAction.body.items)).toEqual([third, first]);

    const byDay = await get(`?q=${m}&from=2026-02-02&to=2026-02-02`);
    expect(ids(byDay.body.items)).toEqual([second]);
  });

  it('treats a typed % as a percent sign, not as a wildcard', async () => {
    const m = mark('pct');
    const literal = await insert({ target: `${m}-50%x` });
    await insert({ target: `${m}-50x` });

    const r = await get(`?q=${encodeURIComponent(`${m}-50%`)}`);
    expect(r.status).toBe(200);
    expect(ids(r.body.items)).toEqual([literal]);
  });

  it('pages through rows written at the same instant without skipping or repeating', async () => {
    const m = mark('page');
    // One identical timestamp for all five: only the id tiebreak can keep the order stable.
    const at = '2026-03-01T09:00:00.000001Z';
    const written: string[] = [];
    for (let i = 0; i < 5; i++) written.push(await insert({ at, target: `${m}-row-${i}` }));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r = await get(`?q=${m}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      if (page === 0) expect(r.body.items).toHaveLength(2); // the limit is what was asked for
      seen.push(...ids(r.body.items));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...written].reverse());
  });

  it('answers a hostile cursor with a 400, never a 500', async () => {
    const hostile = [
      'not-a-cursor',
      Buffer.from('2026-13-45T99:99:99.999999Z|abc').toString('base64url'),
      Buffer.from('2026-01-01T00:00:00.000001Z|1; DROP TABLE audit_log').toString('base64url'),
      // Nineteen digits, and larger than int8: the value must be refused before any cast.
      Buffer.from('2026-01-01T00:00:00.000001Z|9999999999999999999').toString('base64url'),
    ];
    for (const cursor of hostile) {
      const r = await get(`?cursor=${encodeURIComponent(cursor)}`);
      expect(r.status, cursor).toBe(400);
      expect(r.body.error.code, cursor).toBe('bad_cursor');
    }
  });

  it('lists every action once, for the filter', async () => {
    const m = `audit-page.${RUN}.m6`;
    await insert({ action: `${m}.x` });
    await insert({ action: `${m}.x` });
    await insert({ action: `${m}.y` });
    const r = await request(app).get('/api/audit/actions').set('Cookie', owner.cookie);
    expect(r.status).toBe(200);
    expect(r.body.items.filter((a: string) => a.startsWith(`${m}.`))).toEqual([`${m}.x`, `${m}.y`]);
  });

  it('shows a row nobody signed as person null, and the stored JSON unchanged', async () => {
    const m = mark('nobody');
    const id = await insert({ personId: null, target: m, before: { amountCents: 30000 }, after: { nested: [1, 2, { ok: true }] }, ip: null });
    const r = await get(`?q=${m}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    const row = r.body.items[0];
    expect(row.id).toBe(id);
    expect(row.person).toBeNull();
    expect(row.before).toEqual({ amountCents: 30000 });
    expect(row.after).toEqual({ nested: [1, 2, { ok: true }] });
    expect(row.ip).toBeNull();
  });
});
