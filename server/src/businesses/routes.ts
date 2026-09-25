import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf, requireStepUp } from '../auth/middleware.js';
import { assertPermission, requirePermission } from '../permissions/middleware.js';
import { personOf } from '../http/actor.js';
import { requireModule } from '../modules/middleware.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';
import { createClaimsService } from '../routing/claims.js';
import { typeTemplate } from './types.js';

/**
 * Brief 2, items 1 and 1b. Reading is open to any signed-in person, because the Send, Ask-for-payment,
 * QR and invoice screens all pick from this list; writing takes businesses.manage, which is in no role
 * preset — deciding whose money a payment is, and naming the account a payer will use, is the owner's
 * job. Every write lands in audit_log.
 *
 * No account body has a number field, and every one of them is strict: a client that sends a number —
 * or a business code — for Studio to use gets a 400 rather than a row.
 *
 * Deleting works like deleting the studio: the person types the exact name of the thing, then their
 * password (or their PIN). A wrong name and a wrong password both delete nothing, and the server
 * checks the name itself rather than trusting the dialog.
 */

const name = z.string().trim().min(1).max(80);
const phone = z.string().trim().min(1).max(20).optional();
const note = z.string().trim().max(200).optional();
const uuid = z.string().uuid();
/** The typed name is the confirmation; the password is taken out of the body by requireStepUp. */
const deleteSchema = z.object({ name: z.string().max(80) }).strict();
const updateSchema = z.object({ name, active: z.boolean() });
/**
 * Strict on purpose, both of them: a business code and an account number are Studio's to give, so
 * neither is a field of any body a client sends. A body that carries one is a 400, not a row.
 */
// Round 3, phase B: the kind of business is chosen as the business is made, and defaults to the
// neutral one, so every caller that predates this keeps working.
const createSchema = z.object({ name, typeKey: z.string().trim().min(1).max(30).optional() }).strict();
const typeBody = z.object({ name: z.string().trim().min(1).max(40), template: typeTemplate }).strict();
const typeKeySchema = z.object({ typeKey: z.string().trim().min(1).max(30) }).strict();
// Round 3, phase C: the standing amount one account is expected to pay each period, when its kind
// of business has one. Sent in shillings, stored in cents, and never charged by anything automatic.
const accountSchema = z.object({ name, phone, note, standingCents: z.number().int().positive().max(1_000_000_000).nullish() }).strict();
const assignSchema = z.object({ businessId: uuid, accountId: uuid.nullish() });
const listSchema = z.object({ q: z.string().trim().max(80).optional() });
// Migration 050: an app's user, by the app's own reference for them.
const refSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), phone, businessId: uuid.optional() }).strict();
const refParam = z.string().trim().min(1).max(64);
const isRealDay = (s: string) => {
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const daySchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, { message: 'Enter a real date.' }).optional() });
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const NOT_FOUND = 'That business does not exist.';
const ACCOUNT_NOT_FOUND = 'That account does not exist.';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

const actor = (req: Request) => ({ personId: req.person!.id, ip: clientIp(req) });

export function businessesRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'businesses'));

  r.get('/', async (_req, res, next) => {
    try { res.json(await deps.businesses.list()); } catch (e) { next(e); }
  });

  // Today's in and out per business, for Home. Read-only and cheap: one grouped query.
  r.get('/summary', async (req, res, next) => {
    try { res.json(await deps.businesses.summary(parse(daySchema, req.query).day)); } catch (e) { next(e); }
  });

  r.post('/', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const b = parse(createSchema, req.body);
      res.status(201).json(await deps.businesses.create(b.name, b.typeKey ?? 'other', actor(req)));
    } catch (e) { next(e); }
  });

  // The one-click fix on Money in. It labels a row and nothing else.
  r.post('/assign/:requestId', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.requestId);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', 'That payment does not exist.');
      const b = parse(assignSchema, req.body);
      res.json(await deps.businesses.assign(id, b.businessId, b.accountId ?? null, actor(req)));
    } catch (e) { next(e); }
  });

  r.put('/:id', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      const b = parse(updateSchema, req.body);
      res.json(await deps.businesses.update(id, b.name, b.active, actor(req)));
    } catch (e) { next(e); }
  });

  // Round 3, phase B: change the kind of business. Words change; codes, accounts, numbers and every
  // payment that already names the business do not.
  // Round 3, phase C: one account's running statement, and who is behind for the whole business.
  // Both are reads; neither moves money or asks Safaricom anything.
  // Step one: arrears are the statements module's, so a studio with no statements is not offered them.
  r.get('/:id/arrears', requireModule(deps.modules, 'statements'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      res.json(await deps.statements.arrears(id));
    } catch (e) { next(e); }
  });

  r.put('/:id/type', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      const b = parse(typeKeySchema, req.body);
      res.json(await deps.businesses.updateType(id, b.typeKey, actor(req)));
    } catch (e) { next(e); }
  });

  // Deleting a business is the studio's own ceremony: exact name, then password or PIN. Refused
  // while it still has accounts, whose numbers are somebody's.
  r.delete('/:id', requirePermission(deps.db, 'businesses.manage'), requireStepUp(deps.db), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      const b = parse(deleteSchema, req.body);
      await deps.businesses.deleteBusiness(id, b.name, actor(req));
      res.status(204).end();
    } catch (e) { next(e); }
  });

  r.get('/:id/accounts', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      const q = parse(listSchema, req.query).q;
      res.json({ items: await deps.businesses.accounts(id, q) });
    } catch (e) { next(e); }
  });

  r.post('/:id/accounts', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
      const b = parse(accountSchema, req.body);
      res.status(201).json(await deps.businesses.addAccount(id, b, actor(req)));
    } catch (e) { next(e); }
  });

  return r;
}

/**
 * Round 3, phase B: the kinds of business. Reading is open to any signed-in person — the account
 * pickers and the Businesses page name the words a type carries — while writing takes
 * businesses.manage, the same permission as the businesses themselves.
 */
export function businessTypesRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'businesses'));

  r.get('/', async (_req, res, next) => {
    try { res.json(await deps.businessTypes.list()); } catch (e) { next(e); }
  });

  r.post('/', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const b = parse(typeBody, req.body);
      res.status(201).json(await deps.businessTypes.create(b, actor(req)));
    } catch (e) { next(e); }
  });

  r.put('/:key', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const b = parse(typeBody, req.body);
      res.json(await deps.businessTypes.update(String(req.params.key), b, actor(req)));
    } catch (e) { next(e); }
  });

  r.delete('/:key', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try { await deps.businessTypes.remove(String(req.params.key), actor(req)); res.status(204).end(); } catch (e) { next(e); }
  });

  return r;
}

/** The account routes live at their own address, because an account id already names its business. */
export function accountsRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'businesses'));

  /**
   * Which business a reference is looked up in. A key works in its own business only, and needs
   * `accounts.own`; a person needs `businesses.manage` and names the business.
   */
  async function refBusiness(req: Request, named: string | undefined): Promise<string> {
    if (req.apiKey) {
      await assertPermission(deps.db, req.person!, 'accounts.own', req.apiKey.permissions);
      if (!req.apiKey.businessId) throw new HttpError(409, 'key_without_business', 'This key has no business, so it cannot open accounts. Make a key for the business.');
      return req.apiKey.businessId;
    }
    await assertPermission(deps.db, req.person!, 'businesses.manage');
    if (!named || !isUuid(named)) throw new HttpError(400, 'invalid', 'businessId: say which business.');
    return named;
  }

  // Migration 050: the account an app's user has, opened on first use. 201 when it was just opened.
  r.put('/by-ref/:ref', async (req, res, next) => {
    try {
      const ref = parse(refParam, req.params.ref);
      const b = parse(refSchema, req.body ?? {});
      const businessId = await refBusiness(req, b.businessId);
      const out = await deps.businesses.accountByRef(businessId, ref, { name: b.name, phone: b.phone ?? null }, { personId: personOf(req), ip: clientIp(req) });
      res.status(out.created ? 201 : 200).json(out.account);
    } catch (e) { next(e); }
  });
  r.get('/by-ref/:ref', async (req, res, next) => {
    try {
      const ref = parse(refParam, req.params.ref);
      const businessId = await refBusiness(req, typeof req.query.businessId === 'string' ? req.query.businessId : undefined);
      const found = await deps.businesses.findByRef(businessId, ref);
      if (!found) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      res.json(found);
    } catch (e) { next(e); }
  });

  // Migration 052: named account numbers. A person may choose a word such as JOHN as their account
  // number; on a shared paybill it must be free across every business on it. A taken name is answered
  // with free suggestions (JOHN7, 24JOHN), each checked the same way.
  const claims = createClaimsService({ db: deps.db });
  /** The account an id or an app's reference names, in the business the caller may act for. */
  async function namedAccount(req: Request): Promise<string> {
    if (req.params.ref !== undefined) {
      const ref = parse(refParam, req.params.ref);
      const businessId = await refBusiness(req, typeof req.query.businessId === 'string' ? req.query.businessId : (req.body?.businessId as string | undefined));
      const found = await deps.businesses.findByRef(businessId, ref);
      if (!found) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      return found.id;
    }
    await assertPermission(deps.db, req.person!, 'businesses.manage');
    const id = String(req.params.id);
    if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
    return id;
  }
  const nameBody = z.object({ name: z.string().max(40) });
  const claimActor = (req: Request) => ({ personId: personOf(req), apiKeyId: req.apiKey?.keyId ?? null, ip: clientIp(req) });

  r.get('/name-check', async (req, res, next) => {
    try {
      if (req.apiKey) await assertPermission(deps.db, req.person!, 'accounts.own', req.apiKey.permissions);
      else await assertPermission(deps.db, req.person!, 'businesses.manage');
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      const accountId = typeof req.query.accountId === 'string' && isUuid(req.query.accountId) ? req.query.accountId : null;
      res.json(await claims.check(name, accountId));
    } catch (e) { next(e); }
  });
  for (const path of ['/by-ref/:ref/name', '/:id/name']) {
    r.put(path, async (req, res, next) => {
      try {
        const id = await namedAccount(req);
        const b = parse(nameBody, req.body ?? {});
        res.json(await claims.claimName(id, b.name, claimActor(req)));
      } catch (e) { next(e); }
    });
    r.delete(path, async (req, res, next) => {
      try {
        await claims.releaseName(await namedAccount(req), claimActor(req));
        res.status(204).end();
      } catch (e) { next(e); }
    });
  }

  // A sub-account under an account. Refused a level deeper.
  r.post('/:id/sub-accounts', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      const b = parse(accountSchema, req.body);
      res.status(201).json(await deps.businesses.addSubAccount(id, b, actor(req)));
    } catch (e) { next(e); }
  });

  // Every past holder of this number. Reading is open to whoever may look at the account.
  r.get('/:id/history', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      const [account] = await deps.db.query<{ full_number: string }>(`SELECT full_number FROM accounts WHERE id=$1`, [id]);
      if (!account) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      res.json({ items: await deps.businesses.history(account.full_number) });
    } catch (e) { next(e); }
  });

  r.put('/:id', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      const b = parse(accountSchema, req.body);
      res.json(await deps.businesses.updateAccount(id, b, actor(req)));
    } catch (e) { next(e); }
  });

  // The account's statement: every payment in, every payout out and every invoice raised, oldest
  // first, with what has been paid and what is still owed on top.
  r.get('/:id/statement', requireModule(deps.modules, 'statements'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      res.json(await deps.statements.statement(id));
    } catch (e) { next(e); }
  });

  // One press, and one invoice: the account's standing amount for the coming period, built here and
  // sent by the invoices service. Nothing is raised until this runs, and nothing is ever automatic.
  // Step one: it writes an invoice, so it belongs to the invoices module as well as to businesses.
  r.post('/:id/next-invoice', requireModule(deps.modules, 'invoices'), requirePermission(deps.db, 'invoices.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      const input = await deps.statements.nextInvoice(id);
      res.status(201).json(await deps.invoices.create(input, actor(req)));
    } catch (e) { next(e); }
  });

  // The reminder Studio writes for the owner to send: recorded, never sent by Studio itself.
  r.post('/:id/remind', requirePermission(deps.db, 'businesses.manage'), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      res.json(await deps.statements.remind(id, actor(req)));
    } catch (e) { next(e); }
  });

  // Delete means delete: the row and its sub-accounts go, the numbers return to the free pool, and
  // number_history keeps who held them. Exact name, then password or PIN.
  r.delete('/:id', requirePermission(deps.db, 'businesses.manage'), requireStepUp(deps.db), async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isUuid(id)) throw new HttpError(404, 'not_found', ACCOUNT_NOT_FOUND);
      const b = parse(deleteSchema, req.body);
      await deps.businesses.deleteAccount(id, b.name, actor(req));
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
