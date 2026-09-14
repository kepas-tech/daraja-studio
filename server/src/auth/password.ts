import argon2 from 'argon2';
export const MIN_PASSWORD_LENGTH = 12;
export function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}
export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try { return await argon2.verify(hash, pw); } catch { return false; }
}
// Computed once at module load so the login route can run exactly one argon2id verify per
// request even when the username doesn't exist — otherwise an unknown username would skip
// argon2 entirely (~1ms) while a known username costs a real verify (tens of ms), letting
// response timing reveal whether an account exists.
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing-parity');
