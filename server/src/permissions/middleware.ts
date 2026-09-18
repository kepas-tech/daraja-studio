import type { RequestHandler } from 'express';
import type { Db } from '../db/pool.js';
import { HttpError } from '../util/errors.js';
import type { PermissionKey } from './catalog.js';

export async function personPermissions(db: Db, personId: string): Promise<PermissionKey[]> {
  const rows = await db.query<{ permission: PermissionKey }>('SELECT permission FROM permissions WHERE person_id=$1', [personId]);
  return rows.map((r) => r.permission);
}

/**
 * The same check as `requirePermission`, for a route whose permission is not known until the row
 * is read — B0's manual check, where the key depends on which kind of send the request actually is.
 */
export async function assertPermission(db: Db, person: { id: string; is_owner: boolean }, key: PermissionKey, keyPermissions?: PermissionKey[]): Promise<void> {
  if (person.is_owner) return;
  // Phase E: a key's permissions are its role's preset, handed in by the caller's request.
  if (keyPermissions) {
    if (keyPermissions.includes(key)) return;
    throw new HttpError(403, 'no_permission', 'This API key may not do that.', { permission: key });
  }
  const rows = await db.query('SELECT 1 FROM permissions WHERE person_id=$1 AND permission=$2', [person.id, key]);
  if (rows.length === 0) throw new HttpError(403, 'no_permission', 'You do not have permission for this. Ask the owner.', { permission: key });
}

export function requirePermission(db: Db, key: PermissionKey): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!req.person) throw new HttpError(401, 'not_logged_in', 'Please log in.');
      if (req.person.is_owner) return next();
      // Phase E: a key carries its role's preset on the request; a person's permissions are rows.
      if (req.apiKey) {
        if (req.apiKey.permissions.includes(key)) return next();
        throw new HttpError(403, 'no_permission', 'This API key may not do that.', { permission: key });
      }
      const rows = await db.query('SELECT 1 FROM permissions WHERE person_id=$1 AND permission=$2', [req.person.id, key]);
      if (rows.length === 0) throw new HttpError(403, 'no_permission', 'You do not have permission for this. Ask the owner.', { permission: key });
      next();
    } catch (e) { next(e); }
  };
}
