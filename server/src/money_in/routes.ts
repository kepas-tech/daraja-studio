import { Router } from 'express';
import { parseC2bConfirmation } from '@kepas/daraja-js';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireOwner, requireStepUp } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { listRequests } from '../money_out/reads.js';
import { INCOMING_TYPES } from '../money_out/registry.js';
import { clientIp } from '../util/ip.js';
import { NAMES_PER_RUN } from './names.js';
import { runFeedTest } from './feedTest.js';
import { recordC2b } from './record.js';
import { audit } from '../audit/log.js';
import { HttpError } from '../util/errors.js';

/**
 * Registration is the owner's, behind a password: it tells Safaricom where to post real money's
 * confirmations. Reading and the missed-payments check are for anyone allowed to see money in.
 */
export function moneyInRoutes(deps: AppDeps): Router {
  const r = Router();
  r.get('/status', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await deps.moneyIn.status()); } catch (e) { next(e); } });
  // Phase A: every kind of money in, not only a paybill payment — an express ask, a Bonga
  // redemption, an invoice payment and a standing order all arrive here too.
  r.get('/recent', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await listRequests(deps.db, { type: INCOMING_TYPES, limit: 20 }, deps.config.egressIps)); } catch (e) { next(e); } });
  // Feature 2: payments whose account number names no business, or a customer number nobody holds.
  // Each one carries the reason and enough for the page to offer its own one-click fix.
  r.get('/unmatched', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => {
    try { res.json({ items: await deps.businesses.unmatched() }); } catch (e) { next(e); }
  });
  r.post('/register', requireAuth(deps.db), requireCsrf, requireOwner, requireStepUp(deps.db), async (req, res, next) => {
    try { res.status(202).json(await deps.moneyIn.register({ personId: req.person!.id, ip: clientIp(req) })); } catch (e) { next(e); }
  });
  r.post('/check', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => { try { res.json(await deps.moneyIn.checkMissed()); } catch (e) { next(e); } });
  // Round 4: how many completed payments are still without a payer's name, and the one press
  // that asks Safaricom about a few of them. A read: nothing here writes a name, a status, an
  // amount or a receipt — the answers arrive on the status callback and fill the name there.
  r.get('/missing-names', requireAuth(deps.db), requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => {
    try { res.json({ count: (await deps.nameBackfill.missing(1000)).length, perRun: NAMES_PER_RUN }); } catch (e) { next(e); }
  });
  r.post('/find-names', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'money_in.view'), async (_req, res, next) => {
    try { res.json(await deps.nameBackfill.ask({ limit: NAMES_PER_RUN, gapMs: 0 })); } catch (e) { next(e); }
  });
  // Round 5: the inbox. Another system owns this paybill's C2B addresses and posts each
  // confirmation through untouched — Safaricom's own field names, the same parser the callback
  // uses, the payer's name written exactly where a confirmation's would be. Idempotent on the
  // receipt, so the feed and the pull may both run and a payment is never counted twice. A key
  // with the forwarder role carries `money_in.feed` and nothing else.
  r.post('/feed', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'money_in.feed'), async (req, res, next) => {
    try {
      let payment;
      try { payment = parseC2bConfirmation(req.body); }
      catch { throw new HttpError(400, 'bad_body', 'That is not a C2B confirmation. Send Safaricom’s own fields, the body untouched.'); }
      const out = await recordC2b({ db: deps.db, events: deps.events, cache: deps.cache }, payment, 'feed');
      await audit(deps.db, {
        personId: req.person!.id, ip: clientIp(req), action: 'money_in.fed', target: out.requestId,
        // The key's first characters, never its secret: a delivery from a machine must still say
        // which machine.
        after: { receipt: String(payment.transId ?? ''), verdict: out.verdict, key: req.apiKey?.prefix ?? null },
      });
      res.status(out.verdict === 'applied' ? 201 : 200).json({ verdict: out.verdict, requestId: out.requestId, receipt: String(payment.transId ?? '') });
    } catch (e) { next(e); }
  });

  // Round 5: the test that proves the inbox before the first real payment. It records a test
  // payment through the same path, sends it twice to prove the receipt rule, and removes it.
  r.post('/feed/test', requireAuth(deps.db), requireCsrf, requirePermission(deps.db, 'money_in.feed'), async (_req, res, next) => {
    try {
      const env = (await deps.settings.get('daraja.environment')) === 'production' ? 'production' : 'sandbox';
      const shortcode = (await deps.settings.get(`env.${env}.shortcode`)) ?? '000000';
      res.json(await runFeedTest({ db: deps.db, events: deps.events, cache: deps.cache, shortcode }));
    } catch (e) { next(e); }
  });

  // Round 5: the owner's answer to "where do these payments arrive today". A preference, so no
  // password: it changes nothing about money, and the feed stays open either way.
  r.post('/arrival', requireAuth(deps.db), requireCsrf, requireOwner, async (req, res, next) => {
    try {
      const arrival = req.body?.arrival;
      if (arrival !== 'studio' && arrival !== 'forwarder') throw new HttpError(400, 'invalid', 'Say either studio or forwarder.');
      res.json(await deps.moneyIn.setArrival(arrival, { personId: req.person!.id, ip: clientIp(req) }));
    } catch (e) { next(e); }
  });
  return r;
}
