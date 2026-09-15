import { Router } from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Db } from '../db/pool.js';
import { withOrg } from '../db/pool.js';
import type { Settings, Env } from '../settings/store.js';
import type { Cache } from '../db/cache.js';
import type { EventHub } from '../events/hub.js';
import type { OrgService, OrgView } from '../orgs/service.js';
import { clientIp } from '../util/ip.js';
import { inAllowlist, parseAllowlist } from './allowlist.js';
import { sha256 } from '../crypto/secrets.js';

export type CallbackVerdict = { verdict: 'applied' | 'unmatched' | 'duplicate' | 'applied_direct' | 'unmatched_final' | 'off_range'; requestId?: string; /** A body the provider wants back instead of the generic ack (Bill Manager wants `rescode 200`). */ ack?: unknown };
/** Always invoked from inside `withOrg(org.id)` by the router below — never call one directly
 * outside that context, or its matches run against whatever organisation happens to be ambient. */
export type CallbackHandler = (ctx: {
  db: Db; cache: Cache; events: EventHub; body: unknown; rawId: string;
  sourcePolicy: { inAllowlist: boolean; environment: Env };
}) => Promise<CallbackVerdict>;

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

interface RouteDeps {
  db: Db; settings: Settings; cache: Cache; events: EventHub; orgs: OrgService;
  handlers: Record<string, CallbackHandler>;
}

export function callbackRoutes(deps: RouteDeps): Router {
  const r = Router();
  r.post('/:secret/*path', async (req, res) => {
    const sub = (Array.isArray(req.params.path) ? req.params.path.join('/') : String(req.params.path ?? '')).replace(/^\/+/, '');
    // The secret is never compared in the application: its sha256 is a unique-index lookup, so an
    // unknown address is a miss, not a mismatch, and there is no comparison to time. A miss and a
    // lookup that could not even run are not the same thing, though: the former is a real "no such
    // organisation" (404); the latter means Studio never learned whether this callback belongs to
    // anyone, so it must never be acked as accepted (503) — never the secret, never the body.
    let org: OrgView | null;
    try {
      org = await deps.orgs.bySecretHash(sha256(String(req.params.secret ?? '')));
    } catch (e) {
      console.error('callback lookup failed', sub, e instanceof Error ? e.message : e);
      res.status(503).end();
      return;
    }
    if (!org || org.status === 'closed') { res.status(404).end(); return; }
    // A suspended organisation still gets its callbacks stored and applied: that money already left.
    await withOrg(org.id, async () => {
      let raw: { id: string };
      let ip: string;
      let ok: boolean;
      let inList: boolean;
      let environment: Env;
      try {
        const s = await deps.settings.getMany(['callbacks.allowlist', 'daraja.environment']);
        ip = clientIp(req);
        const allow = parseAllowlist(s['callbacks.allowlist']);
        inList = inAllowlist(ip, allow);
        // Sandbox (test money): Safaricom's sandbox posts from addresses outside the published
        // production ranges, so off-range callbacks are dispatched but flagged. Production: never.
        // Balance and STK callbacks resolve their own environment inside the handler; both follow
        // the selected-environment rule below like every other path.
        environment = s['daraja.environment'] === 'production' ? 'production' : 'sandbox';
        ok = sub === 'selftest' || sub === 'balance' || inList || environment === 'sandbox';
        [raw] = await deps.db.query<{ id: string }>(
          `INSERT INTO callbacks_raw(path, source_ip, in_allowlist, body_json, verdict) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
          [sub, ip, inList, JSON.stringify(req.body ?? null), ok ? 'unmatched' : 'off_range'],
        );
      } catch {
        // Nothing durable was captured, so a 200 here would drop the result with no row for the
        // sweep to find (lead ruling 2026-09-13). The provider must retry: log by path only — the
        // body may carry phone numbers or receipts — and answer like the failed lookup above.
        console.error('callback storage failed', sub);
        res.status(503).end();
        return;
      }
      // Safaricom always gets 200 regardless of what happens below; handler failures are only
      // logged (by path, never body — it may carry phone numbers or receipts). The handler is
      // awaited to completion before the ack is sent so the write it makes is visible to anyone
      // observing the response (e.g. our own tests, or a caller polling right after the ack).
      let ack: unknown = ACK;
      try {
        if (!ok) {
          await deps.events.publish('alert', { kind: 'callback_off_range', ip, path: sub });
        } else {
          const h = Object.hasOwn(deps.handlers, sub) ? deps.handlers[sub] : undefined;
          if (h) {
            const outcome = await h({ db: deps.db, cache: deps.cache, events: deps.events, body: req.body, rawId: raw.id, sourcePolicy: { inAllowlist: inList, environment } });
            if (outcome.ack !== undefined) ack = outcome.ack;
            const finalVerdict = sub === 'selftest' && outcome.verdict === 'applied' ? 'selftest' : outcome.verdict;
            await deps.db.query('UPDATE callbacks_raw SET verdict=$2, matched_request_id=$3 WHERE id=$1', [raw.id, finalVerdict, outcome.requestId ?? null]);
            if (outcome.verdict === 'off_range') await deps.events.publish('alert', { kind: 'callback_off_range', ip, path: sub });
            if (!inList && sub !== 'selftest' && (outcome.verdict === 'applied' || outcome.verdict === 'applied_direct')) await deps.events.publish('alert', { kind: 'callback_off_range_applied', ip, path: sub });
            if (outcome.verdict === 'unmatched' && sub !== 'selftest') await deps.events.publish('alert', { kind: 'callback_unmatched', path: sub });
          }
        }
      } catch (e) {
        console.error('callback handler failed', sub, e instanceof Error ? e.message : e);
        try { await deps.events.publish('alert', { kind: 'callback_handler_failed', path: sub }); } catch { /* best effort */ }
      }
      res.status(200).json(ack);
    });
  });
  return r;
}

/**
 * Catches body-parse failures (malformed JSON, oversized payload) from the JSON parser mounted
 * ahead of `callbackRoutes` on the same `/cb` path. Runs before route matching, so `req.params`
 * is not populated yet — the secret and sub-path are read from `req.path` instead (the `/cb`
 * mount prefix is already stripped by Express at this point). Still enforces the secret check
 * (wrong secret → 404, nothing stored) and otherwise stores what we can (never the parsed body,
 * since parsing is exactly what failed) before acking 200 like every other callback outcome.
 */
export function callbackErrorHandler(deps: { db: Db; settings: Settings; events: EventHub; orgs: OrgService }): ErrorRequestHandler {
  return (_err, req, res, next) => {
    void next; // terminal handler: every path below ends in a response, never propagates further
    const parts = req.path.split('/').filter(Boolean);
    // req.path is not percent-decoded the way req.params.secret is above — decode here so the two
    // resolution paths agree on the same secret for the same URL.
    const secret = decodeURIComponent(parts[0] ?? '');
    const sub = parts.slice(1).join('/');
    let stored = false;
    (async () => {
      const org = await deps.orgs.bySecretHash(sha256(secret));
      if (!org || org.status === 'closed') { if (!res.headersSent) res.status(404).end(); return; }
      await withOrg(org.id, async () => {
        const ip = clientIp(req);
        const allow = parseAllowlist(await deps.settings.get('callbacks.allowlist'));
        await deps.db.query(
          `INSERT INTO callbacks_raw(path, source_ip, in_allowlist, body_json, verdict) VALUES ($1,$2,$3,$4::jsonb,'unmatched')`,
          [sub, ip, inAllowlist(ip, allow), JSON.stringify({ unparsed: req.rawBody ?? null, error: 'body_parse_failed' })],
        );
        stored = true;
        await deps.events.publish('alert', { kind: 'callback_unparsable', path: sub });
        if (!res.headersSent) res.status(200).json(ACK);
      });
    })().catch(() => {
      // The raw row must exist before any 200 (lead ruling 2026-09-13): a failed intake answers 503
      // so the provider can redeliver, while a failure after storage still acks.
      console.error('callback error handler failed', sub);
      if (res.headersSent) return;
      if (stored) res.status(200).json(ACK);
      else res.status(503).end();
    });
  };
}
