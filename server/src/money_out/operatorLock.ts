import { randomUUID } from 'node:crypto';
import type { Cache } from '../db/cache.js';

/**
 * Brief 2, item 7. One request in flight per operator.
 *
 * Safaricom locks an operator on the THIRD wrong password, so the two-try guard is worth nothing if
 * a burst of payouts leaves at once on a credential that has just expired: ten sends in the same
 * second record ten refusals, and the operator is locked before anybody reads the second one. KEPAS
 * Pay gates this with one in-flight slot per initiator; this is the same gate on Studio's own cache
 * table, so it holds across processes and survives a restart.
 *
 * The slot is taken before the call to Safaricom and given back as soon as that call answers, ack or
 * refusal, so a studio sending a batch pays one short wait per send rather than a minute per send.
 * Two things bound it: the lease runs out on its own, so a process that dies mid-send cannot wedge
 * the pool, and a waiter gives up after LOCK_WAIT_MS and sends anyway — the queue drains rather than
 * stalling behind a slot nobody will ever free. It is a gate, not a queue.
 */
export const LOCK_TTL_SECONDS = 60;
/** How long a second send waits for the slot before going out regardless. */
export const LOCK_WAIT_MS = 5_000;
const POLL_MS = 200;

export interface OperatorLock {
  /** The ticket that gives the slot back, or null when there is no operator to lock or the wait ran out. */
  acquire(operatorId: string | null): Promise<string | null>;
  release(operatorId: string | null, ticket: string | null): Promise<void>;
}

const keyFor = (operatorId: string) => `operator-inflight:${operatorId}`;

export function createOperatorLock(deps: { cache: Cache; waitMs?: number; ttlSeconds?: number; pollMs?: number }): OperatorLock {
  const waitMs = deps.waitMs ?? LOCK_WAIT_MS;
  const ttlSeconds = deps.ttlSeconds ?? LOCK_TTL_SECONDS;
  const pollMs = deps.pollMs ?? POLL_MS;

  return {
    async acquire(operatorId) {
      if (!operatorId) return null;
      const key = keyFor(operatorId);
      const deadline = Date.now() + waitMs;
      for (;;) {
        const ticket = randomUUID();
        if (await deps.cache.acquire(key, ticket, ttlSeconds)) return ticket;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
    async release(operatorId, ticket) {
      if (!operatorId || !ticket) return;
      await deps.cache.release(keyFor(operatorId), ticket);
    },
  };
}
