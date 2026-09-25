import type { Db } from '../db/pool.js';
import { withSystem } from '../db/pool.js';
import type { OrgStatus } from './service.js';

/**
 * Everything that hangs off an organisation, in an order the foreign keys allow:
 * `requests.operator_id → operators(id)` and `requests.created_by`/`approved_by → people(id)` have
 * no `ON DELETE` action, so requests go before operators and people. `settings` and `operators` are
 * also where every credential lives, which is what "clears credentials" means (spec 4.4).
 *
 * `audit_log` is deliberately **not** in this list: spec 4.4 keeps those rows. It is also why this
 * procedure needs no privileged connection — `audit_log.person_id` is a plain uuid with no foreign
 * key (`001_init.sql`), the `orgs` row itself is never deleted, and nothing here cascades into
 * `audit_log`, so the append-only `audit_log_no_update` trigger never fires.
 *
 * These names are interpolated into the SQL below. That is safe *only* because this array is a
 * const of string literals in this file — every value is still bound with `$1`.
 */
export const CLOSED_CHILD_TABLES = [
  'pay_run_lines', 'pay_runs', 'schedule_lines', 'schedules', 'route_claims', 'apps', 'sessions', 'permissions', 'callbacks_raw', 'balances', 'requests', 'bulk_plans', 'customer_invoices', 'contacts', 'number_history', 'accounts', 'businesses', 'operators', 'settings', 'webauthn_credentials', 'people',
] as const;

/**
 * Close one organisation: take its data and its credentials away, and leave the `orgs` row and every
 * `audit_log` row exactly where they are (spec 4.4). One transaction on the ordinary application
 * pool, inside `withSystem` because it crosses out of whatever organisation the caller was in.
 *
 * `reason` lands in `orgs.fail_reason`, so a host admin can see why a row is closed. `null` leaves
 * whatever reason was already there.
 *
 * `statuses` guards the close against a race with whatever else can move this row: the `UPDATE`
 * below only fires — and only then do the deletes run — while the row is still one of the caller's
 * expected statuses. An organisation that reached `verified` between being listed (the sweep)
 * or its very first step failing (sign-up) and this call landing simply is not touched; the row lock
 * the `UPDATE` takes serialises against whatever else is racing to change that same row, so whichever
 * write commits first wins. Returns whether this call was the one that actually closed it.
 */
export async function closeOrg(db: Db, orgId: string, reason: string | null, statuses: OrgStatus[]): Promise<boolean> {
  return withSystem(() =>
    db.tx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE orgs SET status = 'closed', fail_reason = COALESCE($2, fail_reason)
          WHERE id = $1 AND status = ANY($3) RETURNING id`,
        [orgId, reason, statuses],
      );
      if (!rows[0]) return false;
      for (const table of CLOSED_CHILD_TABLES) {
        await c.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
      }
      // `cache` (server/src/db/cache.ts) has no `org_id` column — it is a global table keyed
      // `org:<id>:<key>` — so the organisation's cached Safaricom bearer token (and anything else it
      // ever cached) would otherwise outlive every table above. `jobs` is left alone here on
      // purpose: it carries its organisation inside `payload`, not in a column this query can match,
      // and the expiry rule is what a closed organisation's stray jobs answer to.
      await c.query(`DELETE FROM cache WHERE key LIKE 'org:' || $1 || ':%'`, [orgId]);
      return true;
    }),
  );
}
