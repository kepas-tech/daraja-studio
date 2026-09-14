import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { withOrg } from '../src/db/pool.js';
import { enqueue, claim, complete, fail, ensureRecurring } from '../src/db/jobs.js';
import { createScheduler } from '../src/scheduler/loop.js';
import { testDeps, resetTables, TEST_ORG_ID } from './helpers.js';

const deps = testDeps();
afterAll(() => deps.db.end());

describe('jobs', () => {
  beforeEach(() => resetTables(deps.db));

  it('enqueue → claim → complete', async () => {
    const id = await withOrg(TEST_ORG_ID, () => enqueue(deps.db, 'hello', { x: 1 }));
    const j = await claim(deps.db, 'w1');
    expect(j?.id).toBe(id);
    expect(j?.payload).toEqual({ x: 1, orgId: TEST_ORG_ID });
    expect(await claim(deps.db, 'w2')).toBeNull();
    await complete(deps.db, id);
    const rows = await deps.db.query<{ done_at: Date }>('SELECT done_at FROM jobs WHERE id=$1', [id]);
    expect(rows[0].done_at).not.toBeNull();
  });

  it('claim counts an attempt; fail stops at max attempts without counting again', async () => {
    const id = await withOrg(TEST_ORG_ID, () => enqueue(deps.db, 'k', {}, { maxAttempts: 2 }));
    const j1 = await claim(deps.db, 'w');
    expect(j1?.attempts).toBe(1);
    await fail(deps.db, j1!.id, 'boom');
    let row = (await deps.db.query<{ attempts: number; done_at: Date | null; run_at: Date }>('SELECT attempts, done_at, run_at FROM jobs WHERE id=$1', [id]))[0];
    expect(row.attempts).toBe(1);
    expect(row.done_at).toBeNull();
    expect(row.run_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
    await deps.db.query('UPDATE jobs SET run_at=now() WHERE id=$1', [id]);
    const j2 = await claim(deps.db, 'w');
    expect(j2?.attempts).toBe(2);
    await fail(deps.db, j2!.id, 'boom again');
    row = (await deps.db.query('SELECT attempts, done_at, run_at, error FROM jobs WHERE id=$1', [id]))[0] as never;
    expect((row as { done_at: Date | null }).done_at).not.toBeNull();
  });

  it('a stale lock is re-claimed and counts one more attempt (crash-safe cap)', async () => {
    const id = await withOrg(TEST_ORG_ID, () => enqueue(deps.db, 'k', {}, { maxAttempts: 2 }));
    await claim(deps.db, 'w1');
    await deps.db.query(`UPDATE jobs SET locked_at = now() - interval '6 minutes' WHERE id=$1`, [id]);
    const again = await claim(deps.db, 'w2');
    expect(again?.id).toBe(id);
    expect(again?.attempts).toBe(2);
  });

  it('a recurring job is re-armed after success, never completed', async () => {
    await ensureRecurring(deps.db, 'tick', 30);
    await deps.db.query(`UPDATE jobs SET run_at=now() WHERE kind='tick'`);
    let ran = 0;
    const s = createScheduler(deps.db, { tick: async () => { ran++; } }, { workerId: 't' });
    expect(await s.tick()).toBe(1);
    const row = (await deps.db.query<{ done_at: Date | null; run_at: Date; attempts: number; locked_by: string | null }>(`SELECT done_at, run_at, attempts, locked_by FROM jobs WHERE kind='tick'`))[0];
    expect(ran).toBe(1);
    expect(row.done_at).toBeNull();
    expect(row.locked_by).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.run_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await s.tick()).toBe(0);
  });

  it('a failing recurring job records the error and re-arms to its next slot', async () => {
    await ensureRecurring(deps.db, 'tick', 30);
    await deps.db.query(`UPDATE jobs SET run_at=now() WHERE kind='tick'`);
    const s = createScheduler(deps.db, { tick: async () => { throw new Error('tick broke'); } }, { workerId: 't' });
    expect(await s.tick()).toBe(1);
    const row = (await deps.db.query<{ done_at: Date | null; run_at: Date; error: string | null }>(`SELECT done_at, run_at, error FROM jobs WHERE kind='tick'`))[0];
    expect(row.done_at).toBeNull();
    expect(row.error).toBe('tick broke');
    expect(row.run_at.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it('records the time of the last tick', async () => {
    const s = createScheduler(deps.db, {}, { workerId: 't' });
    expect(s.lastTickAt()).toBeNull();
    await s.tick();
    expect(s.lastTickAt()).toBeInstanceOf(Date);
  });

  it('rearm without payload.everySeconds still re-arms about 300s out, never leaving run_at NULL', async () => {
    const id = await withOrg(TEST_ORG_ID, () => enqueue(deps.db, 'k', {}, {}));
    await deps.db.query(`UPDATE jobs SET recurring=true WHERE id=$1`, [id]);
    const s = createScheduler(deps.db, { k: async () => {} }, { workerId: 't' });
    expect(await s.tick()).toBe(1);
    const row = (await deps.db.query<{ run_at: Date | null }>('SELECT run_at FROM jobs WHERE id=$1', [id]))[0];
    expect(row.run_at).not.toBeNull();
    expect(row.run_at!.getTime()).toBeGreaterThan(Date.now() + 250_000);
    expect(row.run_at!.getTime()).toBeLessThan(Date.now() + 350_000);
  });

  it('ensureRecurring inserts once', async () => {
    await ensureRecurring(deps.db, 'tick', 30);
    await ensureRecurring(deps.db, 'tick', 30);
    const rows = await deps.db.query(`SELECT 1 FROM jobs WHERE kind='tick' AND done_at IS NULL`);
    expect(rows.length).toBe(1);
  });

  it('ensureRecurring is race-safe under concurrent callers', async () => {
    await Promise.all(Array.from({ length: 10 }, () => ensureRecurring(deps.db, 'tick', 30)));
    const rows = await deps.db.query(`SELECT 1 FROM jobs WHERE kind='tick' AND done_at IS NULL`);
    expect(rows.length).toBe(1);
  });

  it('scheduler runs handlers', async () => {
    const seen: unknown[] = [];
    await withOrg(TEST_ORG_ID, () => enqueue(deps.db, 'echo', { v: 'a' }));
    const s = createScheduler(deps.db, { echo: async (p) => { seen.push(p); } }, { workerId: 't' });
    expect(await s.tick()).toBe(1);
    expect(seen).toEqual([{ v: 'a', orgId: TEST_ORG_ID }]);
    expect(await s.tick()).toBe(0);
  });

  it('a throwing handler does not stop the loop; other jobs still run', async () => {
    const seen: unknown[] = [];
    const boomId = await withOrg(TEST_ORG_ID, () => enqueue(deps.db, 'boom', {}));
    await withOrg(TEST_ORG_ID, () => enqueue(deps.db, 'echo', { v: 'a' }));
    const s = createScheduler(deps.db, {
      boom: async () => { throw new Error('kaboom'); },
      echo: async (p) => { seen.push(p); },
    }, { workerId: 't2' });
    expect(await s.tick()).toBe(2);
    expect(seen).toEqual([{ v: 'a', orgId: TEST_ORG_ID }]);
    const row = (await deps.db.query<{ attempts: number; error: string | null; done_at: Date | null }>(
      'SELECT attempts, error, done_at FROM jobs WHERE id=$1', [boomId]))[0];
    expect(row.attempts).toBe(1);
    expect(row.error).toBe('kaboom');
    expect(row.done_at).toBeNull();
  });

  it('a missing handler fails the job through fail() and does not stop the loop', async () => {
    const id = await withOrg(TEST_ORG_ID, () => enqueue(deps.db, 'nohandler', {}, { maxAttempts: 1 }));
    const s = createScheduler(deps.db, {}, { workerId: 't3' });
    expect(await s.tick()).toBe(1);
    const row = (await deps.db.query<{ done_at: Date | null; error: string | null }>(
      'SELECT done_at, error FROM jobs WHERE id=$1', [id]))[0];
    expect(row.done_at).not.toBeNull();
    expect(row.error).toMatch(/no handler/);
  });
});
