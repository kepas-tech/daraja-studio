import { Router } from 'express';
import type { Db } from '../db/pool.js';
import { requireAuth, requireCsrf, requireStepUp, requireUnlocked } from './middleware.js';
import type { WebauthnService } from './webauthn.js';

/**
 * Brief 2, item 5b. The four ceremonies, plus the list and the removal Organisation needs.
 *
 * Enrolling needs an open session (it proves the person is already inside); the two open routes are
 * the only ones a locked session may call, beside the PIN and the password. An open that verifies
 * sets exactly the flag the PIN sets and does nothing else — money still asks for the PIN or the
 * password, never a fingerprint on its own.
 *
 * Removal is a POST with the identifier in the body rather than a DELETE with it in the path: a URL
 * lands in proxy logs and access logs, and nothing about a credential may be logged.
 */
export function webauthnRoutes(deps: { db: Db; webauthn: WebauthnService }): Router {
  const r = Router();
  const svc = deps.webauthn;
  r.use(requireAuth(deps.db), requireCsrf);

  r.post('/register/options', requireUnlocked, async (req, res, next) => {
    try { res.json(await svc.registerOptions({ id: req.person!.id, username: req.person!.username }, req.sessionId!)); } catch (e) { next(e); }
  });

  r.post('/register/verify', requireUnlocked, async (req, res, next) => {
    try {
      await svc.registerVerify({ id: req.person!.id }, req.sessionId!, req.body, req.get('user-agent') ?? '');
      res.status(204).end();
    } catch (e) { next(e); }
  });

  // A locked session may call these two: this is the fingerprint's way in.
  r.post('/open/options', async (req, res, next) => {
    try { res.json(await svc.openOptions({ id: req.person!.id }, req.sessionId!)); } catch (e) { next(e); }
  });

  r.post('/open/verify', async (req, res, next) => {
    try {
      await svc.openVerify({ id: req.person!.id }, req.sessionId!, req.body);
      // The whole of what opening means: the same flag the PIN sets, on this session only.
      await deps.db.query('UPDATE sessions SET pin_entered_at = now() WHERE id=$1', [req.sessionId]);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.get('/credentials', requireUnlocked, async (req, res, next) => {
    try { res.json({ items: await svc.list(req.person!.id) }); } catch (e) { next(e); }
  });

  // Behind the step-up, which also means: never while the session is locked.
  r.post('/credentials/remove', requireStepUp(deps.db), async (req, res, next) => {
    try {
      const id = typeof req.body?.id === 'string' ? req.body.id : '';
      await svc.remove(req.person!.id, id);
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
