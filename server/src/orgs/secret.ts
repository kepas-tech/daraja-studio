import { currentOrgId } from '../db/pool.js';
import { HttpError } from '../util/errors.js';
import type { OrgService } from './service.js';

/**
 * The callback secret of the organisation this code is running for. Replaces the old install-wide
 * `install.secret` setting: each organisation has its own, and nobody else knows it.
 */
export async function currentCallbackSecret(orgs: OrgService): Promise<string> {
  const orgId = currentOrgId();
  if (!orgId) throw new HttpError(500, 'no_org', 'No organisation is in scope for this request.');
  return orgs.revealSecret(orgId);
}
