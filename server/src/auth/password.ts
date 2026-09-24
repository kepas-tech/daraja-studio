import { HttpError } from '../util/errors.js';
import argon2 from 'argon2';
export const MIN_PASSWORD_LENGTH = 12;
export function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}
/**
 * A wrong password is `false`. A stored value that is not an argon2 hash at all (an account made
 * without a password) is also `false`: there is nothing it could match. Anything else argon2 throws
 * is the server failing to check — memory it could not get, a broken build — and that is not a
 * wrong password: it is logged and answered as a check that could not run, so the person is told
 * to try again instead of being told their own password is wrong in front of a payment.
 */
export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  if (!hash.startsWith('$argon2')) return false;
  try { return await argon2.verify(hash, pw); }
  catch (e) {
    console.error('password check could not run', e instanceof Error ? e.name + ': ' + e.message : 'error');
    throw new HttpError(503, 'check_failed', 'Studio could not check the password just now. Try again in a moment.');
  }
}
// Computed once at module load so the login route can run exactly one argon2id verify per
// request even when the username doesn't exist — otherwise an unknown username would skip
// argon2 entirely (~1ms) while a known username costs a real verify (tens of ms), letting
// response timing reveal whether an account exists.
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing-parity');
