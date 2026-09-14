import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDeps, resetTables } from './helpers.js';
import { seedPublicUrl } from '../src/boot/seed.js';

const deps = testDeps();
afterAll(async () => {
  // Other test files (e.g. settings.test.ts) share this database and assume a clean
  // `settings` table for keys they don't set themselves — leave the ones this file touches
  // as it found them.
  await deps.settings.delete('public.url');
  await deps.settings.delete('public.verifiedAt');
  await deps.db.end();
});

describe('seedPublicUrl', () => {
  beforeAll(() => resetTables(deps.db));

  it('rejects a non-https address', async () => {
    await expect(seedPublicUrl(deps.settings, 'http://x.example')).rejects.toMatchObject({ status: 400 });
  });

  it('seeds a new value and clears any verified stamp', async () => {
    await deps.settings.set('public.url', 'https://old.example');
    await deps.settings.set('public.verifiedAt', new Date().toISOString());

    const result = await seedPublicUrl(deps.settings, 'https://new.example');

    expect(result).toBe('updated');
    expect(await deps.settings.get('public.url')).toBe('https://new.example');
    expect(await deps.settings.get('public.verifiedAt')).toBeNull();
  });

  it('leaves an unchanged value, and its verified stamp, alone', async () => {
    await deps.settings.set('public.url', 'https://same.example');
    await deps.settings.set('public.verifiedAt', '2026-01-01T00:00:00.000Z');

    const result = await seedPublicUrl(deps.settings, 'https://same.example');

    expect(result).toBe('unchanged');
    expect(await deps.settings.get('public.verifiedAt')).toBe('2026-01-01T00:00:00.000Z');
  });
});
