import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';

/**
 * Round 3, phase B: what kind of business this is.
 *
 * A type is data, not code. Its row carries a template: the words an account is called, whether
 * money is expected regularly and how often, whether an account stands for a set amount, the payment
 * categories, what the type does with invoices and reminders, what Home leads with, and what the
 * business's statement is called.
 *
 * The fields that are sentences — the two nouns, the statement name, the category names — are free
 * text, so a new kind of business reads properly without a deploy. The four that are behaviour are
 * chosen from a fixed set, because each one is wired to something Studio does, and the sentences
 * around them live in the web's own copy.
 */

/** How often money is expected from an account. Phase C's arrears read this. */
export const REGULAR = ['no', 'weekly', 'monthly', 'each_term'] as const;
/** Whether each account stands for a set amount: the rent, the fee, or a pledge that varies. */
export const STANDING = ['none', 'fixed', 'pledge'] as const;
/** What the type does with invoices, and whether they carry reminders. */
export const INVOICES = ['on', 'per_visit', 'each_term', 'off'] as const;
/** What Home leads with for a business of this type. */
export const HOME_LEAD = ['behind', 'takings', 'giving', 'outstanding', 'nothing'] as const;

export const typeTemplate = z.object({
  accountNoun: z.string().trim().min(1, 'Say what one account is called.').max(30, 'Keep it under 30 letters.'),
  subAccountNoun: z.string().trim().min(1).max(30).nullable(),
  regular: z.enum(REGULAR),
  standingAmount: z.enum(STANDING),
  categories: z.array(z.string().trim().min(1, 'A category needs a name.').max(40, 'Keep it under 40 letters.')).max(12, 'Twelve categories is the most one type carries.'),
  invoices: z.enum(INVOICES),
  reminders: z.boolean(),
  homeLead: z.enum(HOME_LEAD),
  statementNoun: z.string().trim().min(1, 'Say what this statement is called.').max(40, 'Keep it under 40 letters.'),
}).strict();

export type TypeTemplate = z.infer<typeof typeTemplate>;
export interface BusinessTypeView { key: string; name: string; template: TypeTemplate }
export interface Actor { personId: string; ip: string }

/** The words a business with no type of its own uses: neutral, nothing turned on. */
export const OTHER_TEMPLATE: TypeTemplate = {
  accountNoun: 'Account',
  subAccountNoun: null,
  regular: 'no',
  standingAmount: 'none',
  categories: [],
  invoices: 'off',
  reminders: false,
  homeLead: 'nothing',
  statementNoun: 'Account',
};

/**
 * The nine kinds of business Studio ships. Each is a seeded row in the owner's own organisation, so
 * the owner may edit any of them and add their own, and none of that needs a deploy.
 */
export const SHIPPED_TYPES: { key: string; name: string; template: TypeTemplate }[] = [
  {
    key: 'rental', name: 'Rental or property',
    template: { accountNoun: 'Tenant', subAccountNoun: 'Room or unit', regular: 'monthly', standingAmount: 'fixed', categories: ['Rent', 'Deposit', 'Water', 'Penalty'], invoices: 'on', reminders: true, homeLead: 'behind', statementNoun: 'Rent statement' },
  },
  {
    key: 'clinic', name: 'Clinic or health',
    template: { accountNoun: 'Patient', subAccountNoun: null, regular: 'no', standingAmount: 'none', categories: ['Consultation', 'Lab', 'Medicine'], invoices: 'per_visit', reminders: false, homeLead: 'takings', statementNoun: 'Patient account' },
  },
  {
    key: 'church', name: 'Church or religious',
    template: { accountNoun: 'Member', subAccountNoun: null, regular: 'no', standingAmount: 'pledge', categories: ['Tithe', 'Offering', 'Building fund'], invoices: 'off', reminders: false, homeLead: 'giving', statementNoun: 'Giving record' },
  },
  {
    key: 'school', name: 'School',
    template: { accountNoun: 'Student', subAccountNoun: 'Class', regular: 'each_term', standingAmount: 'fixed', categories: ['Tuition', 'Transport', 'Lunch'], invoices: 'each_term', reminders: true, homeLead: 'outstanding', statementNoun: 'Fee statement' },
  },
  {
    key: 'shop', name: 'Shop or retail',
    template: { accountNoun: 'Customer', subAccountNoun: null, regular: 'no', standingAmount: 'none', categories: ['Sale'], invoices: 'off', reminders: false, homeLead: 'takings', statementNoun: 'Account' },
  },
  {
    key: 'services', name: 'Services or freelance',
    template: { accountNoun: 'Client', subAccountNoun: 'Job', regular: 'no', standingAmount: 'none', categories: ['Service', 'Retainer', 'Deposit'], invoices: 'on', reminders: true, homeLead: 'takings', statementNoun: 'Client account' },
  },
  {
    key: 'chama', name: 'Savings group or chama',
    template: { accountNoun: 'Member', subAccountNoun: null, regular: 'monthly', standingAmount: 'fixed', categories: ['Contribution', 'Fine', 'Loan repayment'], invoices: 'on', reminders: true, homeLead: 'behind', statementNoun: 'Contribution record' },
  },
  {
    key: 'transport', name: 'Transport',
    template: { accountNoun: 'Driver', subAccountNoun: 'Vehicle', regular: 'no', standingAmount: 'none', categories: ['Fare', 'Deposit', 'Maintenance'], invoices: 'off', reminders: false, homeLead: 'takings', statementNoun: 'Trip account' },
  },
  { key: 'other', name: 'Other', template: OTHER_TEMPLATE },
];

interface TypeRow { key: string; name: string; template: unknown; updated_at: Date }

const SELECT_TYPE = 'SELECT t.key, t.name, t.template, t.updated_at FROM business_types t';
/** A deleted kind of business keeps its row as a tombstone; nothing reads one. */
const LIVE = 't.deleted_at IS NULL';

/** A row's JSON read back as a template: a row edited by hand still has to answer like one. */
function toView(r: TypeRow): BusinessTypeView {
  const parsed = typeTemplate.safeParse(r.template);
  return { key: r.key, name: r.name, template: parsed.success ? parsed.data : OTHER_TEMPLATE };
}

function requireOrg(): string {
  const orgId = currentOrgId();
  if (!orgId) throw new Error('no organisation in scope');
  return orgId;
}

/**
 * The shipped types an organisation has not got yet. Called before the list is read or a type is
 * used, so an organisation that predates this table, or one created a minute ago, has all nine.
 * Editing a row afterwards is the owner's: this only ever inserts what is missing.
 */
export async function ensureTypes(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO business_types(key, name, template)
     SELECT v.k, v.n, v.t::jsonb FROM unnest($1::text[], $2::text[], $3::text[]) AS v(k, n, t)
     ON CONFLICT (org_id, key) DO NOTHING`,
    [SHIPPED_TYPES.map((t) => t.key), SHIPPED_TYPES.map((t) => t.name), SHIPPED_TYPES.map((t) => JSON.stringify(t.template))]);
}

/** The type behind one key, for a service that has to answer with a business's own words. */
export async function typeFor(db: Db, key: string | null): Promise<BusinessTypeView | null> {
  const rows = await db.query<TypeRow>(`${SELECT_TYPE} WHERE ${LIVE} AND t.key = $1`, [key ?? 'other']);
  return rows[0] ? toView(rows[0]) : null;
}

/** Every type this organisation has, the shipped ones ensured first. */
export async function listTypes(db: Db): Promise<BusinessTypeView[]> {
  await ensureTypes(db);
  // The shipped nine in the order Studio lists them, then whatever the owner has added, newest kind
  // last. A key nobody ships sorts to the end because array_position has nothing to match.
  const rows = await db.query<TypeRow>(
    `${SELECT_TYPE} WHERE ${LIVE} ORDER BY array_position($1::text[], t.key) NULLS LAST, t.seeded_at, t.key`,
    [SHIPPED_TYPES.map((t) => t.key)]);
  return rows.map(toView);
}

/** The key a new type gets from its name: lowercase words, spaces turned into the _ sign. */
export function keyFromName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
  return /^[a-z]/.test(slug) ? slug : 'type_' + slug.replace(/^_+/, '');
}

export interface BusinessTypesService {
  list(): Promise<{ items: BusinessTypeView[] }>;
  create(input: { name: string; template: TypeTemplate }, actor: Actor): Promise<BusinessTypeView>;
  update(key: string, input: { name: string; template: TypeTemplate }, actor: Actor): Promise<BusinessTypeView>;
  remove(key: string, actor: Actor): Promise<void>;
}

export function createBusinessTypesService(deps: { db: Db }): BusinessTypesService {
  async function row(key: string): Promise<TypeRow> {
    const rows = await deps.db.query<TypeRow>(`${SELECT_TYPE} WHERE ${LIVE} AND t.key = $1 AND t.org_id = $2`, [key, requireOrg()]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'That kind of business does not exist.');
    return rows[0];
  }

  return {
    async list() {
      return { items: await listTypes(deps.db) };
    },


    // The key is derived from the name, and a second type with the same name gets its own handle
    // rather than being refused: the owner's own words are theirs to repeat.
    async create(input, actor) {
      await ensureTypes(deps.db);
      const base = keyFromName(input.name);
      // A key that was deleted keeps its tombstone, so it is taken too: the handle is never reused.
      const taken = new Set((await deps.db.query<{ key: string }>('SELECT key FROM business_types')).map((r) => r.key));
      let key = base;
      for (let n = 2; taken.has(key) && n < 100; n++) key = base.slice(0, 26) + '_' + n;
      const [made] = await deps.db.query<TypeRow>(
        `INSERT INTO business_types(key, name, template) VALUES ($1,$2,$3::jsonb) RETURNING key, name, template, updated_at`,
        [key, input.name.trim(), JSON.stringify(input.template)]);
      await audit(deps.db, { personId: actor.personId, action: 'business_type.added', target: key, after: { name: made.name }, ip: actor.ip });
      return toView(made);
    },

    // Editing the words never touches a business, an account or a payment: a type is a row of words.
    async update(key, input, actor) {
      const before = await row(key);
      const [made] = await deps.db.query<TypeRow>(
        `UPDATE business_types SET name=$2, template=$3::jsonb, updated_at=now() WHERE key=$1 AND org_id=$4 RETURNING key, name, template, updated_at`,
        [key, input.name.trim(), JSON.stringify(input.template), requireOrg()]);
      await audit(deps.db, {
        personId: actor.personId, action: 'business_type.edited', target: key,
        before: { name: before.name, accountNoun: (before.template as { accountNoun?: string } | null)?.accountNoun ?? null },
        after: { name: made.name, accountNoun: input.template.accountNoun }, ip: actor.ip,
      });
      return toView(made);
    },

    // A type no business uses can go. One that names businesses cannot: their words would have
    // nothing behind them, and a business never reads from a row that is gone.
    async remove(key, actor) {
      const before = await row(key);
      const [used] = await deps.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM businesses b WHERE COALESCE(b.type_key, 'other') = $1`, [key]);
      if (Number(used.n) > 0) throw new HttpError(409, 'type_in_use', 'Businesses still use this kind. Change theirs first, then delete it.');
      await deps.db.query('UPDATE business_types SET deleted_at=now(), updated_at=now() WHERE key=$1 AND org_id=$2', [key, requireOrg()]);
      await audit(deps.db, { personId: actor.personId, action: 'business_type.deleted', target: key, before: { name: before.name }, ip: actor.ip });
    },
  };
}
