import { nairobi } from '../sweep/window.js';

/**
 * When a scheduled payment is due. Every date here is a Nairobi calendar date written YYYY-MM-DD,
 * and every hour the Nairobi hour, never the server's: "on the 30th at nine" is what the business
 * chose.
 *
 * Two dates matter for each payment and they are kept apart on purpose:
 *
 *   the nominal date   the date the timetable names: "the 31st", "every Friday". It is the pay run's
 *                      key, so a retry, a restart or a clock slip always lands on the same row.
 *   the pay date       the day the money actually goes: the nominal date, or the Friday before it
 *                      when the business asked for weekends to move earlier.
 */
export const EVERY = ['daily', 'weekly', 'fortnightly', 'monthly'] as const;
export type Every = (typeof EVERY)[number];
/**
 * `on_day` pays on the date whatever day it is. `before` (monthly) moves a Saturday or Sunday to
 * the Friday before. `skip` (daily) pays Monday to Friday only.
 */
export const WEEKEND_RULES = ['on_day', 'before', 'skip'] as const;
export type WeekendRule = (typeof WEEKEND_RULES)[number];

export interface Timetable {
  every: Every;
  /** 0 is Monday. Used by weekly and fortnightly. */
  weekday: number;
  /** 1 to 31. Used by monthly; a day the month does not have means its last day. */
  dayOfMonth: number;
  /** The Nairobi hour the payment goes, 0 to 23. */
  hour: number;
  weekendRule: WeekendRule;
  startOn: string;
  /** Empty means until it is stopped. */
  endOn: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const toMs = (date: string): number => Date.parse(date + 'T00:00:00Z');
const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, days: number): string => toDate(toMs(date) + days * DAY_MS);
/** Monday is 0, as a Kenyan week is read. */
export const weekdayOf = (date: string): number => (new Date(toMs(date)).getUTCDay() + 6) % 7;
const isWeekend = (date: string): boolean => weekdayOf(date) >= 5;
const lastDayOf = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The date a nominal date is actually paid on. */
export function payDateOf(t: Timetable, nominal: string): string {
  if (t.weekendRule === 'before' && isWeekend(nominal)) return addDays(nominal, -(weekdayOf(nominal) - 4));
  return nominal;
}

/** The first nominal date on or after `from` (and on or after the start), or null once past the end. */
export function nextOccurrence(t: Timetable, from: string): string | null {
  let d = from < t.startOn ? t.startOn : from;
  let found: string;
  switch (t.every) {
    case 'daily': {
      while (t.weekendRule === 'skip' && isWeekend(d)) d = addDays(d, 1);
      found = d;
      break;
    }
    case 'weekly': {
      found = addDays(d, (t.weekday - weekdayOf(d) + 7) % 7);
      break;
    }
    case 'fortnightly': {
      // Anchored on the first such weekday on or after the start, then every fourteen days.
      const anchor = addDays(t.startOn, (t.weekday - weekdayOf(t.startOn) + 7) % 7);
      if (d <= anchor) { found = anchor; break; }
      const steps = Math.ceil((toMs(d) - toMs(anchor)) / (14 * DAY_MS));
      found = addDays(anchor, steps * 14);
      break;
    }
    case 'monthly': {
      let y = Number(d.slice(0, 4)); let m = Number(d.slice(5, 7)) - 1;
      for (;;) {
        const day = Math.min(t.dayOfMonth, lastDayOf(y, m));
        const candidate = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (candidate >= d) { found = candidate; break; }
        m += 1; if (m === 12) { m = 0; y += 1; }
      }
      break;
    }
  }
  if (t.endOn && found > t.endOn) return null;
  return found;
}

/** The next `count` payments from `from`, as nominal and pay dates: what the warning screen shows. */
export function upcoming(t: Timetable, from: string, count: number): { nominal: string; payOn: string }[] {
  const out: { nominal: string; payOn: string }[] = [];
  let d: string | null = from;
  while (out.length < count && d) {
    const n = nextOccurrence(t, d);
    if (!n) break;
    out.push({ nominal: n, payOn: payDateOf(t, n) });
    d = addDays(n, 1);
  }
  return out;
}

/** Whether the payment for this nominal date is due at this instant. */
export function isDue(t: Timetable, nominal: string, now: Date): boolean {
  const clock = nairobi(now);
  const payOn = payDateOf(t, nominal);
  return clock.date > payOn || (clock.date === payOn && clock.hour >= t.hour);
}

/** Today on the Nairobi clock. */
export const todayNairobi = (now: Date): string => nairobi(now).date;

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ordinal = (n: number): string => {
  if (n % 100 >= 11 && n % 100 <= 13) return n + 'th';
  return n + (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');
};
const at = (hour: number): string => {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? 'am' : 'pm'}`;
};

/** The timetable in the owner's words: "every month on the 30th at 9am". */
export function timetableWords(t: Timetable): string {
  switch (t.every) {
    case 'daily': return (t.weekendRule === 'skip' ? 'every weekday' : 'every day') + ' at ' + at(t.hour);
    case 'weekly': return 'every ' + WEEKDAYS[t.weekday] + ' at ' + at(t.hour);
    case 'fortnightly': return 'every other ' + WEEKDAYS[t.weekday] + ' at ' + at(t.hour);
    case 'monthly': return 'every month on the ' + ordinal(t.dayOfMonth) + ' at ' + at(t.hour)
      + (t.dayOfMonth > 28 ? ', or the last day of a shorter month' : '')
      + (t.weekendRule === 'before' ? ', a weekend moved to the Friday before' : '');
  }
}
