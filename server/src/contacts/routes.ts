import { Router } from 'express';
import { z } from 'zod';
import { normalizePhone } from '@kepas/daraja-js';
import type { AppDeps } from '../app.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import { requirePermission } from '../permissions/middleware.js';
import { requireModule } from '../modules/middleware.js';
import { audit } from '../audit/log.js';
import { clientIp } from '../util/ip.js';
import { HttpError } from '../util/errors.js';

export interface ContactView {
  id: string; kind: 'phone' | 'till' | 'paybill';
  name: string; phone: string | null; shortcode: string | null;
  accountReference: string | null; note: string | null; createdAt: string;
}

type Kind = ContactView['kind'];

interface ContactRow {
  id: string; kind: Kind; name: string; phone: string | null;
  shortcode: string | null; account_reference: string | null; note: string | null; created_at: Date;
}

const SELECT = 'SELECT id, kind, name, phone, shortcode, account_reference, note, created_at FROM contacts';

const toView = (r: ContactRow): ContactView => ({
  id: r.id, kind: r.kind, name: r.name, phone: r.phone, shortcode: r.shortcode,
  accountReference: r.account_reference, note: r.note, createdAt: r.created_at.toISOString(),
});

const bodySchema = z.object({
  kind: z.enum(['phone', 'till', 'paybill']),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(1).max(20).optional(),
  shortcode: z.string().trim().min(1).max(10).optional(),
  accountReference: z.string().trim().min(1).max(20).optional(),
  note: z.string().trim().max(200).optional(),
});
type Body = z.infer<typeof bodySchema>;

const listQuery = z.object({
  kind: z.enum(['phone', 'till', 'paybill']).optional(),
  q: z.string().trim().max(80).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, 'invalid', r.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '));
  return r.data;
}

const UNIQUE_VIOLATION = '23505';
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const NOT_FOUND = 'That contact does not exist.';
const nameTaken = (name: string) => new HttpError(409, 'name_taken', 'You already have a contact called ' + name + '.');

/** LIKE metacharacters in the operator's own search text stay literal: a typed % searches for %. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => '\\' + ch);

interface Shape { phone: string | null; shortcode: string | null; accountReference: string | null }

/**
 * The per-kind shape rule, the same one the SQL check carries. A field that does not belong to the
 * kind is refused, never quietly dropped — a phone number saved against a till would be a number
 * nobody can explain later. The phone goes through the SDK's normalizePhone, so 0712 345 678 is
 * stored 254712345678.
 */
function shape(b: Body): Shape {
  if (b.kind === 'phone') {
    if (b.shortcode || b.accountReference) throw new HttpError(400, 'invalid', 'A phone contact has a phone number only. Remove the till or paybill details.');
    if (!b.phone) throw new HttpError(400, 'invalid', 'Enter a phone number for this contact.');
    try { return { phone: normalizePhone(b.phone), shortcode: null, accountReference: null }; }
    catch { throw new HttpError(400, 'invalid', 'Enter a Kenyan mobile number such as 0712 345 678.'); }
  }
  if (b.phone) throw new HttpError(400, 'invalid', 'A ' + b.kind + ' contact has a ' + b.kind + ' number, not a phone number.');
  if (!b.shortcode) throw new HttpError(400, 'invalid', 'Enter the ' + b.kind + ' number for this contact.');
  if (!/^[0-9]{5,7}$/.test(b.shortcode)) throw new HttpError(400, 'invalid', 'A till or paybill number is 5 to 7 digits.');
  if (b.kind === 'till') {
    if (b.accountReference) throw new HttpError(400, 'invalid', 'Only a paybill contact has an account reference.');
    return { phone: null, shortcode: b.shortcode, accountReference: null };
  }
  if (b.accountReference && !/^[A-Za-z0-9]{1,20}$/.test(b.accountReference)) throw new HttpError(400, 'invalid', 'An account reference is up to 20 letters and numbers.');
  return { phone: null, shortcode: b.shortcode, accountReference: b.accountReference ?? null };
}

/**
 * Feature 1. Reads need a session and nothing more: the Send and Bulk pickers must work for whoever
 * may send, and a saved name is not a secret. Writes take `contacts.manage`, which is deliberately
 * not in the operator, viewer or approver presets — changing where money goes is the owner's job,
 * while a custom role can still be granted it.
 */
export function contactsRoutes(deps: AppDeps): Router {
  const r = Router();
  r.use(requireAuth(deps.db), requireCsrf, requireModule(deps.modules, 'contacts'));
  const canManage = requirePermission(deps.db, 'contacts.manage');
  const actor = (req: Parameters<typeof clientIp>[0] & { person?: { id: string } }) => ({ personId: req.person?.id ?? null, ip: clientIp(req) });

  /** A live row of this organisation, or 404. */
  async function live(id: string, orgId: string): Promise<{ id: string; kind: Kind; name: string }> {
    if (!isUuid(id)) throw new HttpError(404, 'not_found', NOT_FOUND);
    const [row] = await deps.db.query<{ id: string; kind: Kind; name: string }>(
      'SELECT id, kind, name FROM contacts WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL', [id, orgId]);
    if (!row) throw new HttpError(404, 'not_found', NOT_FOUND);
    return row;
  }

  /** The partial unique index is what actually stops a race; this is the friendly answer first. */
  async function assertNameFree(orgId: string, name: string, exceptId: string | null): Promise<void> {
    const rows = await deps.db.query(
      'SELECT 1 FROM contacts WHERE org_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND ($3::uuid IS NULL OR id <> $3)',
      [orgId, name, exceptId]);
    if (rows.length > 0) throw nameTaken(name);
  }

  r.get('/', async (req, res, next) => {
    try {
      const q = parse(listQuery, req.query);
      const where = ['org_id = $1', 'deleted_at IS NULL'];
      const params: unknown[] = [req.org!.id];
      if (q.kind) { params.push(q.kind); where.push('kind = $' + params.length); }
      if (q.q) { params.push('%' + escapeLike(q.q) + '%'); where.push('name ILIKE $' + params.length + " ESCAPE '\\'"); }
      const rows = await deps.db.query<ContactRow>(SELECT + ' WHERE ' + where.join(' AND ') + ' ORDER BY lower(name) ASC, name ASC', params);
      res.json({ items: rows.map(toView) });
    } catch (e) { next(e); }
  });

  r.post('/', canManage, async (req, res, next) => {
    try {
      const b = parse(bodySchema, req.body);
      const s = shape(b);
      const orgId = req.org!.id;
      await assertNameFree(orgId, b.name, null);
      let row: ContactRow;
      try {
        [row] = await deps.db.query<ContactRow>(
          'INSERT INTO contacts(org_id, kind, name, phone, shortcode, account_reference, note, created_by)' +
          ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)' +
          ' RETURNING id, kind, name, phone, shortcode, account_reference, note, created_at',
          [orgId, b.kind, b.name, s.phone, s.shortcode, s.accountReference, b.note || null, req.person!.id]);
      } catch (e) {
        if (e && typeof e === 'object' && (e as { code?: string }).code === UNIQUE_VIOLATION) throw nameTaken(b.name);
        throw e;
      }
      // The audit row records the label and the kind, never the number or the account reference.
      await audit(deps.db, { ...actor(req), action: 'contact.added', target: row.id, after: { kind: b.kind, name: b.name } });
      res.status(201).json(toView(row));
    } catch (e) { next(e); }
  });

  r.put('/:id', canManage, async (req, res, next) => {
    try {
      const orgId = req.org!.id;
      const before = await live(String(req.params.id), orgId);
      const b = parse(bodySchema, req.body);
      const s = shape(b);
      await assertNameFree(orgId, b.name, before.id);
      let row: ContactRow | undefined;
      try {
        [row] = await deps.db.query<ContactRow>(
          'UPDATE contacts SET kind=$3, name=$4, phone=$5, shortcode=$6, account_reference=$7, note=$8, updated_at=now()' +
          ' WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL' +
          ' RETURNING id, kind, name, phone, shortcode, account_reference, note, created_at',
          [before.id, orgId, b.kind, b.name, s.phone, s.shortcode, s.accountReference, b.note || null]);
      } catch (e) {
        if (e && typeof e === 'object' && (e as { code?: string }).code === UNIQUE_VIOLATION) throw nameTaken(b.name);
        throw e;
      }
      // The UPDATE is qualified on deleted_at IS NULL, so a contact deleted between the read and the
      // write answers 404 instead of being brought back.
      if (!row) throw new HttpError(404, 'not_found', NOT_FOUND);
      await audit(deps.db, { ...actor(req), action: 'contact.edited', target: row.id, before: { kind: before.kind, name: before.name }, after: { kind: b.kind, name: b.name } });
      res.json(toView(row));
    } catch (e) { next(e); }
  });

  r.delete('/:id', canManage, async (req, res, next) => {
    try {
      const orgId = req.org!.id;
      if (!isUuid(String(req.params.id))) throw new HttpError(404, 'not_found', NOT_FOUND);
      // Soft: History keeps showing the name this contact was paid under.
      const [row] = await deps.db.query<{ id: string; kind: Kind; name: string }>(
        'UPDATE contacts SET deleted_at=now(), updated_at=now() WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL RETURNING id, kind, name',
        [String(req.params.id), orgId]);
      if (!row) throw new HttpError(404, 'not_found', NOT_FOUND);
      await audit(deps.db, { ...actor(req), action: 'contact.deleted', target: row.id, before: { kind: row.kind, name: row.name } });
      res.status(204).end();
    } catch (e) { next(e); }
  });

  return r;
}
