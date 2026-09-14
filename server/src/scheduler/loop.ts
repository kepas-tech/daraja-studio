import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { withOrg } from '../db/pool.js';
import { claim, complete, fail, failFinal, rearm, type Job } from '../db/jobs.js';

export type JobHandler = (payload: unknown, job: Job) => Promise<void>;
export interface Scheduler { tick(): Promise<number>; start(): void; stop(): void; lastTickAt(): Date | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `undefined` — no organisation was ever stamped (a pre-Task-8 legacy job, or one enqueued outside
 * every context with no pool fallback). `null` — the payload names something that is not a valid
 * organisation id; a malformed value must never be adopted or retried, only `failFinal`, the same
 * as any other error retrying cannot fix.
 */
function payloadOrgId(payload: unknown): string | null | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const v = (payload as { orgId?: unknown }).orgId;
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

export function createScheduler(db: Db, handlers: Record<string, JobHandler>, opts: { intervalMs?: number; workerId?: string } = {}): Scheduler {
  const workerId = opts.workerId ?? randomUUID();
  const intervalMs = opts.intervalMs ?? 5000;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let last: Date | null = null;
  // A legacy job with no orgId is adopted into the pool's fallback organisation (single mode) once
  // per job id, so a retry does not re-log the same adoption every attempt.
  const adoptedLegacyJobIds = new Set<string>();

  async function tick(): Promise<number> {
    let n = 0;
    try {
      for (;;) {
        const job = await claim(db, workerId);
        if (!job) return n;
        n++;
        const h = Object.hasOwn(handlers, job.kind) ? handlers[job.kind] : undefined;
        if (!h) { await (job.recurring ? rearm(db, job.id, `no handler for ${job.kind}`) : fail(db, job.id, `no handler for ${job.kind}`)); continue; }

        if (job.recurring) {
          // Recurring jobs are global rows: their handlers walk the organisations themselves
          // (scheduler/handlers.ts forEachOrg), so the loop enters no context for them.
          try {
            await h(job.payload, job);
            await rearm(db, job.id);
          } catch (e) {
            await rearm(db, job.id, e instanceof Error ? e.message : String(e));
          }
          continue;
        }

        const stamped = payloadOrgId(job.payload);
        if (stamped === null) { await failFinal(db, job.id, 'no_org'); continue; }
        let orgId = stamped;
        if (orgId === undefined) {
          const fallback = db.getFallbackOrg();
          if (!fallback) { await failFinal(db, job.id, 'no_org'); continue; }
          if (!adoptedLegacyJobIds.has(job.id)) {
            adoptedLegacyJobIds.add(job.id);
            console.error(`adopted legacy job ${job.id} with no organisation into ${fallback}`);
          }
          orgId = fallback;
        }
        // A closed organisation's leftover jobs must not run: everything they would touch has been
        // deleted (orgs/expiry.ts), so the handler would either do nothing or fail its way through
        // five retries. The read is inside withOrg because the org_self policy lets an organisation
        // see its own row — the scheduler does not need, and does not get, a way across
        // organisations. No row at all means the organisation is gone entirely; same answer.
        const [org] = await withOrg(orgId, () => db.query<{ status: string }>('SELECT status FROM orgs WHERE id = $1', [orgId]));
        if (!org) {
          // Orgs rows are never deleted (spec 4.4), so this should not happen; log it once — this
          // job is about to be finished for good, so there is no second attempt to log again.
          console.error(`one-shot job ${job.id} names an organisation with no row at all: ${orgId}`);
          await failFinal(db, job.id, 'org_closed');
          continue;
        }
        if (org.status === 'closed') { await failFinal(db, job.id, 'org_closed'); continue; }

        try {
          await withOrg(orgId, () => h(job.payload, job));
          await complete(db, job.id);
        } catch (e) {
          await fail(db, job.id, e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      last = new Date();
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(async () => {
        if (running) return;
        running = true;
        try { await tick(); } catch (e) { console.error('scheduler tick failed', e instanceof Error ? e.message : e); }
        finally { running = false; }
      }, intervalMs);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    lastTickAt() { return last; },
  };
}
