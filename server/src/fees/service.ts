import type { Db } from '../db/pool.js';
import { currentOrgId } from '../db/pool.js';
import { audit } from '../audit/log.js';
import { HttpError } from '../util/errors.js';

/** Which direction a band prices. C2B is money in; B2C and B2B are money out. */
export type FeeKind = 'c2b' | 'b2c' | 'b2b';
export const FEE_KINDS: readonly FeeKind[] = ['c2b', 'b2c', 'b2b'];

export interface FeeBand { minCents: number; maxCents: number; chargeCents: number }
export interface FeeBandView extends FeeBand { id: string; kind: FeeKind; updatedAt: string }
export interface FeeActor { personId: string | null; ip: string }

export interface FeesService {
  /** The band containing this amount, or null when no band covers it. Never guesses. */
  chargeFor(kind: FeeKind, amountCents: number): Promise<number | null>;
  list(): Promise<FeeBandView[]>;
  /** The owner's correction: one kind's bands, replaced whole. */
  replace(kind: FeeKind, bands: FeeBand[], actor: FeeActor): Promise<FeeBandView[]>;
}

/**
 * Safaricom's published Customer Bouquet PayBill (C2B) and Disbursement (B2C) tariffs; B2B is the
 * same as B2C. Read off KEPAS Pay's own migrations/018_safaricom_fees.sql on the VPS, and written
 * out in docs/design/2026-09-16-safaricom-charges-design.md. Whole shillings, kept in cents.
 *
 * This is the copy used for an organisation created after migration 028 ran; the migration seeds
 * the same numbers for organisations that already existed, and server/test/fees.test.ts fails if
 * the two ever drift apart. An amount above the last band has no charge: Studio shows nothing
 * rather than guessing a figure the owner would take as real.
 */
export const C2B_BANDS: readonly FeeBand[] = [
  { minCents: 100, maxCents: 4900, chargeCents: 0 },
  { minCents: 5000, maxCents: 10000, chargeCents: 0 },
  { minCents: 10100, maxCents: 50000, chargeCents: 500 },
  { minCents: 50100, maxCents: 100000, chargeCents: 1000 },
  { minCents: 100100, maxCents: 150000, chargeCents: 1500 },
  { minCents: 150100, maxCents: 250000, chargeCents: 2000 },
  { minCents: 250100, maxCents: 350000, chargeCents: 2500 },
  { minCents: 350100, maxCents: 500000, chargeCents: 3400 },
  { minCents: 500100, maxCents: 750000, chargeCents: 4500 },
  { minCents: 750100, maxCents: 1000000, chargeCents: 5500 },
  { minCents: 1000100, maxCents: 1500000, chargeCents: 7000 },
  { minCents: 1500100, maxCents: 2000000, chargeCents: 9000 },
  { minCents: 2000100, maxCents: 2500000, chargeCents: 10000 },
  { minCents: 2500100, maxCents: 3500000, chargeCents: 12000 },
  { minCents: 3500100, maxCents: 5000000, chargeCents: 15000 },
  { minCents: 5000100, maxCents: 7000000, chargeCents: 18000 },
  { minCents: 7000100, maxCents: 15000000, chargeCents: 25000 },
];

/** The Disbursement tariff, which is also the Business PayBill tariff. */
export const B2C_BANDS: readonly FeeBand[] = [
  { minCents: 100, maxCents: 4900, chargeCents: 0 },
  { minCents: 5000, maxCents: 10000, chargeCents: 0 },
  { minCents: 10100, maxCents: 50000, chargeCents: 700 },
  { minCents: 50100, maxCents: 100000, chargeCents: 1300 },
  { minCents: 100100, maxCents: 150000, chargeCents: 2300 },
  { minCents: 150100, maxCents: 250000, chargeCents: 3300 },
  { minCents: 250100, maxCents: 350000, chargeCents: 5600 },
  { minCents: 350100, maxCents: 500000, chargeCents: 5700 },
  { minCents: 500100, maxCents: 750000, chargeCents: 7000 },
  { minCents: 750100, maxCents: 1000000, chargeCents: 9000 },
  { minCents: 1000100, maxCents: 1500000, chargeCents: 11000 },
  { minCents: 1500100, maxCents: 2000000, chargeCents: 13000 },
  { minCents: 2000100, maxCents: 2500000, chargeCents: 15000 },
  { minCents: 2500100, maxCents: 3500000, chargeCents: 17500 },
  { minCents: 3500100, maxCents: 5000000, chargeCents: 20000 },
  { minCents: 5000100, maxCents: 7000000, chargeCents: 25000 },
  { minCents: 7000100, maxCents: 15000000, chargeCents: 33000 },
];

/** One list per kind: C2B is the PayBill tariff, B2C and B2B the Disbursement one. */
export const DEFAULT_BANDS: Record<FeeKind, readonly FeeBand[]> = { c2b: C2B_BANDS, b2c: B2C_BANDS, b2b: B2C_BANDS };

const BAND_LIMIT = 60;
const MAX_CENTS = 1_000_000_000;
const wholeShillings = (c: number) => Number.isInteger(c) && c % 100 === 0;

interface FeeRow { id: string; kind: FeeKind; min_cents: string; max_cents: string; charge_cents: string; updated_at: Date }

const toView = (r: FeeRow): FeeBandView => ({
  id: r.id, kind: r.kind,
  minCents: Number(r.min_cents), maxCents: Number(r.max_cents), chargeCents: Number(r.charge_cents),
  updatedAt: r.updated_at.toISOString(),
});

/**
 * Feature 11. One row per band, per organisation. Rows run inside the caller's organisation
 * (orgContext on a request, the callback's own context for a C2B payment) and the explicit org
 * predicate is the stores' own defence in depth, the convention settings/store.ts follows.
 */
export function createFeesService(deps: { db: Db }): FeesService {
  const orgId = () => currentOrgId();
  const SELECT = 'SELECT id, kind, min_cents, max_cents, charge_cents, updated_at FROM safaricom_fees';

  /**
   * An organisation created after migration 028 has no bands. Seed one kind from DEFAULT_BANDS the
   * first time it is needed — never when the kind already has rows, so an owner's edit is never
   * overwritten, and a normal lookup pays for nothing but the existence check it already ran.
   * Returns true only when it wrote something.
   */
  async function ensure(kind: FeeKind): Promise<boolean> {
    const org = orgId();
    if (!org) return false;
    const [any] = await deps.db.query('SELECT 1 AS one FROM safaricom_fees WHERE org_id = $1 AND kind = $2 LIMIT 1', [org, kind]);
    if (any) return false;
    await deps.db.query(
      `INSERT INTO safaricom_fees(org_id, kind, min_cents, max_cents, charge_cents)
       SELECT $1, $2, v.min_cents, v.max_cents, v.charge_cents
         FROM unnest($3::bigint[], $4::bigint[], $5::bigint[]) AS v(min_cents, max_cents, charge_cents)
       ON CONFLICT (org_id, kind, min_cents) DO NOTHING`,
      [org, kind, DEFAULT_BANDS[kind].map((b) => b.minCents), DEFAULT_BANDS[kind].map((b) => b.maxCents), DEFAULT_BANDS[kind].map((b) => b.chargeCents)],
    );
    return true;
  }

  return {
    async chargeFor(kind, amountCents) {
      if (!Number.isFinite(amountCents) || amountCents <= 0) return null;
      const org = orgId();
      if (!org) return null;
      const read = () => deps.db.query<{ charge_cents: string }>(
        `${SELECT} WHERE org_id = $1 AND kind = $2 AND $3::bigint BETWEEN min_cents AND max_cents`, [org, kind, amountCents]);
      let row = (await read())[0];
      // A miss may only mean this organisation has no bands yet; seed once and read again. A miss
      // after a seeding, or with bands already in place, is a real "no band covers this amount".
      if (!row && await ensure(kind)) row = (await read())[0];
      return row ? Number(row.charge_cents) : null;
    },

    async list() {
      for (const kind of FEE_KINDS) await ensure(kind);
      const rows = await deps.db.query<FeeRow>(`${SELECT} WHERE org_id = $1 ORDER BY kind ASC, min_cents ASC`, [orgId()]);
      return rows.map(toView);
    },

    async replace(kind, bands, actor) {
      const org = orgId();
      if (!org) throw new HttpError(400, 'no_organisation', 'There is no organisation in scope.');
      if (!Array.isArray(bands) || bands.length === 0) throw new HttpError(400, 'invalid_bands', 'Keep at least one band.');
      if (bands.length > BAND_LIMIT) throw new HttpError(400, 'invalid_bands', `Keep to ${BAND_LIMIT} bands or fewer.`);
      for (const b of bands) {
        if (![b.minCents, b.maxCents, b.chargeCents].every((c) => Number.isInteger(c) && c >= 0 && c <= MAX_CENTS)) {
          throw new HttpError(400, 'invalid_bands', 'Every amount must be a whole number of shillings, in cents, and not negative.');
        }
        if (b.maxCents < b.minCents) throw new HttpError(400, 'invalid_bands', 'A band cannot end before it starts.');
        if (!wholeShillings(b.minCents) || !wholeShillings(b.maxCents) || !wholeShillings(b.chargeCents)) {
          throw new HttpError(400, 'invalid_bands', 'Safaricom’s bands and charges are whole shillings. Remove the cents.');
        }
      }
      const sorted = [...bands].sort((a, b) => a.minCents - b.minCents);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].minCents <= sorted[i - 1].maxCents) {
          throw new HttpError(400, 'invalid_bands', 'Two bands cover the same amount. Check the From and To columns.');
        }
      }
      await deps.db.tx(async (c) => {
        await c.query('DELETE FROM safaricom_fees WHERE org_id = $1 AND kind = $2', [org, kind]);
        for (const b of sorted) {
          await c.query(
            'INSERT INTO safaricom_fees(org_id, kind, min_cents, max_cents, charge_cents) VALUES ($1,$2,$3,$4,$5)',
            [org, kind, b.minCents, b.maxCents, b.chargeCents]);
        }
      });
      // The count and the kind, never the whole table: the audit log is a record of who changed
      // what, not a second copy of the tariff.
      await audit(deps.db, { personId: actor.personId, action: 'fees.updated', target: kind, after: { kind, bands: sorted.length }, ip: actor.ip });
      const rows = await deps.db.query<FeeRow>(`${SELECT} WHERE org_id = $1 AND kind = $2 ORDER BY min_cents ASC`, [org, kind]);
      return rows.map(toView);
    },
  };
}
