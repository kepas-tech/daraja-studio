import pg, { type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';

interface OrgCtx {
  orgId: string | null;
  system: boolean;
}

const ctx = new AsyncLocalStorage<OrgCtx>();

/**
 * What `currentOrgId()` answers when no context is in scope. `setFallbackOrg` writes this as well as
 * the pool's own fallback, because the callers that ask this question hold no Db: encryptForOrg,
 * enqueue's orgId stamp, the cache's key prefix, events.publish's default. One application pool
 * serves an install, so in a real process this and that pool's fallback are the same value; the
 * per-pool copy is what keeps two pools in one test process from deciding for each other.
 */
let processFallbackOrgId: string | null = null;

/**
 * Run `fn` with every statement it issues bound to one organisation. Propagates through `await`,
 * `Promise.all` and timers scheduled inside `fn` — not through `pg` LISTEN notifications, whose
 * handler runs in the listening connection's own context, never the publisher's.
 *
 * An empty id is refused rather than accepted: `set_config('app.org_id','')` makes
 * `app_current_org()` NULL, so every policy comparison is NULL and every row invisible — a caller
 * that passed an empty string would get a silent "nothing is here" instead of an error.
 */
export function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  if (!orgId) return Promise.reject(new Error('withOrg needs an organisation id'));
  return ctx.run({ orgId, system: false }, fn);
}

/**
 * Run `fn` across organisations. This is the only door out of one organisation's rows, and the
 * places allowed to open it are enumerated in `server/test/system-callsites.test.ts`.
 */
export function withSystem<T>(fn: () => Promise<T>): Promise<T> {
  return ctx.run({ orgId: null, system: true }, fn);
}

/**
 * The innermost context's organisation, else the process fallback, else null. `withSystem` is never
 * an organisation. Statements do not go through here — `query`/`tx` prefer their own pool's
 * fallback (see applyContext) — this is for callers that hold no Db.
 */
export function currentOrgId(): string | null {
  const store = ctx.getStore();
  if (store) return store.orgId;
  return processFallbackOrgId;
}

function currentRole(): string {
  return ctx.getStore()?.system === true ? 'system' : '';
}

/** True only inside `withSystem`. Distinguishes "no organisation, but the system role" from "no
 * organisation in scope at all" — both make `currentOrgId()` answer differently, but only the
 * former is allowed to act across organisations (e.g. `OrgService.revealSecret`'s guard). */
export function isSystem(): boolean {
  return ctx.getStore()?.system === true;
}

/**
 * Tests only: put the process fallback back to null. A pool's own fallback is separate and is
 * cleared with `db.setFallbackOrg(null)`. Nothing under `src/` calls this.
 */
export function resetContextForTests(): void {
  processFallbackOrgId = null;
}

/**
 * A checked-out connection always carries the last organisation context that ran on it, not a
 * clean slate: `tx`'s `set_config(..., true)` reverts on COMMIT/ROLLBACK to the connection's
 * session-level value, not to empty, and `query`'s session-level write has no expiry at all. That
 * is safe only because `query`/`tx` reapply the context unconditionally in front of every statement
 * they issue — so whatever a connection is carrying when it comes off the idle list is always
 * overwritten before it is used. Nothing outside this file may read `.pool` to run a statement
 * directly, because that skips the reapplication and reaches whatever the last context left behind;
 * the call-site grep forbids `\.pool\b` outside `pool.ts` for exactly this reason. The context
 * round trip itself measures roughly 1.3 ms/statement locally on top of a bare query — real at
 * scheduler/job-loop volumes, negligible next to a request.
 */
export interface Db {
  pool: pg.Pool;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
  /**
   * The organisation this pool's statements belong to when no context is in scope, and the value
   * `currentOrgId()` falls back to. `single` mode only; a hosted pool never gets one.
   */
  setFallbackOrg(id: string | null): void;
  /**
   * This pool's own fallback organisation, or `null` if none was ever set — a hosted pool, or a
   * single-mode pool before the boot pass runs. Distinct from `currentOrgId()`: that reads the
   * process-wide value `setFallbackOrg` also writes, so two pools in one process (tests only) can
   * each answer differently here while `currentOrgId()` would only ever report whichever pool set
   * it last. The scheduler loop uses this — not `currentOrgId()` — to decide whether a legacy job
   * with no `orgId` stamp belongs to single mode's one organisation or must fail outright.
   */
  getFallbackOrg(): string | null;
}

/** The only role the application pool may assume. A literal type, so nothing user-supplied is ever interpolated. */
export type AppRole = 'studio_app';

// A client pg hands back from pool.connect() is the same physical connection across checkouts, and
// SET ROLE persists for the session, so a client only needs it once. Keyed by identity: distinct
// pools never share a client object, so this is safe to keep at module scope.
const preparedClients = new WeakSet<PoolClient>();
let warnedRoleFailure = false;

/**
 * Assume `role` on a freshly checked-out client, awaited before anything else runs on it. A pool
 * with no role, or a client that already has the role from an earlier checkout, is a no-op. On
 * failure this never releases the client — the caller's own try/finally does that exactly once —
 * it only logs one line per process and rethrows so the caller's query/tx rejects.
 */
async function prepareClient(c: PoolClient, role: AppRole | null): Promise<void> {
  if (!role || preparedClients.has(c)) return;
  try {
    await c.query(`SET ROLE ${role}`);
    preparedClients.add(c);
  } catch (e) {
    if (!warnedRoleFailure) {
      warnedRoleFailure = true;
      console.warn(`could not SET ROLE ${role}: ${e instanceof Error ? e.message : String(e)}`);
    }
    throw e;
  }
}

/**
 * Thrown by `applyContext` when a role-bound connection no longer answers as that role — e.g. a
 * stray `RESET ROLE`/`SET ROLE`, run through a raw client inside `tx`, undid `prepareClient`'s work.
 * `prepareClient` only ever issues `SET ROLE` once per physical connection, so it cannot detect this
 * happening later; losing the row-level-security boundary silently would be worse than throwing.
 * The caller evicts the connection instead of returning it to the pool — see `query`/`tx` below.
 */
class RoleLostError extends Error {
  constructor() {
    super('connection lost its application role');
  }
}

/**
 * Tell PostgreSQL which organisation the next statements belong to. The context wins; with none,
 * the fallback of *this* pool decides, which is why it is a parameter rather than a global — a
 * hosted pool has none and must send nothing even while a single-mode pool in the same process has
 * one. `is_local` is interpolated rather than bound: it is a local boolean literal, never user
 * input, and binding it leaves PostgreSQL unable to resolve set_config(text, text, unknown).
 *
 * For a role-bound pool, `current_user` rides along on the same round trip and is checked against
 * `role`: a mismatch throws `RoleLostError` (see above) rather than letting the statement run with
 * the row-level-security boundary gone.
 */
async function applyContext(c: PoolClient, local: boolean, poolFallbackOrgId: string | null, role: AppRole | null): Promise<void> {
  const store = ctx.getStore();
  const orgId = store ? store.orgId : poolFallbackOrgId;
  const r = await c.query<{ cur: string }>(
    `SELECT set_config('app.org_id', $1, ${local}), set_config('app.role', $2, ${local}), current_user AS cur`,
    [orgId ?? '', currentRole()],
  );
  if (role && r.rows[0]?.cur !== role) throw new RoleLostError();
}

/**
 * `tx` fixes the organisation once, right after `BEGIN`. Without this wrapper a `withOrg`/
 * `withSystem` entered *inside* the callback would move `currentOrgId()` without moving what the
 * database sees, because nothing would tell the already-open transaction to reapply. This client's
 * `query` compares the live AsyncLocalStorage store against the one last applied here and, only
 * when it actually changed, reissues `set_config(..., true)` — one extra round trip, and only on a
 * real change — before the caller's own statement. Every call is queued on one promise chain, so a
 * sibling statement issued concurrently (e.g. inside `Promise.all`) can never land between another
 * call's re-apply and its own statement; a call that rejects is reported to its own caller without
 * stalling calls queued behind it. This is an ergonomics mechanism, not a security boundary —
 * `applyContext` is — so a pass-through method that hands back `this` (`c.on`, `once`,
 * `setMaxListeners`) returns the *real* client, and a statement issued through it falls back to the
 * transaction's `BEGIN`-time context rather than escalating past it. The wrapped `query` always
 * returns a Promise, so cursor/query-stream submittables that need a synchronous return are not
 * supported inside `tx`. Everything other than `query` passes straight through to the real client.
 */
function wrapTxClient(c: PoolClient, poolFallbackOrgId: string | null, role: AppRole | null): PoolClient {
  let last = ctx.getStore();
  let chain: Promise<unknown> = Promise.resolve();
  return new Proxy(c, {
    get(target, prop) {
      if (prop !== 'query') {
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const run = async () => {
          const current = ctx.getStore();
          if (current !== last) {
            await applyContext(target, true, poolFallbackOrgId, role);
            last = current;
          }
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
        const result = chain.then(run);
        // Keep the chain alive even if this call rejects, so a call queued behind it still runs.
        chain = result.catch(() => undefined);
        return result;
      };
    },
  }) as PoolClient;
}

function build(connectionString: string, role: AppRole | null, max: number): Db {
  const pool = new pg.Pool({ connectionString, max });
  // This pool's own fallback organisation. `single` mode's boot pass sets it; a hosted pool never
  // gets one, so every statement it issues carries no organisation and row-level security hides
  // everything from it.
  let fallbackOrgId: string | null = null;
  // pg re-emits errors from idle clients on the pool itself; with no listener Node treats it as
  // an uncaught 'error' event and exits the process.
  pool.on('error', (e) => console.error('pg pool error:', e.message));
  return {
    pool,
    async query<T>(sql: string, params: unknown[] = []) {
      // One checkout, up to three statements on it: SET ROLE (once per client), the context, then
      // the caller's. pool.query() cannot be used any more because they must land on the same
      // connection, and a client release must happen exactly once regardless of which step fails.
      const c = await pool.connect();
      let evictWith: Error | undefined;
      try {
        await prepareClient(c, role);
        await applyContext(c, false, fallbackOrgId, role);
        const r = await c.query(sql, params);
        return r.rows as T[];
      } catch (e) {
        // A role lost mid-life (see applyContext) means this physical connection can no longer be
        // trusted to enforce row-level security; release(err) tells pg-pool to discard it instead
        // of returning it to the idle list.
        if (e instanceof RoleLostError) evictWith = e;
        throw e;
      } finally {
        c.release(evictWith);
      }
    },
    async tx<T>(fn: (c: PoolClient) => Promise<T>) {
      const c = await pool.connect();
      let evictWith: Error | undefined;
      try {
        await prepareClient(c, role);
        await c.query('BEGIN');
        // is_local = true: this reverts on COMMIT/ROLLBACK to the connection's session-level value,
        // not to empty — see the invariant on Db.pool above. wrapTxClient reapplies it if the
        // callback itself opens a nested withOrg/withSystem.
        await applyContext(c, true, fallbackOrgId, role);
        const out = await fn(wrapTxClient(c, fallbackOrgId, role));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        // A failing rollback (e.g. connection already dropped, or SET ROLE never got as far as
        // BEGIN) must not mask the original error.
        await c.query('ROLLBACK').catch(() => {});
        if (e instanceof RoleLostError) evictWith = e;
        throw e;
      } finally {
        c.release(evictWith);
      }
    },
    end: () => pool.end(),
    setFallbackOrg(id: string | null) {
      fallbackOrgId = id;
      // Callers that hold no Db — encryptForOrg, enqueue's stamp, the cache key prefix,
      // events.publish's default — read currentOrgId(), so single mode's fallback has to be
      // visible there too. Only statements are isolated per pool.
      processFallbackOrgId = id;
    },
    getFallbackOrg: () => fallbackOrgId,
  };
}

/**
 * The application pool. With `{ role: 'studio_app' }` every connection assumes the limited role,
 * which is neither superuser nor BYPASSRLS, so PostgreSQL's row-level security applies to it.
 */
export function createPool(connectionString: string, opts: { role?: AppRole; max?: number } = {}): Db {
  return build(connectionString, opts.role ?? null, opts.max ?? 10);
}

/**
 * A pool that stays as DATABASE_URL's own user: migrations, the boot pass and test resets. It is
 * allowed to see across organisations, so nothing that serves a request may use it.
 */
export function createAdminPool(connectionString: string, opts: { max?: number } = {}): Db {
  return build(connectionString, null, opts.max ?? 10);
}
