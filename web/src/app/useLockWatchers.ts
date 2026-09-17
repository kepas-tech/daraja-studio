import { useEffect } from 'react';
import { useSession } from './session';

/** How long Studio may sit untouched before it locks itself (brief 2, item 3). */
export const LOCK_IDLE_MS = 30 * 60 * 1000;

/** Anything a person does counts as using the page; none of these need the event itself. */
const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

/**
 * The two ways a session locks itself, both of them the ones the brief names. Leaving the page locks
 * it there and then, so a phone picked up in the meantime is already locked on the server when it
 * comes back into view (KEPAS Pay's visibilitychange rule). Thirty quiet minutes lock it too. The
 * server holds the same rules on its own — a session whose PIN was entered longer ago than PIN_IDLE_MINUTES is
 * locked whether this ever ran or not (auth/pin.ts) — so nothing here is the only line of defence.
 */
export function useLockWatchers() {
  const { pinSet, pinLocked, lock } = useSession();
  useEffect(() => {
    if (!pinSet || pinLocked) return;
    const onVisibility = () => { if (document.visibilityState === 'hidden') void lock(); };
    document.addEventListener('visibilitychange', onVisibility);
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void lock(), LOCK_IDLE_MS);
    };
    ACTIVITY.forEach((e) => document.addEventListener(e, arm, { passive: true }));
    arm();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      ACTIVITY.forEach((e) => document.removeEventListener(e, arm));
      window.clearTimeout(timer);
    };
  }, [pinSet, pinLocked, lock]);
}
