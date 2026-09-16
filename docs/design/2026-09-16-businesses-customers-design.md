# Businesses and customers — design (feature 2 of the KEPAS Pay borrow list)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md` section E and priority item 2, and
the order brief `kepas-pay-borrow-brief-for-dsh.md`. Date 2026-09-16, version 0.18.0. Item 7
(account names) is replaced by this, exactly as the plan says.

## The idea in one line

One paybill, several businesses: the payer's account number starts with a three-digit business code
(`000`–`999`) followed by a customer number Studio minted for that business, so `000123` is
business `000`, customer `123`. One business only means routing is off and that one business owns
every row.

## Tables — migration `server/migrations/025_businesses_customers.sql`

```sql
businesses(
  id uuid pk default gen_random_uuid(),
  org_id uuid not null default app_current_org() references orgs(id) on delete cascade,
  code char(3) not null check (code ~ '^[0-9]{3}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  created_at, updated_at timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, lower(name))
)

customers(
  id uuid pk default gen_random_uuid(),
  org_id uuid not null default app_current_org() references orgs(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  number integer not null check (number >= 0),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  phone text check (phone is null or phone ~ '^254[0-9]{9}$'),
  note text check (note is null or char_length(note) <= 200),
  created_by uuid references people(id),
  created_at, updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (business_id, number)
)
```

- A business is switched off (`active = false`), never deleted: a code is never reused, so an old
  account number keeps meaning what it meant. The owner can rename and switch off; there is no
  delete button.
- A customer is retired (soft delete). Its `number` is never reused: the next number is
  `MAX(number) + 1` over live **and retired** rows.
- Indexes: `customers (org_id, business_id) where deleted_at is null`, plus RLS and the studio_app
  grant block copied from 023/024.
- Requests: `business_id uuid references businesses(id) on delete set null`,
  `customer_id uuid references customers(id) on delete set null`, one partial index each.
- Bulk plans: `bulk_plans.business_id uuid references businesses(id) on delete set null`.

## Numbers and codes

| Rule | Detail |
|---|---|
| Next business code | The lowest of `000`–`999` not used by this organisation (`generate_series`). The owner may name a code instead; a used one is 409. |
| Next customer number | `MAX(number) + 1` per business, starting at 0, under `pg_advisory_xact_lock(hashtext('customers:' || business_id))` in one transaction; the unique index is the backstop. |
| Display | `String(number).padStart(3, '0')` — `7` shows as `007`, `1000` shows as `1000`. Padding never grows past three. |
| Account number | business code + displayed customer number: `000` + `123` = `000123`; customer 1000 is `0001000`. |
| Width growth | Automatic: numbers 0–999 are three digits, then 1000 is four, because minting is sequential from 0. |

## Parsing a payment — `server/src/businesses/match.ts`

```ts
type AccountMatch =
  | { kind: 'none' }                                                    // no business exists yet
  | { kind: 'matched'; businessId: string; customerId: string | null }  // business known
  | { kind: 'unmatched' }                                               // two or more businesses, code not known or not digits
```

- No businesses at all: `none`. Nothing on the row changes (the feature is not in use).
- Exactly one business: routing is off. That business owns the row whatever the payer typed, and
  the reference is matched to a customer when it can be — the whole reference as a number (`123`),
  or with the business's own code in front of it (`000123`).
- Two or more: the first three characters must be digits naming a known business. What follows is
  read as one integer (`123`, `0123` and `00123` all mean customer 123). No digits after a known
  code is a payment to the business with no customer, which is not unmatched. A code nobody owns,
  or a reference that is not three digits plus digits, is `unmatched`.
- An inactive business still owns its rows: the money arrived whatever the owner did to the label.

`recordC2b` (`money_in/record.ts`) writes `business_id` and `customer_id` in the same INSERT and
on the Lipa na Bonga completion, inside the existing transaction. Nothing else about that path
changes: same receipt lock, same one row per receipt.

## API — `server/src/businesses/routes.ts`, mounted at `/api/businesses`

Reads need a session (the pickers must work for whoever may send). Writes take the new
`businesses.manage`, which is in no role preset. Every write writes an audit row.

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `/api/businesses` | — | `{ items: BusinessView[], lastUsedId: string \| null }`, ordered by code |
| POST | `/api/businesses` | `{ name, code? }` | 201 `BusinessView` |
| PUT | `/api/businesses/:id` | `{ name, active }` | `BusinessView` |
| GET | `/api/businesses/:id/customers` | `q?` | `{ items: CustomerView[] }` |
| POST | `/api/businesses/:id/customers` | `{ name, phone?, note? }` | 201 `CustomerView` (minted) |
| POST | `/api/businesses/:id/customers/claim` | `{ number, name, phone?, note? }` | 201 `CustomerView`; the number the payer typed; 409 if taken |
| PUT | `/api/customers/:id` | `{ name, phone?, note? }` | `CustomerView` |
| DELETE | `/api/customers/:id` | — | 204, retires the number |
| POST | `/api/businesses/assign/:requestId` | `{ businessId, customerId? }` | `RequestView`; the one-click fix |
| GET | `/api/businesses/summary` | `day?` (default today) | per business in/out cents |

```ts
interface BusinessView { id: string; code: string; name: string; active: boolean; customerCount: number; createdAt: string }
interface CustomerView { id: string; businessId: string; number: number; display: string; accountNumber: string; name: string; phone: string | null; note: string | null; createdAt: string }
```

`assign` refuses anything that is not a `c2b` row, never changes an amount, and records
`money_in.assigned` in the audit log.

Two response shapes are pinned exactly (agreed with the web page while both sides were built):

```ts
// GET /api/money-in/unmatched -> { items: UnmatchedPayment[] }
interface UnmatchedPayment {
  id: string; reason: 'no_business' | 'no_customer';
  amountCents: number | null; receipt: string | null;
  accountReference: string | null;              // exactly what the payer typed
  payerName: string | null; payerPhone: string | null;
  createdAt: string;
  business: { id: string; code: string; name: string } | null;   // set for no_customer
  customerNumber: number | null;                // set for no_customer: digits after the code
}

// GET /api/businesses/summary?day=YYYY-MM-DD ->
{ day: string; items: { businessId: string; code: string; name: string; inCents: number; outCents: number }[] }
```

## Money out

- `SendInput.businessId?` — loaded inside the caller's organisation and stored on the row; a
  send with an unknown or another organisation's business is refused before anything is written.
  On a successful insert the service sets `send.lastBusinessId`, which the pickers use as the
  default.
- `bulk.create(text, category, businessId?)` stores the choice on the plan; `drain` passes it to
  every row's send, so each row carries it.
- `reads.ts`: `RequestView.businessName` and `RequestView.customerName` ride the existing view
  joins; the list query takes `businessId` and `customerId` filters (History and Money in use
  them; Reports picks them up in feature 6).

## Money in — the three unmatched cases and their one-click fixes

`GET /api/money-in/unmatched` returns c2b rows that need a decision, each with a `reason`:

| reason | when | the fix on the page |
|---|---|---|
| `no_business` | two or more businesses, the reference names no known code | "Assign to a business" (and a customer, optional) |
| `no_customer` | a known business, digits after the code that no customer holds | "Create customer <n> in <business>" or "Assign to an existing customer" |

Both fixes call `POST /api/businesses/assign/:requestId`. No fix ever reroutes money: the row's
amount, receipt and status are untouched, and an audit row records who decided what.

## Web

- `/businesses` page (nav: Manage, key `businesses`, icon `document-report`): each business shows
  its code, name, whether it is switched on, and its customers. Add a business (the next free code
  offered), rename, switch off; add a customer (Studio shows the number and the account number to
  give the payer), edit, retire. One business shows the routing note: "Routing is off while you have
  one business. Every payment belongs to it. From the day you add a second, payers must start the
  account number with the code."
- Send money to a phone and Bulk send: a business dropdown, defaulting to the last one used.
- Ask a customer to pay, QR codes and Invoices: pick a customer and Studio fills the account
  reference with that customer's account number.
- Money in: an "Unmatched payments" card with the reason and the fix per row.
- History: a business filter; a customer can be filtered through `?customer=<id>` (the link Money
  in offers).
- Home: one line per business (in / out today) once there are two or more.
- Copy in `web/src/copy/en.ts` under `businesses`; guide task "Run more than one business on one
  number"; `pnpm -C web guide:md`.

## Tests

Server (`server/test/businesses.test.ts`, real PostgreSQL, fake Safaricom):

1. SQL shape: a two-digit code, a duplicate code in one organisation, and a duplicate customer
   number in one business are all refused by the database.
2. First business `000`, next `001`, an explicit free code accepted, a used code 409.
3. Customers mint 0, 1, 2 (shown `000`,`001`,`002`); the account number is `000000`, `000001`,
   `000002`; a retired number is not reused (mint continues after it).
4. A business with 1000 seeded customers mints `1000` next, shown `1000` (four digits), account
   `0001000`.
5. One business: an incoming `123` and an incoming `000123` both land on customer 123.
6. Two businesses: `001123` lands on business `001` and its customer 123; `999123` is unmatched;
   `12x` is unmatched; `001` alone is business 001 with no customer and is **not** unmatched.
7. The fixes: assign a business; claim customer 123 then assign; assign an existing customer. Each
   writes an audit row and leaves the amount and receipt alone.
8. A send with a `businessId` stores it and sets the last used; an unknown or foreign one is
   refused before any write.
9. Bulk with a business stores it on every row.
10. Summary counts in and out per business for the day.

Web (`web/src/test/businesses.test.tsx` and small additions): the page lists businesses and
customers with account numbers; the Send and Bulk dropdowns send `businessId`; the customer picker
fills the account reference; the Unmatched card offers the right fix per reason.

## Out of scope, and why

- Reports filters: Reports does not exist yet (feature 6); the query parameters are built here.
- A person limited to one business: the plan says later, optional, not in the first cut.
- Per-business balances: M-Pesa holds one pool; Home shows each business's own in/out as history,
  never as cash.
