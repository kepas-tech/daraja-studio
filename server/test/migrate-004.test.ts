import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { testDeps, resetTables } from './helpers.js';

const deps = testDeps();
afterAll(() => deps.db.end());

async function insert(status: string, extra: Record<string, unknown> = {}) {
  const cols = ['type', 'originator_conversation_id', 'status', ...Object.keys(extra)];
  const vals = ['b2c', `oc-${Math.random().toString(36).slice(2)}`, status, ...Object.values(extra)];
  const [row] = await deps.db.query<{ id: string }>(
    `INSERT INTO requests(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
  return row.id;
}

describe('migration 004', () => {
  beforeEach(() => resetTables(deps.db));

  it('adds the columns with their defaults and the indexes', async () => {
    const id = await insert('pending');
    const [r] = await deps.db.query<{ poll_attempts: number; last_poll_at: Date | null; checked_by: string | null; checked_at: Date | null; checked_note: string | null; updated_at: Date }>(
      'SELECT poll_attempts, last_poll_at, checked_by, checked_at, checked_note, updated_at FROM requests WHERE id=$1', [id]);
    expect(r.poll_attempts).toBe(0);
    expect(r.last_poll_at).toBeNull();
    expect(r.checked_by).toBeNull();
    expect(r.updated_at).toBeInstanceOf(Date);
    const idx = (await deps.db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE tablename='requests'`)).map((x) => x.indexname);
    // requests_dup_guard_idx and requests_created_by_idx were migration 004's; migration 007
    // replaced both with organisation-prefixed versions (requests_org_dup_guard_idx,
    // requests_org_created_idx) once every hot query on requests is scoped by org_id.
    for (const name of ['requests_conversation_idx', 'requests_receipt_idx', 'requests_org_dup_guard_idx', 'requests_org_created_idx']) expect(idx).toContain(name);
  });

  it('touch trigger bumps updated_at on every update', async () => {
    const id = await insert('pending');
    const [before] = await deps.db.query<{ updated_at: Date }>('SELECT updated_at FROM requests WHERE id=$1', [id]);
    await new Promise((r) => setTimeout(r, 5));
    await deps.db.query(`UPDATE requests SET status='sent' WHERE id=$1`, [id]);
    const [after] = await deps.db.query<{ updated_at: Date }>('SELECT updated_at FROM requests WHERE id=$1', [id]);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('a final row rejects a callback-style change of status or receipt', async () => {
    const id = await insert('completed', { receipt: 'RI1' });
    await expect(deps.db.query(`UPDATE requests SET status='failed', result_source='callback' WHERE id=$1`, [id])).rejects.toThrow(/is final/);
    await expect(deps.db.query(`UPDATE requests SET receipt='RI2' WHERE id=$1`, [id])).rejects.toThrow(/is final/);
  });

  it('a final row accepts a poll-sourced override (status result is authoritative)', async () => {
    const id = await insert('completed', { receipt: 'RI1' });
    await deps.db.query(`UPDATE requests SET status='failed', result_source='poll', result_code='1', result_desc='x' WHERE id=$1`, [id]);
    const [r] = await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [id]);
    expect(r.status).toBe('failed');
  });

  it('a final row still accepts harmless updates (e.g. recipient_name backfill) and unknown stays mutable', async () => {
    const done = await insert('completed');
    await deps.db.query(`UPDATE requests SET recipient_name='Jane Doe' WHERE id=$1`, [done]);
    const unk = await insert('unknown');
    await deps.db.query(`UPDATE requests SET status='completed', result_source='callback', receipt='RI9' WHERE id=$1`, [unk]);
    await deps.db.query(`UPDATE requests SET checked_note='n' WHERE id=$1`, [unk]);
    const [r] = await deps.db.query<{ status: string; receipt: string }>('SELECT status, receipt FROM requests WHERE id=$1', [unk]);
    expect(r.status).toBe('completed');
    expect(r.receipt).toBe('RI9');
  });
});
