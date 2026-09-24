import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('the password check', () => {
  it('says yes and no for a real hash', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('says no for a stored value that is not a hash at all', async () => {
    expect(await verifyPassword('x', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('refuses to call a check that could not run a wrong password', async () => {
    await expect(verifyPassword('$argon2id$v=19$broken', 'anything')).rejects.toMatchObject({ status: 503, code: 'check_failed' });
  });
});
