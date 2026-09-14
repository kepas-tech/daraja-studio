import type { CallbackHandler } from './router.js';
export const selftestHandler: CallbackHandler = async ({ cache, body }) => {
  const nonce = (body as { nonce?: unknown })?.nonce;
  if (typeof nonce !== 'string' || nonce.length > 100) return { verdict: 'unmatched' };
  await cache.set(`selftest:${nonce}`, { ok: true }, 120);
  return { verdict: 'applied' };
};
