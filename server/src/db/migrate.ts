import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './pool.js';

const LOCK_KEY = 727001;

export async function migrate(db: Db, dir: string): Promise<string[]> {
  const files = (await fs.readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  return db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string));
    const applied: string[] = [];
    for (const f of files) {
      const version = f.slice(0, 3);
      if (done.has(version)) continue;
      const sql = await fs.readFile(path.join(dir, f), 'utf8');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [version, f]);
      applied.push(version);
    }
    return applied;
  });
}
