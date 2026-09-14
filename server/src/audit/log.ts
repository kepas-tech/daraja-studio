import type { Db } from '../db/pool.js';

export interface AuditEvent {
  personId?: string | null;
  action: string;
  target?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

export async function audit(db: Db, e: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_log(person_id, action, target, before_json, after_json, ip)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
    [e.personId ?? null, e.action, e.target ?? null,
     e.before === undefined ? null : JSON.stringify(e.before),
     e.after === undefined ? null : JSON.stringify(e.after), e.ip ?? null],
  );
}
