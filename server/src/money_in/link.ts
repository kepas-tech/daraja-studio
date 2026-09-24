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

/**
 * A prompt whose own answer never came (still `sent`, or `unknown`) and a confirmation that arrived
 * for it: linked by inference when exactly one such prompt asked for the same account reference and
 * the same amount in the ten minutes before. Two or more candidates link nothing; a person decides.
 * The prompt keeps its own status (its answer is Safaricom's to give); it only names the confirmation.
 */
export async function linkInferred(c: PoolClient, confirmationId: string): Promise<string | null> {
  const [conf] = (await c.query<{ account_reference: string | null; amount_cents: string; prompt_id: string | null }>(
    `SELECT account_reference, amount_cents, prompt_id FROM requests WHERE id = $1`, [confirmationId])).rows;
  if (!conf || conf.prompt_id || !conf.account_reference) return null;
  const candidates = await c.query<{ id: string }>(
    `SELECT id FROM requests WHERE type = ANY($1::text[]) AND status IN ('sent', 'unknown') AND confirmation_id IS NULL
        AND upper(account_reference) = upper($2) AND amount_cents = $3 AND created_at > now() - interval '10 minutes'
      LIMIT 2`,
    [PROMPT_TYPES, conf.account_reference, conf.amount_cents]);
  if (candidates.rows.length !== 1) return null;
  const promptId = candidates.rows[0].id;
  await c.query(`UPDATE requests SET confirmation_id = $2, link_method = 'inferred' WHERE id = $1 AND confirmation_id IS NULL`, [promptId, confirmationId]);
  await c.query(
    `UPDATE requests AS conf SET prompt_id = p.id, link_method = 'inferred',
        business_id = COALESCE(conf.business_id, p.business_id), account_id = COALESCE(conf.account_id, p.account_id),
        caller_ref = COALESCE(conf.caller_ref, p.caller_ref), api_key_id = COALESCE(conf.api_key_id, p.api_key_id)
       FROM requests p WHERE conf.id = $1 AND p.id = $2`,
    [confirmationId, promptId]);
  return promptId;
}

/** The same, in a transaction of its own: for a prompt that has just completed on its own path. */
export async function linkPromptReceipt(db: Db, receipt: string | null | undefined): Promise<void> {
  if (!receipt) return;
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [receiptLock(receipt)]);
    // An inferred link the prompt's own receipt now contradicts was wrong: it is undone, with the
    // key and caller's reference the confirmation took from this prompt, before the true link is made.
    await c.query(
      `WITH wrong AS (
         SELECT p.id AS pid, conf.id AS cid, p.caller_ref, p.api_key_id FROM requests p JOIN requests conf ON conf.id = p.confirmation_id
          WHERE p.receipt = $1 AND p.link_method = 'inferred' AND conf.receipt IS DISTINCT FROM p.receipt)
       UPDATE requests r SET confirmation_id = NULL, prompt_id = NULL, link_method = NULL,
              caller_ref = CASE WHEN r.id = w.cid AND r.caller_ref IS NOT DISTINCT FROM w.caller_ref THEN NULL ELSE r.caller_ref END,
              api_key_id = CASE WHEN r.id = w.cid AND r.api_key_id IS NOT DISTINCT FROM w.api_key_id THEN NULL ELSE r.api_key_id END
         FROM wrong w WHERE r.id IN (w.pid, w.cid)`,
      [receipt]);
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
