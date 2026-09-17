# Safaricom's charge per row — design (feature 11 of the KEPAS Pay borrow list)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md` section C (fee engine) and priority
item 11; the order brief. Date 2026-09-16, version 0.26.0. Display only: Studio adds no fee of its
own, so there is no margin and no profit anywhere in this feature.

## The bands are real, not invented

Read from KEPAS Pay's own `migrations/018_*_safaricom_fees.sql` on the VPS, which carries
Safaricom's published Customer Bouquet PayBill (C2B) and Disbursement (B2C) tariffs; B2B is
identical to B2C there and here.

| KES from | KES to | C2B charge | B2C charge | B2B charge |
|---|---|---|---|---|
| 1 | 49 | 0 | 0 | 0 |
| 50 | 100 | 0 | 0 | 0 |
| 101 | 500 | 5 | 7 | 7 |
| 501 | 1,000 | 10 | 13 | 13 |
| 1,001 | 1,500 | 15 | 23 | 23 |
| 1,501 | 2,500 | 20 | 33 | 33 |
| 2,501 | 3,500 | 25 | 56 | 56 |
| 3,501 | 5,000 | 34 | 57 | 57 |
| 5,001 | 7,500 | 45 | 70 | 70 |
| 7,501 | 10,000 | 55 | 90 | 90 |
| 10,001 | 15,000 | 70 | 110 | 110 |
| 15,001 | 20,000 | 90 | 130 | 130 |
| 20,001 | 25,000 | 100 | 150 | 150 |
| 25,001 | 35,000 | 120 | 175 | 175 |
| 35,001 | 50,000 | 150 | 200 | 200 |
| 50,001 | 70,000 | 180 | 250 | 250 |
| 70,001 | 150,000 | 250 | 330 | 330 |

Charges are whole shillings; the table stores cents (`charge_cents = 500` for KES 5) so it matches
every other amount in Studio. An amount above KES 150,000 has no band: Studio shows no charge
rather than guessing one.

## Table — migration `028_safaricom_fees.sql`

```sql
safaricom_fees(
  id uuid pk default gen_random_uuid(),
  org_id uuid not null default app_current_org() references orgs(id) on delete cascade,
  kind text not null check (kind in ('c2b','b2c','b2b')),
  min_cents bigint not null check (min_cents >= 0),
  max_cents bigint not null check (max_cents >= min_cents),
  charge_cents bigint not null check (charge_cents >= 0),
  updated_at timestamptz not null default now(),
  unique (org_id, kind, min_cents)
)
```

Seeded for the organisation with the 51 rows above (17 bands × 3 kinds) by an idempotent
`INSERT ... SELECT ... WHERE NOT EXISTS` per kind, so an owner who has edited the table never has
it overwritten on a later boot. RLS and the studio_app grant block follow 023/025.

Plus one column on requests: `charge_cents bigint` — what the row's band said when the row was
written, so an old row keeps the charge it was actually costed at.

## Lookup, and where it is written

`server/src/fees/service.ts`:

```ts
chargeFor(kind: 'c2b'|'b2c'|'b2b', amountCents: number): Promise<number | null>   // the band containing the amount
list(): Promise<FeeBandView[]>
replace(kind, bands, actor): Promise<FeeBandView[]>   // the owner's edit, whole kind at a time
```

- **Money out**: `moneyOut.send` stores `charge_cents` for the send's kind (`b2c`) inside the same
  INSERT it already does. No extra round trip: one lookup before the insert, which the service
  already has a transaction for.
- **Money in**: `recordC2b` stores the `c2b` band for the amount it just recorded, in the same
  INSERT.
- A row's charge is never recalculated on read: a tariff change does not rewrite history.

## API — `server/src/fees/routes.ts`, mounted at `/api/fees`

| Method | Path | Gate | Answer |
|---|---|---|---|
| GET | `/api/fees` | session + `lookup.view` | `{ items: FeeBandView[] }` grouped by kind |
| GET | `/api/fees/charge?kind=&amountCents=` | session + `lookup.view` | `{ chargeCents: number \| null }` — the send review's line |
| PUT | `/api/fees/:kind` | owner + step-up | the whole kind replaced from `{ bands: [{minCents, maxCents, chargeCents}] }`; refuses overlapping bands in plain English |

```ts
interface FeeBandView { id: string; kind: 'c2b'|'b2c'|'b2b'; minCents: number; maxCents: number; chargeCents: number; updatedAt: string }
```

Every write lands in `audit_log` (`fees.updated`) with the band count and the kind, never the whole
table.

## Where the owner sees a charge

- **Send money to a phone, review step**: "Safaricom's charge: KES 13, taken from Utility", using
  the same Utility account the review already names. When the amount has no band, the line says
  so instead of showing nothing.
- **History**: a "Safaricom's charge" column, blank for a row written before this feature and for a
  type with no band. `RequestView.chargeCents` carries it.
- **Settings › Charges** (new section, owner, step-up): the three kinds, each with its bands in a
  small table; edit a charge, add a band, remove one; Save replaces that kind. The section says
  where the numbers came from and when the owner last changed them.

## Tests

Server (`server/test/fees.test.ts`):
1. The seed leaves 17 bands per kind, in cents, with no gaps between them.
2. `chargeFor` returns the band's charge at a boundary (100, 101, 500, 501) and null above the top.
3. A send stores the b2c charge on its row; a C2B payment stores the c2b charge.
4. A later tariff change does not change an old row's charge.
5. `PUT /api/fees/:kind` replaces a kind, refuses overlapping bands and a non-owner, and writes one
   audit row.
6. A second boot does not overwrite an owner's edited bands.

Web (`web/src/test/fees.test.tsx`): the review shows the charge line (and the no-band line); the
History column shows the charge; Settings › Charges renders the bands and saves an edit.

## Out of scope

- A platform fee, a multiplier, or profit of any kind: Studio sells nothing.
- Recomputing historical charges: history keeps what it cost.
- Telco-wide tariffs for other networks: this studio sends M-Pesa only.
