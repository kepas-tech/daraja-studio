import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { testDeps, resetTables } from './helpers.js';
import { createCriticalBuzzer, MAX_BUZZ } from '../src/notifications/buzz.js';
import type { EventHub } from '../src/events/hub.js';
import type { PushService } from '../src/push/service.js';

/**
 * Round 3, phase D-8: an unread critical alert keeps making itself known until somebody reads it.
 *
 * The pass is driven directly here rather than through the scheduler: what is under test is the
 * rule (who is due, how often, and when it stops), not the timer that calls it.
 */
const deps = testDeps();
afterAll(() => deps.db.end());

const publish = vi.fn(async () => {});
const notify = vi.fn(async () => {});
const events = { publish } as unknown as EventHub;
const push = { configured: () => true, notify } as unknown as PushService;

async function write(severity: string, over: { read?: boolean; buzzCount?: number; lastBuzzedAt?: string } = {}) {
  const [row] = await deps.db.query<{ id: string }>(
    `INSERT INTO notifications(severity, category, type, title, body, dedupe_key, read_at, buzz_count, last_buzzed_at)
     VALUES ($1,'operators','operator.failed','Operator problem','Safaricom refused the key.', 'k-' || gen_random_uuid(),
             CASE WHEN $2 THEN now() ELSE NULL END, $3, $4::timestamptz)
     RETURNING id`,
    [severity, over.read ?? false, over.buzzCount ?? 0, over.lastBuzzedAt ?? null],
  );
  return row.id;
}

describe('an unread critical alert', () => {
  beforeEach(async () => { await resetTables(deps.db); publish.mockClear(); notify.mockClear(); });

  it('is reminded about at once, and left alone until the window passes', async () => {
    await write('critical');
    const buzzer = createCriticalBuzzer({ db: deps.db, events, push });

    const first = await buzzer.buzzOnce();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ title: 'Operator problem', times: 1, exhausted: false });
    expect(publish).toHaveBeenCalledWith('notification.buzz', expect.objectContaining({ times: 1, exhausted: false }), expect.anything());
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical', title: 'Still unread: Operator problem', body: 'Safaricom refused the key.',
    }));

    const [row] = await deps.db.query<{ buzz_count: number; last_buzzed_at: Date | null; read_at: Date | null }>('SELECT buzz_count, last_buzzed_at, read_at FROM notifications');
    expect(row.buzz_count).toBe(1);
    expect(row.last_buzzed_at).toBeTruthy();
    expect(row.read_at).toBeNull();

    // The very next pass: nothing. Fifteen minutes have not gone by.
    expect(await buzzer.buzzOnce()).toEqual([]);
  });

  it('is reminded about again once the window has passed, with a fresh tag each time', async () => {
    await write('critical', { buzzCount: 1, lastBuzzedAt: '2020-01-01T00:00:00Z' });
    const buzzer = createCriticalBuzzer({ db: deps.db, events, push });
    const again = await buzzer.buzzOnce();
    expect(again[0]).toMatchObject({ times: 2, exhausted: false });
    // A fresh tag per reminder on purpose: the device shows this one instead of replacing the last.
    expect((notify.mock.calls[0]![0] as { dedupeKey: string }).dedupeKey).toMatch(/^buzz:.*:2$/);
  });

  it('is never reminded about once it is read, nor is anything that is not critical', async () => {
    await write('critical', { read: true });
    await write('warning');
    await write('info');
    const buzzer = createCriticalBuzzer({ db: deps.db, events, push });
    expect(await buzzer.buzzOnce()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('stops at the cap, and says so on the last reminder', async () => {
    await write('critical', { buzzCount: MAX_BUZZ - 1, lastBuzzedAt: '2020-01-01T00:00:00Z' });
    const buzzer = createCriticalBuzzer({ db: deps.db, events, push });
    const last = await buzzer.buzzOnce();
    expect(last[0]).toMatchObject({ times: MAX_BUZZ, exhausted: true });
    expect(publish).toHaveBeenCalledWith('notification.buzz', expect.objectContaining({ exhausted: true }), expect.anything());
    // The cap is the count, so a pass after it has nothing left to do however long it has been.
    await deps.db.query(`UPDATE notifications SET last_buzzed_at = '2020-01-01'`);
    expect(await buzzer.buzzOnce()).toEqual([]);
  });

  it('still stamps and publishes when push is off, so an open tab is enough', async () => {
    await write('critical');
    const buzzer = createCriticalBuzzer({ db: deps.db, events, push: undefined });
    expect(await buzzer.buzzOnce()).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect((await deps.db.query<{ buzz_count: number }>('SELECT buzz_count FROM notifications'))[0]!.buzz_count).toBe(1);
  });
});
