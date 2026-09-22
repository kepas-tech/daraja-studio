import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../src/db/migrate.js';
import { testDeps } from './helpers.js';

const deps = testDeps();
afterAll(() => deps.db.end());
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * A migration the runner cannot read is the failure that took the live site down twice. It has to
 * arrive as a sentence about the file and its permissions, not as a raw EACCES from inside readFile.
 */
describe('a migration nobody can read', () => {
  it('names the file and says its permissions are wrong, rather than throwing a raw EACCES', async () => {
    if (asRoot) {
      // Root reads a mode-000 file, so the failure cannot be produced here.
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-locked-'));
    const locked = path.join(dir, '002_locked.sql');
    try {
      await fs.writeFile(path.join(dir, '001_first.sql'), 'SELECT 1;\n');
      await fs.writeFile(locked, 'SELECT 2;\n');
      await fs.chmod(locked, 0o000);

      const thrown = (await migrate(deps.db, dir).catch((e: Error) => e)) as Error;
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain(locked);
      expect(thrown.message).toContain('its file permissions are wrong');
      expect(thrown.message).toContain('mode 644');
      // The raw code is not the boot message.
      expect(thrown.message).not.toContain('EACCES');
    } finally {
      await fs.chmod(locked, 0o644).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
