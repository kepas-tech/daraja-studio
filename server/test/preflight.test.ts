import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'deploy', 'preflight.sh');
/** Root reads a mode-000 file, so the refusal cannot be shown as root. */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function modeOf(file: string): Promise<string> {
  return ((await fs.stat(file)).mode & 0o777).toString(8).padStart(3, '0');
}

async function preflight(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run('bash', [SCRIPT, ...args]);
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const failed = e as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: failed.stdout ?? '', err: failed.stderr ?? '' };
  }
}

/**
 * The deploy preflight, on scratch copies — never the real tree, never the live site. A migration
 * whose mode leaves it unreadable to the container's user has taken the live site down twice; this is
 * the check that runs before the sync.
 */
describe('the deploy preflight', () => {
  let scratch: string;
  let core: string;
  let ext: string;

  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-'));
    core = path.join(scratch, 'migrations');
    ext = path.join(scratch, 'package-migrations');
    await fs.mkdir(core);
    await fs.mkdir(ext);
    await fs.writeFile(path.join(core, '001_first.sql'), 'SELECT 1;\n');
    await fs.writeFile(path.join(core, '002_second.sql'), 'SELECT 2;\n');
    await fs.writeFile(path.join(ext, '900_tenants.sql'), 'SELECT 3;\n');
  });

  afterAll(async () => {
    await fs.chmod(core, 0o755).catch(() => {});
    await fs.chmod(ext, 0o755).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('normalises a file the deploy user can read but the container could not, and names it', async () => {
    // 600 is the exact mode that took the live site down: readable here, not for the studio user.
    await fs.chmod(path.join(core, '002_second.sql'), 0o600);
    await fs.chmod(path.join(ext, '900_tenants.sql'), 0o600);
    const r = await preflight(['--core', core, '--extension', ext]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('normalised to 644');
    expect(r.out).toContain('002_second.sql');
    expect(r.out).toContain('900_tenants.sql');
    expect(r.out).toContain('3 migration file(s) are readable and 644');
    expect(await modeOf(path.join(core, '002_second.sql'))).toBe('644');
    expect(await modeOf(path.join(ext, '900_tenants.sql'))).toBe('644');
  });

  it('refuses a migration it cannot read, names it and the command, and passes once it is fixed', async () => {
    if (asRoot) return;
    const locked = path.join(ext, '901_locked.sql');
    await fs.writeFile(locked, 'SELECT 4;\n');
    await fs.chmod(locked, 0o000);

    const refused = await preflight(['--core', core, '--extension', ext]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(locked);
    expect(refused.err).toContain('not readable');
    expect(refused.err).toContain('chmod 644');
    expect(refused.err).toContain('refusing to deploy');
    // It refuses rather than quietly loosening a file nobody at all can read.
    expect(await modeOf(locked)).toBe('000');

    await fs.chmod(locked, 0o644);
    const passed = await preflight(['--core', core, '--extension', ext]);
    expect(passed.code).toBe(0);
    expect(passed.out).toContain('readable and 644');
  });

  it('refuses when the migrations directory itself cannot be read', async () => {
    if (asRoot) return;
    const lockedDir = path.join(scratch, 'locked-migrations');
    await fs.mkdir(lockedDir);
    await fs.writeFile(path.join(lockedDir, '001_first.sql'), 'SELECT 1;\n');
    await fs.chmod(lockedDir, 0o000);
    try {
      const r = await preflight(['--core', lockedDir]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(lockedDir);
      expect(r.err).toContain('cannot be read and searched');
    } finally {
      await fs.chmod(lockedDir, 0o755);
    }
  });
});
