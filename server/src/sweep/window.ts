/**
 * When a sweep is due, and what one window is called.
 *
 * Every hour below is Africa/Nairobi's, never the server's, because "daily at eight" is what the
 * business chose. Kenya has never had a daylight-saving shift, so the offset is a constant and
 * never a table.
 */
export const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * How long "as it arrives" lets money sit before it goes: at most this, and usually less. It is
 * also the window's width, which is what stops two scheduler passes a few seconds apart from
 * making two sweeps of the same money — the second pass finds the window already swept.
 */
export const ARRIVAL_BUCKET_MS = 5 * 60 * 1000;

export const SCHEDULES = ['arrival', 'daily', 'weekly'] as const;
export type Schedule = (typeof SCHEDULES)[number];

export interface Timetable { schedule: Schedule; hour: number; weekday: number }

/** The window a run is for, and whether the timetable says that window is open yet. */
export interface Window { window: string; due: boolean }

/** The length of one Nairobi day, which is a whole number of milliseconds and never varies. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Nairobi wall clock, read off an instant: the date, the hour and the weekday (Monday is 0). */
export function nairobi(now: Date): { date: string; hour: number; minute: number; weekday: number } {
  const shifted = new Date(now.getTime() + NAIROBI_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    // getUTCDay() is Sunday-first; a Kenyan week starts on Monday, and so does this.
    weekday: (shifted.getUTCDay() + 6) % 7,
  };
}

/** The date this many days before another one, both written YYYY-MM-DD. */
const daysBefore = (date: string, days: number): string =>
  new Date(Date.parse(date + 'T00:00:00Z') - days * DAY_MS).toISOString().slice(0, 10);

/**
 * One window per timetable, named so two servers with two clocks still agree:
 *
 *   arrival:2026-09-19T18:05   five minutes wide, so money waits minutes at most
 *   daily:2026-09-19           the Nairobi day, swept on the first pass at or after its hour
 *   weekly:2026-09-14          the Monday itself, swept on the first pass that day
 *
 * A daily or weekly window whose hour or day has passed is still due, and stays due until it has
 * been swept: a restart at four in the afternoon must not cost a business its nine o'clock sweep.
 * Once swept, the row for that window exists and the next pass finds it — see the unique index on
 * (business_id, window), which is what makes that true across two schedulers as well.
 */
export function windowFor(t: Timetable, now: Date): Window {
  if (t.schedule === 'arrival') {
    const bucket = Math.floor(now.getTime() / ARRIVAL_BUCKET_MS) * ARRIVAL_BUCKET_MS;
    // Labelled on the Nairobi clock, like the other two, so a person reading it is not doing sums.
    const label = new Date(bucket + NAIROBI_OFFSET_MS).toISOString().slice(0, 16);
    return { window: 'arrival:' + label, due: true };
  }
  const n = nairobi(now);
  if (t.schedule === 'daily') return { window: 'daily:' + n.date, due: n.hour >= t.hour };
  // The most recent chosen weekday at or before today. Before that day in the week, this is last
  // week's — already swept, so nothing happens — and the next one opens when the day comes round.
  const back = (n.weekday - t.weekday + 7) % 7;
  return { window: 'weekly:' + daysBefore(n.date, back), due: true };
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Two digits, the way a clock is read. */
const pad = (n: number): string => String(n).padStart(2, '0');

/** The timetable in the owner's own words, for the page and for the line that says why nothing left. */
export function timetableWords(t: Timetable): string {
  if (t.schedule === 'arrival') return 'as soon as it arrives';
  if (t.schedule === 'daily') return 'every day at ' + pad(t.hour) + ':00';
  return 'every ' + (WEEKDAYS[t.weekday] ?? WEEKDAYS[0]);
}
