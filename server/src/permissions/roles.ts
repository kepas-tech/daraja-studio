import type { PoolClient } from 'pg';
import type { PermissionKey } from './catalog.js';

/**
 * Spec 5.2. Roles are presets, not a separate authorisation system: they are written into the
 * `permissions` table exactly as Phase 5's checkboxes will, so `requirePermission` is untouched.
 * `owner` is not here — `requirePermission` short-circuits on `is_owner`, so an owner needs no rows.
 * `custom` is not here either — it means "whatever the checkboxes set", so nothing is written.
 */
/**
 * Round 5: `forwarder` is a role for an API key, not for a person — a key that may do one thing,
 * post this paybill's confirmations to Studio's inbox, and nothing else at all.
 */
export const ROLE_PRESETS: Record<'operator' | 'viewer' | 'approver' | 'forwarder' | 'collector', PermissionKey[]> = {
  forwarder: ['money_in.feed'],
  /**
   * Round 5's mirror image: the system that takes this studio's payments. Two permissions and
   * nothing else — ask for a payment, and read one back — because a payments integration needs
   * neither the sends nor the batch files, and a key is a credential that outlives the handover.
   */
  // `accounts.own` (migration 050): the app opens one account per user, under the key's own business,
  // so the money it asks for names the user. A collector key with no business opens none.
  collector: ['stk.request', 'lookup.view', 'accounts.own'],
  /** Staff who send, and who ask customers to pay. `stk.request` is here because asking for money
   *  in is what a till does all day and is a smaller power than sending money out, which this same
   *  role already carries; it is also what lets an API key raise a payment request at all — no role
   *  an API key could hold had it before, so `POST /api/collect/stk` answered 403 to every key. */
  operator: ['balances.view', 'send.phone', 'send.pochi', 'pay.paybill', 'pay.till', 'stk.request', 'lookup.view', 'money_in.view', 'history.export', 'cases.manage'],
  /** An accountant or an auditor. */
  viewer: ['balances.view', 'lookup.view', 'money_in.view', 'history.export'],
  /** A second pair of eyes (M4): looks, and releases or refuses held sends; never sends. */
  approver: ['balances.view', 'lookup.view', 'money_in.view', 'history.export', 'send.approve'],
};

/** What an owner may hand out. `owner` is not one of them: one per organisation, and it is the
 * person who signed up (people_single_owner is the index that says so). */
export const ASSIGNABLE_ROLES = ['operator', 'viewer', 'approver', 'custom'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/**
 * Set a person's role and make the `permissions` rows match it. Takes the client of a transaction
 * already open on the caller's organisation (`db.tx`), so the UPDATE and the DELETE/INSERT that
 * follow it either all land or none does — a failure here can never leave a person with a role that
 * does not match their permission rows.
 */
export async function applyRole(c: PoolClient, personId: string, role: AssignableRole): Promise<void> {
  await c.query('UPDATE people SET role=$2 WHERE id=$1', [personId, role]);
  // 'custom' means the rows are the truth, so they are left exactly as they are.
  if (role === 'custom') return;
  await c.query('DELETE FROM permissions WHERE person_id=$1', [personId]);
  // The DELETE just above guarantees this person has no rows left to conflict with.
  await c.query(
    `INSERT INTO permissions(person_id, permission) SELECT $1, unnest($2::text[])`,
    [personId, ROLE_PRESETS[role]],
  );
}
