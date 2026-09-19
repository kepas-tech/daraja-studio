import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * withSystem() is the only way out of one organisation's rows. Every file allowed to open it is
 * listed here on purpose; adding a new one is a decision a reviewer has to make, not something that
 * happens by accident. Spec section 10.1.
 */
const ALLOWED = [
  'db/pool.ts', // where it is defined
  'http/orgContext.ts', // cookie -> session -> person -> organisation, once per request
  'auth/routes.ts', // login looks a username up across organisations
  'orgs/service.ts', // byId and bySecretHash, the callback router's lookup
  'boot/tenancy.ts', // the boot pass sets up this install's one organisation
  'scheduler/handlers.ts', // forEachOrg lists organisations, housekeeping expires sessions
  'health/routes.ts', // counts organisations for /healthz
  'orgs/close.ts', // closing crosses out of whatever organisation the caller was in
  'people/routes.ts', // the username duplicate check looks across organisations before insert
  'people/owner.ts', // the same check, for the owner a package's provisioning writes
].sort();

/**
 * The grep below only catches a direct call — `withSystem(` or `withSystem<...>(` — written out at
 * the point of use. It does not see `import { withSystem as sys }`, a re-export, or the function
 * handed around as a plain value; nothing here is a substitute for reading the diff.
 */

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

describe('the system door', () => {
  it('is opened only by the files on the list', () => {
    const callers = walk(srcDir)
      .filter((f) => /\bwithSystem\s*[(<]/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(srcDir, f).split(path.sep).join('/'))
      .sort();
    expect(callers).toEqual(ALLOWED);
  });

  it('nothing outside db/pool.ts touches the session variables directly', () => {
    const offenders = walk(srcDir)
      .filter((f) => !f.endsWith(path.join('db', 'pool.ts')))
      .filter((f) => /set_config\(\s*'app\./.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(srcDir, f).split(path.sep).join('/'));
    expect(offenders).toEqual([]);
  });

  /**
   * Two more doors past row-level security, both meant for infrastructure code only: `.pool` reaches
   * past query()/tx() straight to the underlying pg.Pool (skips the context reapplication db/pool.ts
   * documents), and createAdminPool hands back a connection that never assumes a role at all and so
   * bypasses row-level security outright. Scoped to `src/`: test files legitimately create their own
   * throwaway admin pools for setup/teardown constantly (grepped: a dozen of them), which is not part
   * of this threat model — the risk here is a *production* code path quietly gaining one.
   */
  it('raw pool access and the admin pool are confined to the files that need them', () => {
    const ALLOWED_POOL_ACCESS = ['db/pool.ts', 'index.ts'].sort();
    const offenders = walk(srcDir)
      .filter((f) => /\.pool\b|createAdminPool\s*\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(srcDir, f).split(path.sep).join('/'))
      .sort();
    expect(offenders).toEqual(ALLOWED_POOL_ACCESS);
  });
});
