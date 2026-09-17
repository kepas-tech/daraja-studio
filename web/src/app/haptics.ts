/**
 * The lock screen's haptics, copied from kepas-pay's keypad: a light 30 ms tap on every key,
 * 25/40/90 on a successful open, and 60 ms on a refusal. A browser without vibration (desktop, and
 * every test) is fine — the call is wrapped, never assumed.
 */
export const BUZZ = { key: 30, ok: [25, 40, 90], no: 60 } as const;

type Vibrate = (pattern: number | number[]) => boolean;

export function buzz(pattern: number | number[]): void {
  try {
    const vibrate = (navigator as unknown as { vibrate?: Vibrate }).vibrate;
    if (typeof vibrate === 'function') vibrate.call(navigator, pattern);
  } catch { /* a browser without it is fine */ }
}
