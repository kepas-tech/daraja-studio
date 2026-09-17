import type { Db } from '../db/pool.js';
import { HttpError } from '../util/errors.js';
import { clearFailures, recordAttempt } from './lockout.js';
import { hashPassword, verifyPassword } from './password.js';

/** A PIN is exactly six digits: the shape a phone keypad makes quick, and nothing else. */
export const PIN_LENGTH = 6;
export const PIN_PATTERN = /^\d{6}$/;
/** How long an unlocked session stays unlocked without the PIN being entered again. */
export const PIN_IDLE_MINUTES = 30;
/** Wrong PINs are counted here, apart from the password's own `stepup:` counter. */
export const pinKey = (personId: string) => `pin:${personId}`;

/**
 * The same argon2id settings as a password, because a six-digit secret needs them more: a PIN space
 * is small enough to walk through, so the cost per guess is the whole defence, together with the
 * five-try lock below.
 */
export const hashPin = hashPassword;
export const verifyPin = verifyPassword;

/**
 * True while a PIN is set and this session has not been unlocked recently. `pinFresh` comes from
 * the session row itself (sessions.ts), computed against the database's own clock: an unlocked
 * session that has sat idle for longer than PIN_IDLE_MINUTES is locked again without anything
 * having to run.
 */
export function isLocked(pinHash: string | null | undefined, pinFresh: boolean | null | undefined): boolean {
  return !!pinHash && pinFresh !== true;
}

/**
 * One PIN check, counted. Five wrong tries lock the PIN for fifteen minutes — the same counter and
 * the same rule as a wrong password, but its own key, so guessing PINs cannot lock the password out
 * and the password always remains a way back in. The attempt is recorded before the comparison
 * (lockout.ts's UPSERT ... RETURNING is the gate), so a burst of guesses cannot slip past it.
 */
export async function checkPin(db: Db, personId: string, pinHash: string, pin: string): Promise<void> {
  const key = pinKey(personId);
  const attempt = await recordAttempt(db, [key]);
  if (attempt.lockedUntil && attempt.lockedUntil > new Date()) {
    throw new HttpError(423, 'pin_locked', 'Too many wrong tries. Wait 15 minutes, or use your password.');
  }
  if (!(await verifyPin(pinHash, pin))) throw new HttpError(403, 'pin_wrong', 'That PIN is wrong.');
  await clearFailures(db, [key]);
}
