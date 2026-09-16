import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Nothing company-specific may sit in a tracked file: a real paybill or till number, a phone
 * number, a person's name, an operator username, a Daraja app name. Those live only in the
 * repo-root .env (git-ignored) as STUDIO_PRIVATE_STRINGS, comma-separated, and this test reads
 * them from there and scans every tracked file. Sample data in tests is made up on purpose.
 * Without the variable (CI, a fresh clone) the check is skipped, never faked as passed.
 */
const root = resolve(process.cwd(), '..');
function privateStrings(): string[] {
  const fromEnv = process.env.STUDIO_PRIVATE_STRINGS;
  if (fromEnv !== undefined) return fromEnv.split(',').map((s) => s.trim()).filter(Boolean);
  const file = resolve(root, '.env');
  if (!existsSync(file)) return [];
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('STUDIO_PRIVATE_STRINGS='));
  return line ? line.slice('STUDIO_PRIVATE_STRINGS='.length).split(',').map((s) => s.trim()).filter(Boolean) : [];
}

describe('private strings', () => {
  const needles = privateStrings();
  it.skipIf(needles.length === 0)('no tracked file carries a company-specific value from STUDIO_PRIVATE_STRINGS', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
      .filter((f) => !/\.(png|jpg|jpeg|gif|ico|woff2?|pdf)$/i.test(f) && !f.endsWith('pnpm-lock.yaml'));
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try { text = readFileSync(resolve(root, f), 'utf8'); } catch { continue; }
      const lower = text.toLowerCase();
      for (const n of needles) if (lower.includes(n.toLowerCase())) hits.push(`${f}: ${n}`);
    }
    expect(hits, 'move these values to .env and use made-up sample data instead').toEqual([]);
  });
});
