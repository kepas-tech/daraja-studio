import type { Db } from '../db/pool.js';
import { randomSecret } from '../crypto/secrets.js';
import type { OrgStatus, OrgView } from '../orgs/service.js';
import type { PersonRole } from './middleware.js';

export const SESSION_COOKIE = 'studio_session';
export const SESSION_IDLE_HOURS = 12;

export interface SessionRow { id: string; person_id: string; csrf_token: string; expires_at: Date; org_id: string }

export async function createSession(db: Db, personId: string, ip: string, ua: string) {
  const id = randomSecret(32);
  const csrf = randomSecret(24);
  await db.query(
    `INSERT INTO sessions(id, person_id, csrf_token, expires_at, ip, user_agent)
     VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval, $5, $6)`,
    [id, personId, csrf, String(SESSION_IDLE_HOURS), ip, ua.slice(0, 300)],
  );
  return { id, csrf };
}

export async function loadSession(db: Db, id: string): Promise<SessionRow | null> {
  const rows = await db.query<SessionRow>(
    `UPDATE sessions SET expires_at = now() + ($2 || ' hours')::interval
     WHERE id=$1 AND expires_at > now() RETURNING id, person_id, csrf_token, expires_at, org_id`,
    [id, String(SESSION_IDLE_HOURS)],
  );
  return rows[0] ?? null;
}

export interface PersonWithHash {
  id: string; username: string; display_name: string; is_owner: boolean;
  status: 'active' | 'suspended'; must_change_password: boolean;
  email: string | null; role: PersonRole; is_host_admin: boolean;
  password_hash: string;
}

/**
 * One cross-organisation read, and the only one on the request path: given a cookie, who is this
 * and which organisation do they belong to. Called inside withSystem by orgContext; everything
 * after it runs inside that organisation.
 */
export async function loadSessionWithOrg(
  db: Db,
  id: string,
): Promise<{ session: SessionRow; person: PersonWithHash; org: OrgView } | null> {
  const session = await loadSession(db, id);
  if (!session) return null;
  const rows = await db.query<
    PersonWithHash & {
      org_id: string; org_slug: string; org_name: string; org_status: OrgStatus; org_is_host: boolean;
      org_suspend_reason: 'unpaid' | 'host' | null;
    }
  >(
    `SELECT p.id, p.username, p.display_name, p.is_owner, p.status, p.must_change_password,
            p.email, p.role, p.is_host_admin, p.password_hash,
            o.id AS org_id, o.slug AS org_slug, o.name AS org_name, o.status AS org_status,
            o.is_host AS org_is_host, o.suspend_reason AS org_suspend_reason
       FROM people p JOIN orgs o ON o.id = p.org_id
      WHERE p.id = $1`,
    [session.person_id],
  );
  const r = rows[0];
  if (!r) return null;
  const { org_id, org_slug, org_name, org_status, org_is_host, org_suspend_reason, ...person } = r;
  return {
    session,
    person,
    org: { id: org_id, slug: org_slug, name: org_name, status: org_status, isHost: org_is_host, suspendReason: org_suspend_reason },
  };
}

export async function destroySession(db: Db, id: string) {
  await db.query('DELETE FROM sessions WHERE id=$1', [id]);
}

export function cookieHeader(id: string, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_IDLE_HOURS * 3600}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
