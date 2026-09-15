import type { CallbackHandler } from './router.js';
import { applyResult } from './apply.js';

/** A standing order's consent result (M8) and an express checkout's result (M9): ordinary rows, applied like every other kind. */
export const ratibaHandler: CallbackHandler = async ({ db, events, body }) => applyResult({ db, events }, 'ratiba', body);
export const expressHandler: CallbackHandler = async ({ db, events, body }) => applyResult({ db, events }, 'express', body);
