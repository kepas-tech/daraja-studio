import { parseC2bConfirmation, parseC2bValidation } from '@kepas/daraja-js';
import type { CallbackHandler } from './router.js';
import { recordC2b, validationNameKey } from '../money_in/record.js';
import { joinPersonName } from '../util/names.js';

/** How long the name the validation call saw is kept for the confirmation that follows it. */
const NAME_TTL_SECONDS = 30 * 60;

/**
 * Accept everything (owner decision 2026-09-16): the money lands, bookkeeping sorts the rest.
 *
 * Phase A: this call carries the same receipt and the payer's names, and it arrives before the
 * confirmation. The name is kept for half an hour under the receipt, so a confirmation that arrives
 * without one — or the pull check finding a payment whose confirmation never came at all — is still
 * named. The raw body is kept with every other callback.
 */
export const c2bValidateHandler: CallbackHandler = async ({ cache, body }) => {
  try {
    const p = parseC2bValidation(body);
    const name = joinPersonName(p.firstName, p.middleName, p.lastName);
    if (p.transId && name) await cache.set(validationNameKey(p.transId), { name }, NAME_TTL_SECONDS);
  } catch { /* not a payment payload: it is still accepted, and the raw body is already stored */ }
  return { verdict: 'applied_direct' };
};

/** The money is already in the account when this arrives; there is no second callback. */
export const c2bConfirmHandler: CallbackHandler = async ({ db, events, cache, body }) => {
  let p;
  try { p = parseC2bConfirmation(body); } catch { return { verdict: 'unmatched' }; }
  return recordC2b({ db, events, cache }, p, 'callback');
};
