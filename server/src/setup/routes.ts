import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import type { Env } from '../settings/store.js';
import { withOrg } from '../db/pool.js';
import { requireAuth, requireCsrf, requireOwner } from '../auth/middleware.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { cookieHeader, createSession } from '../auth/sessions.js';
import { clientIp } from '../util/ip.js';
import { provePasskey } from '../settings/passkeyProof.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';

const ownerSchema = z.object({ displayName: z.string().trim().min(1).max(80), username: z.string().trim().regex(/^[a-z0-9_.-]{3,32}$/i), password: z.string().min(MIN_PASSWORD_LENGTH).max(512) });
const usesSchema = z.object({ payOut: z.boolean(), collect: z.boolean(), stk: z.boolean().default(false) });
const orgSchema = z.object({ name: z.string().trim().min(1).max(120), nominatedNumber: z.string().trim().regex(/^254\d{9}$/), notificationPhone: z.string().trim().regex(/^254\d{9}$/) });
const modeSchema = z.object({ environment: z.enum(['sandbox','production']), confirmShortcode: z.string().optional() });
const shortcodeSchema = z.object({ shortcode: z.string().trim().regex(/^\d{5,7}$/) });
const credsSchema = z.object({ consumerKey: z.string().min(1), consumerSecret: z.string().min(1) });
// A passkey has no documented format, so there is no shape to enforce beyond a sane upper bound —
// the proof is Safaricom accepting a push made with it, which the route runs before this can pass.
const passkeySchema = z.object({
  passkey: z.string().trim().min(1).max(200),
  phone: z.string().trim().regex(/^254\d{9}$/, 'Enter your own number as 254… so we can send you the test.'),
});
const operatorSchema = z.object({ name: z.string().trim().min(1).max(40), operatorPassword: z.string().min(1).optional(), credential: z.string().min(1).optional(), certPem: z.string().optional() });
const urlSchema = z.object({ url: z.string().url() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export function setupRoutes(deps: AppDeps): Router {
  const r = Router();
  const svc = deps.settingsService;
  const step = (s: string) => deps.settings.set('setup.step', s);
  const currentMode = async (): Promise<Env> => ((await deps.settings.get('daraja.environment')) as Env) ?? 'sandbox';

  /**
   * /status and /owner sit above requireAuth, so they are reachable both anonymously and by a
   * signed-in caller — orgContext (mounted globally, ahead of this router) has already entered a
   * session's own organisation and set `req.org` by the time either handler runs, and that must
   * always win: falling back to the host/fallback organisation for a signed-in tenant would disclose
   * the host's setup state to every tenant, and every tenant's to each other.
   * Only truly anonymous requests (no session, `req.org` unset) reach this resolution at all — this
   * install has one organisation, held as the process's own fallback. Reading db.query's implicit
   * pool fallback instead would silently answer from whatever the *process-wide* currentOrgId()
   * last held, which is only ever correct by accident.
   */
  async function resolveSetupOrg(): Promise<string | null> {
    return deps.db.getFallbackOrg();
  }

  r.get('/status', async (req, res, next) => {
    try {
      const orgId = req.org?.id ?? await resolveSetupOrg();
      if (!orgId) { res.json({ needsOwner: true, completed: false, step: null }); return; }
      const { n, s, env } = await withOrg(orgId, async () => {
        const [{ n }] = await deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM people');
        const env = await currentMode();
        const s = await deps.settings.getMany([
          'setup.completedAt', 'setup.step', 'use.payOut', 'use.collect', 'use.stk', `env.${env}.passkeyProvenAt`,
          'org.name', 'org.nominatedNumber', 'org.notificationPhone', `env.${env}.shortcode`, `env.${env}.credsVerifiedAt`, 'public.url', 'public.verifiedAt',
        ]);
        return { n, s, env };
      });
      res.json({
        needsOwner: n === '0', completed: !!s['setup.completedAt'], step: s['setup.completedAt'] ? 'done' : s['setup.step'],
        // Never asked yet is not the same as answering no to both — the wizard must ask rather
        // than assume, so this stays null until `/uses` has actually been posted.
        uses: s['use.payOut'] === null && s['use.collect'] === null ? null : { payOut: s['use.payOut'] === 'true', collect: s['use.collect'] === 'true', stk: s['use.stk'] === 'true' },
        passkeyProven: !!s[`env.${env}.passkeyProvenAt`],
        // What earlier steps already stored, so Back lands on the answer rather than a blank field.
        // Secrets are never echoed: the key/secret and passkey steps only learn that one is in place.
        // Only a signed-in caller gets these; the anonymous first visit does not.
        ...(req.person ? {
          saved: {
            mode: env,
            org: { name: s['org.name'], nominatedNumber: s['org.nominatedNumber'], notificationPhone: s['org.notificationPhone'] },
            shortcode: s[`env.${env}.shortcode`],
            darajaVerified: !!s[`env.${env}.credsVerifiedAt`],
            publicUrl: s['public.url'], publicVerified: !!s['public.verifiedAt'],
          },
        } : {}),
      });
    } catch (e) { next(e); }
  });

  const ownerExists = () => new HttpError(409, 'owner_exists', 'The owner account already exists. Please log in.');

  r.post('/owner', async (req, res, next) => {
    try {
      const orgId = req.org?.id ?? await resolveSetupOrg();
      if (!orgId) throw new HttpError(503, 'no_org', 'No organisation is ready yet.');
      await withOrg(orgId, async () => {
        // Fast path: reject immediately (before validating/hashing anything) once an owner
        // already exists — this check alone is racy under concurrent requests, which is exactly
        // why it's not what makes this safe (see below).
        const [{ n }] = await deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM people');
        if (n !== '0') throw ownerExists();
        const b = parse(ownerSchema, req.body);
        const passwordHash = await hashPassword(b.password);
        // The people(is_owner) WHERE is_owner unique index (migration 003) is what actually makes
        // this safe under concurrent first-run requests: two racing calls can both pass the fast
        // path above, but only one INSERT can win — the loser gets zero rows back (`WHERE NOT
        // EXISTS` re-checked at insert time) or a 23505 conflict from the unique index, never a
        // second owner.
        let p: { id: string } | undefined;
        try {
          [p] = await deps.db.query<{ id: string }>(
            `INSERT INTO people(username, display_name, password_hash, is_owner)
             SELECT $1, $2, $3, true WHERE NOT EXISTS (SELECT 1 FROM people) RETURNING id`,
            [b.username, b.displayName, passwordHash]);
        } catch (e) {
          if (e && typeof e === 'object' && (e as { code?: string }).code === '23505') throw ownerExists();
          throw e;
        }
        if (!p) throw ownerExists();
        const ip = clientIp(req);
        const s = await createSession(deps.db, p.id, ip, req.get('user-agent') ?? '');
        await audit(deps.db, { personId: p.id, action: 'setup.owner_created', ip });
        await step('environment');
        const person = (await deps.db.query(
          'SELECT id, username, display_name, is_owner, status, must_change_password, email, role, is_host_admin FROM people WHERE id=$1', [p.id],
        ))[0];
        // Same mask login and /me apply (auth/routes.ts, Minor 1): the column migration 008 can set
        // on an install's host owner must not leak into a single-mode client here either.
        person.is_host_admin = false;
        res.setHeader('Set-Cookie', cookieHeader(s.id, deps.config.nodeEnv === 'production'));
        res.status(201).json({ person, csrf: s.csrf });
      });
    } catch (e) { next(e); }
  });

  r.use(requireAuth(deps.db), requireCsrf, requireOwner);
  // Once setup is complete, the wizard's own steps must stop accepting changes — they carry no
  // step-up check (the owner just typed their password to create the account), so leaving them
  // open forever would be a standing way to change Daraja creds, the passkey, etc. without ever
  // being asked for the studio password again. Settings is the only place for that from here on.
  r.use(async (_req, _res, next) => {
    try {
      if (await deps.settings.get('setup.completedAt')) {
        throw new HttpError(409, 'setup_done', 'Setup is finished. Change this in Settings instead.');
      }
      next();
    } catch (e) { next(e); }
  });
  const a = (req: { person?: { id: string } } & Parameters<typeof clientIp>[0]) => ({ personId: req.person?.id ?? null, ip: clientIp(req) });

  /** What the business said it needs, in its own words. Decides which later steps are required. */
  async function readUses(): Promise<{ payOut: boolean; collect: boolean; stk: boolean }> {
    const s = await deps.settings.getMany(['use.payOut', 'use.collect', 'use.stk']);
    return { payOut: s['use.payOut'] === 'true', collect: s['use.collect'] === 'true', stk: s['use.stk'] === 'true' };
  }

  // Asked before any credential, because the answers decide which credentials are asked for at
  // all. Neither ticked is refused here rather than later: an install that can neither pay out nor
  // take money in does nothing, and letting it through would produce exactly the "finished setup,
  // nothing works" ending this step exists to prevent.
  r.post('/uses', async (req, res, next) => {
    try {
      const b = parse(usesSchema, req.body);
      if (!b.payOut && !b.collect) throw new HttpError(400, 'nothing_chosen', 'Choose at least one. Studio needs to know what this shortcode is for.');
      await deps.settings.set('use.payOut', String(b.payOut));
      await deps.settings.set('use.collect', String(b.collect));
      // The phone prompt (STK Push) is the one way of receiving that needs a passkey, so it is
      // its own answer: receiving over paybill/till alone asks for nothing extra.
      await deps.settings.set('use.stk', String(b.stk));
      await audit(deps.db, { personId: req.person!.id, action: 'setup.uses', ip: clientIp(req), after: b });
      await step('org');
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.post('/environment', async (req, res, next) => { try { const b = parse(modeSchema, req.body); const out = await svc.setMode(b.environment, b.confirmShortcode, a(req)); await step('uses'); res.json(out); } catch (e) { next(e); } });
  r.post('/org', async (req, res, next) => { try { await svc.setOrg(parse(orgSchema, req.body), a(req)); await step('shortcode'); res.status(204).end(); } catch (e) { next(e); } });
  r.post('/shortcode', async (req, res, next) => { try { const b = parse(shortcodeSchema, req.body); const out = await svc.setShortcode(await currentMode(), b.shortcode, a(req)); await step('daraja'); res.json(out); } catch (e) { next(e); } });
  r.post('/daraja', async (req, res, next) => { try { const b = parse(credsSchema, req.body); const out = await svc.setDarajaCreds(await currentMode(), b.consumerKey, b.consumerSecret, a(req)); if (out.ok) await step('public-url'); res.json(out); } catch (e) { next(e); } });
  r.post('/public-url', async (req, res, next) => { try { await svc.setPublicUrl(parse(urlSchema, req.body).url, a(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.post('/public-url/test', async (req, res, next) => {
    try {
      const out = await svc.testPublicUrl();
      // The passkey can only be tested once the callback address is reachable — Safaricom's
      // acknowledgement is the proof, but the push itself needs a real address to answer.
      // Only the phone prompt (STK Push) needs a passkey; only paying out needs an operator. Skip
      // straight past whichever the business did not ask for.
      if (out.ok) { const uses = await readUses(); await step(uses.stk ? 'passkey' : uses.payOut ? 'operator' : 'done'); }
      res.json(out);
    } catch (e) { next(e); }
  });
  // The one proof a passkey can have: no read-only Daraja call exercises it, so the only evidence
  // it is right is Safaricom accepting a push made with it. A wrong one is refused at the
  // acknowledgement, before any phone rings, so this is safe — a failure costs nothing and a
  // success can be cancelled on the owner's own handset. The step only advances once proven; a
  // refusal leaves it exactly where it was, so a reload never skips past an unproven passkey.
  r.post('/passkey', async (req, res, next) => {
    try {
      const env = await currentMode();
      const b = parse(passkeySchema, req.body);
      const out = await provePasskey(deps, env, b, { personId: req.person!.id, ip: clientIp(req) }, 'setup.passkey');
      if (out.proven) await step((await readUses()).payOut ? 'operator' : 'done');
      res.json(out);
    } catch (e) { next(e); }
  });
  r.post('/operator', async (req, res, next) => { try { const b = parse(operatorSchema, req.body); const out = await deps.operators.add(await currentMode(), { name: b.name, password: b.operatorPassword, certPem: b.certPem, credential: b.credential }, a(req)); res.status(201).json(out); } catch (e) { next(e); } });
  r.post('/complete', async (req, res, next) => {
    try {
      const v = await svc.view();
      const uses = await readUses();
      // `details.step` names the wizard step to return to, so the Done page can send the owner
      // straight there instead of stating a problem with no way to fix it.
      if (!v.environments[v.mode].ready.creds) throw new HttpError(409, 'incomplete', 'Add the Daraja key and secret first.', { step: 'daraja' });
      if (!v.publicVerifiedAt) throw new HttpError(409, 'incomplete', 'Test your public address first.', { step: 'public-url' });
      if (uses.payOut && !v.environments[v.mode].ready.operator) throw new HttpError(409, 'incomplete', 'Add a working API operator first.', { step: 'operator' });
      if (uses.stk && !(await deps.settings.get(`env.${v.mode}.passkeyProvenAt`))) throw new HttpError(409, 'incomplete', 'Prove your passkey first.', { step: 'passkey' });
      await deps.settings.set('setup.completedAt', new Date().toISOString());
      // Mirrors what migration 007 did once, by hand, for the live organisation: the wizard is the
      // only route that ever moves a boot-created organisation (single mode's own, or a hosted
      // install's host) out of `pending` — sign-up's callback verifies a tenant instead, and never
      // touches this one.
      await deps.db.query(`UPDATE orgs SET status='verified', verified_at=COALESCE(verified_at, now()) WHERE id=app_current_org() AND status='pending'`);
      await step('done');
      await audit(deps.db, { personId: req.person!.id, action: 'setup.completed', ip: clientIp(req) });
      await deps.events.publish('setup.updated', { completed: true });
      res.status(204).end();
    } catch (e) { next(e); }
  });
  return r;
}
