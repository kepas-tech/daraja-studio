import type { CallbackHandler } from './router.js';
import { applyResult } from './apply.js';

/**
 * Results for every kind that answers on the B2C address: the phone send, and from B1 the send to
 * a business wallet. The handler names only the path; `applyResult` resolves which row and which
 * kind this result belongs to, and refuses to apply it to a kind that answers elsewhere.
 */
export const b2cHandler: CallbackHandler = async ({ db, events, body }) => applyResult({ db, events }, 'b2c', body);
