import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import { COLLECT_TYPES, MONEY_IN_TYPES } from '../money_out/registry.js';

/**
 * Kinds that ask for money and whose money then also arrives as its own confirmation. Bonga is not
 * one: its confirmation completes the Bonga row itself (money_in/record.ts), so there is no pair.
 */
export const PROMPT_TYPES: string[] = COLLECT_TYPES.filter((t) => t !== 'bonga');

/** The advisory lock every writer of a receipt's rows takes first, so the two paths never deadlock. */
export const receiptLock = (receipt: string): string => `c2b:${receipt}`;

/**
 * Join a prompt and its confirmation by receipt, both ways, and hand the confirmation the labels only
 * the prompt knew (the business and account it was asked for, the caller's reference, the key).
 *
 * The caller holds `receiptLock(receipt)` in the same transaction. Only one prompt and one
 * confirmation, both still unlinked, are ever joined; anything more is left for a person. Labels
 * only: no amount, status or receipt changes, so a final row can take them.
 */
export async function linkByReceipt(c: PoolClient, receipt: string): Promise<{ promptId: string; confirmationId: string } | null> {
  const prompts = await c.query<{ id: string }>(
    `SELECT id FROM requests WHERE receipt = $1 AND type = ANY($2::text[]) AND status = 'completed' AND confirmation_id IS NULL LIMIT 2`,
    [receipt, PROMPT_TYPES]);
  const confirmations = await c.query<{ id: string }>(
    `SELECT id FROM requests WHERE receipt = $1 AND type = ANY($2::text[]) AND prompt_id IS NULL LIMIT 2`,
    [receipt, MONEY_IN_TYPES]);
  if (prompts.rows.length !== 1 || confirmations.rows.length !== 1) return null;
  const promptId = prompts.rows[0].id;
  const confirmationId = confirmations.rows[0].id;
  await c.query(`UPDATE requests SET confirmation_id = $2, link_method = 'receipt' WHERE id = $1`, [promptId, confirmationId]);
  await c.query(
    `UPDATE requests AS conf SET prompt_id = p.id, link_method = 'receipt',
        business_id = COALESCE(conf.business_id, p.business_id), account_id = COALESCE(conf.account_id, p.account_id),
        caller_ref = COALESCE(conf.caller_ref, p.caller_ref), api_key_id = COALESCE(conf.api_key_id, p.api_key_id)
       FROM requests p WHERE conf.id = $1 AND p.id = $2`,
    [confirmationId, promptId]);
  return { promptId, confirmationId };
}

/** The same, in a transaction of its own: for a prompt that has just completed on its own path. */
export async function linkPromptReceipt(db: Db, receipt: string | null | undefined): Promise<void> {
  if (!receipt) return;
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [receiptLock(receipt)]);
    await linkByReceipt(c, receipt);
  });
}

/**
 * The count-once rule, as SQL over a `requests` alias: a prompt whose confirmation is on record does
 * not count as money in, because the confirmation does. Every reader that adds up money that arrived
 * uses this, so a sweep, a statement, a report and the reconcile check can never disagree.
 */
export function countedIn(alias: string): string {
  const a = alias ? alias + '.' : '';
  return `NOT (${a}type = ANY('{${PROMPT_TYPES.join(',')}}'::text[]) AND ${a}confirmation_id IS NOT NULL)`;
}
