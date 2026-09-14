import type { CallbackHandler } from './router.js';
import { applyResult } from './apply.js';

/**
 * An organisation asking its own customer to pay (M1). The row lives in `requests`, keyed by the
 * checkout reference Safaricom's callback carries, and is resolved and applied like every other
 * money-out or money-in kind — see `apply.ts`.
 */
export const stkHandler: CallbackHandler = async ({ db, events, body }) => applyResult({ db, events }, 'stk', body);
