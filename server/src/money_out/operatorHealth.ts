import type { Db } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import { CREDENTIAL_CODES } from './registry.js';

/** When Safaricom reports a credential failure for the operator that signed a request, mark it failed so Settings shows why and the next send picks another. Returns true when it did. */
export async function failOperatorOnCredentialCode(db: Db, events: EventHub, operatorId: string | null, code: string | number, resultDesc: string): Promise<boolean> {
  if (!operatorId || !CREDENTIAL_CODES.has(String(code))) return false;
  const rows = await db.query<{ id: string }>(`UPDATE operators SET status='failed', last_error=$2 WHERE id=$1 AND status <> 'disabled' RETURNING id`, [operatorId, resultDesc.slice(0, 500)]);
  if (rows.length === 0) return false;
  await events.publish('operator.updated', { operatorId, status: 'failed' });
  return true;
}
