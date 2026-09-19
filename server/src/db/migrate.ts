import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './pool.js';

const LOCK_KEY = 727001;
/** Migrations in the second directory start here, so they can never collide with the core's. */
export const EXTENSION_FROM = 900;

interface Migration { version: string; name: string; sql: string }

/**
 * The migrations in one directory, in name order. `least` is the lowest number the directory may
 * use: the core has no floor, and a package's own directory starts at EXTENSION_FROM.
 */
async function migrationsIn(dir: string, least: number): Promise<Migration[]> {
  const names = (await fs.readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  return Promise.all(names.map(async (name) => {
    const version = name.slice(0, 3);
    if (Number(version) < least) {
      throw new Error(`${name} is numbered below ${least}. Migrations outside the core start at ${EXTENSION_FROM} so they never collide with it.`);
    }
    return { version, name, sql: await fs.readFile(path.join(dir, name), 'utf8') };
  }));
}

/**
 * Apply every migration that has not run yet, core first and then, when one is configured, the
 * second directory an installed package carries its own tables in. Both are recorded in
 * schema_migrations by number, so a version is applied once and once only.
 */
export async function migrate(db: Db, dir: string, extensionDir?: string | null): Promise<string[]> {
  const files = [...(await migrationsIn(dir, 0)), ...(extensionDir ? await migrationsIn(extensionDir, EXTENSION_FROM) : [])];
  files.sort((a, b) => a.version.localeCompare(b.version));
  const versions = new Set<string>();
  for (const f of files) {
    if (versions.has(f.version)) throw new Error(`Two migrations share the number ${f.version}: ${f.name}`);
    versions.add(f.version);
  }
  return db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string));
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f.version)) continue;
      await c.query(f.sql);
      await c.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [f.version, f.name]);
      applied.push(f.version);
    }
    return applied;
  });
}
