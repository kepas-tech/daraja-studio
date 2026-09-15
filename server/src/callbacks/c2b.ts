import { parseC2bConfirmation } from '@kepas/daraja-js';
import type { CallbackHandler } from './router.js';
import { recordC2b } from '../money_in/record.js';

/** Accept everything (owner decision 2026-09-16): the money lands, bookkeeping sorts the rest. */
export const c2bValidateHandler: CallbackHandler = async () => ({ verdict: 'applied_direct' });

/** The money is already in the account when this arrives; there is no second callback. */
export const c2bConfirmHandler: CallbackHandler = async ({ db, events, body }) => {
  let p;
  try { p = parseC2bConfirmation(body); } catch { return { verdict: 'unmatched' }; }
  return recordC2b({ db, events }, p, 'callback');
};
