import { describe, it, expect } from 'vitest';
import { isDue, nextOccurrence, payDateOf, timetableWords, upcoming, type Timetable } from '../src/schedules/timetable.js';

const base: Timetable = { every: 'monthly', weekday: 0, dayOfMonth: 31, hour: 9, weekendRule: 'on_day', startOn: '2026-01-01', endOn: null };

describe('scheduled payments: the timetable', () => {
  it('rule 1: a monthly schedule on the 31st pays on 30 June and on 28 February', () => {
    expect(nextOccurrence(base, '2026-06-01')).toBe('2026-06-30');
    expect(nextOccurrence(base, '2027-02-01')).toBe('2027-02-28');
    expect(nextOccurrence(base, '2028-02-01')).toBe('2028-02-29');
    // and never spills into the next month
    expect(nextOccurrence(base, '2026-07-01')).toBe('2026-07-31');
  });

  it('moves a weekend to the Friday before, only when asked to', () => {
    const t = { ...base, dayOfMonth: 31, weekendRule: 'before' as const };
    // 31 October 2026 is a Saturday; 31 January 2027 a Sunday.
    expect(payDateOf(t, '2026-10-31')).toBe('2026-10-30');
    expect(payDateOf(t, '2027-01-31')).toBe('2027-01-29');
    expect(payDateOf({ ...t, weekendRule: 'on_day' }, '2026-10-31')).toBe('2026-10-31');
  });

  it('weekly, fortnightly and daily land on the right days', () => {
    // 24 September 2026 is a Thursday. Friday is 4.
    expect(nextOccurrence({ ...base, every: 'weekly', weekday: 4 }, '2026-09-24')).toBe('2026-09-25');
    const fortnight = { ...base, every: 'fortnightly' as const, weekday: 4, startOn: '2026-09-24' };
    expect(upcoming(fortnight, '2026-09-24', 3).map((u) => u.nominal)).toEqual(['2026-09-25', '2026-10-09', '2026-10-23']);
    expect(nextOccurrence(fortnight, '2026-09-26')).toBe('2026-10-09');
    const weekdays = { ...base, every: 'daily' as const, weekendRule: 'skip' as const };
    expect(nextOccurrence(weekdays, '2026-09-26')).toBe('2026-09-28');
    expect(nextOccurrence({ ...weekdays, weekendRule: 'on_day' }, '2026-09-26')).toBe('2026-09-26');
  });

  it('respects the start and the end', () => {
    const t = { ...base, dayOfMonth: 5, startOn: '2026-10-01', endOn: '2026-11-30' };
    expect(upcoming(t, '2026-09-01', 5).map((u) => u.nominal)).toEqual(['2026-10-05', '2026-11-05']);
  });

  it('is due from the hour on the Nairobi pay date, and stays due after it', () => {
    const t = { ...base, dayOfMonth: 30 };
    // 06:00Z is 09:00 in Nairobi.
    expect(isDue(t, '2026-09-30', new Date('2026-09-30T05:59:00Z'))).toBe(false);
    expect(isDue(t, '2026-09-30', new Date('2026-09-30T06:00:00Z'))).toBe(true);
    expect(isDue(t, '2026-09-30', new Date('2026-10-02T01:00:00Z'))).toBe(true);
  });

  it('says the timetable in plain words', () => {
    expect(timetableWords({ ...base, dayOfMonth: 30 })).toBe('every month on the 30th at 9am, or the last day of a shorter month');
    expect(timetableWords({ ...base, every: 'weekly', weekday: 4, hour: 17 })).toBe('every Friday at 5pm');
    expect(timetableWords({ ...base, every: 'daily', weekendRule: 'skip', hour: 12 })).toBe('every weekday at 12pm');
  });
});
