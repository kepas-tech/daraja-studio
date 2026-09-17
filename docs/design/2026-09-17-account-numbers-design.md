# Account numbers, made exact — design (brief 2, item 1)

Source: `/Users/ADEA/.claude/plans/account-numbers-and-followups.md` sections 1–4 (including the
owner's width rule in 1a), and `kepas-pay-borrow-brief-2.md`. Date 2026-09-17, version 0.29.0.
Replaces feature 2's sequential customer numbers (`docs/design/2026-09-16-businesses-customers-design.md`).

## The idea in one line

Three levels, digits only, every digit chosen by Studio, and the length of a number written into the
number itself: `000` (business), `000359` (customer), `000359123` (an account under that customer).
Because the width is part of the digits, what a payer typed can never be read two ways.

## Width is written into the number — the owner's rule

A leading 9 means "one digit longer than the base".

| Width | Shape | Range | Count |
|---|---|---|---|
| 3 | `ddd`, first digit 0–8 | `000`–`899` | 900 |
| 4 | `9ddd` | `9000`–`9899` | 900 |
| 5 | `99ddd` | `99000`–`99899` | 900 |
| n | `n-3` nines, then a first digit 0–8 and two digits | | 900 each |

Reading is exact and needs no table: count the leading 9s, take 3 + that many digits. That is also
why the digit after the nines must be 0–8 — a minted number never begins with a 9 at its own base
position, so the reader always stops at the right place. The cost is the digit 9 (10 % of each
range); the gain is that a payer's digits always route to exactly one account. Both the customer and
the sub-account level use the same rule, and `CHECK (number ~ '^9*[0-8][0-9]{2}$')` holds it in the
database.

## Tables — migration `server/migrations/030_accounts.sql`

```sql
accounts(                                  -- renamed in place from customers
  id uuid pk, org_id uuid, business_id uuid -> businesses,
  parent_id uuid null -> accounts(id),     -- null = a customer account; set = an account under one
  number text not null,                    -- this level's digits only; its width is in them
  full_number text not null,               -- business code + parent number + own number
  name, phone, note, created_by, created_at, updated_at,
  retired_at timestamptz,                  -- "delete" in the UI means retire
  unique (org_id, full_number),
  unique (business_id, number) where parent_id is null,
  unique (business_id, parent_id, number) where parent_id is not null
)

number_widths(                             -- one row per width a scope has opened
  id uuid pk, org_id uuid, scope_kind 'customers'|'sub_accounts', scope_id uuid,
  width int, capacity int default 900, used int default 0, opened_at, closed_at,
  unique (org_id, scope_kind, scope_id, width)
)
```

- Both unique indexes cover live **and** retired rows: a retired number is out of circulation for
  ever and is never reissued. It also still counts as used, so a width never reopens.
- `full_number` cannot be a Postgres generated column (it reads two other rows), so a
  `BEFORE INSERT OR UPDATE` trigger fills it and enforces what must hold even for a direct SQL
  insert: the parent is in the same business, a parent is itself a customer account (depth ≤ 1),
  the whole number is at most 12 digits, and an UPDATE may not change `number`, `parent_id` or
  `business_id` — a number is never edited and never re-pointed.
- The scope of a width is a business for customer numbers, and a customer account for the accounts
  under it. That is why `scope_id` is a plain uuid rather than a foreign key.
- `requests.customer_id` is renamed to `requests.account_id` (either level); `business_id` stays.

## Minting — `server/src/businesses/service.ts`

Under `pg_advisory_xact_lock(hashtext('accounts:' || scope_id))`, in one transaction with the INSERT:

1. Read the open width row for the scope. None open means width 3, or the next width after the
   closed ones.
2. Reconcile its counter with the rows themselves: `used` is the number of accounts of that width
   in that scope, live and retired. A row written by a restore or a hand-run script still counts.
3. While `used < 900`, draw `rng(900)`, render it as the last three digits (always 000–899, so the
   first is 0–8), put the width's nines in front, and insert with `ON CONFLICT DO NOTHING`. A clash
   retries, at most 20 times, and never aborts the caller's transaction.
4. At 900 used — or after 20 clashes — close the row, open the next width, and refuse when
   `3 + parent width + width > 12`, which is Daraja's `AccountReference` limit.
5. A width that grew writes an audit row `accounts.width_grew` and publishes an event; the writer
   beside the notification writer turns it into the owner's line, "Customer numbers for Shop now
   have 4 digits." Both happen outside the mint's transaction.

The draw is injected (`rng`), so tests pin the number a run produces. The default is `crypto.randomInt`.

Business codes stay sequential and are just as much Studio's: the next free code, lowest first,
chosen under `pg_advisory_xact_lock(hashtext('businesses'))` in the same transaction as the insert.
No route takes a code from a client.

## Parsing what the payer typed — `server/src/businesses/match.ts`

| Step | Rule |
|---|---|
| 1 | Digits only. Anything else names no business; with one business the money still belongs to it. |
| 2 | With two or more businesses the first three digits must name a known code, or the row is Unmatched ("no business has this code"). No digits after the code is the business with no account, and is not Unmatched. |
| 3 | The rest is read by the self-describing rule: count the leading 9s, take 3 + that many digits as the customer. If digits remain, read the next level the same way as an account under that customer. Anything left over after that is Unmatched ("too many digits"). |
| 4 | A customer nobody holds → Unmatched "no account with this number"; a customer who holds no such account under them → Unmatched "no sub-account with this number under <name>". There is no "could be two accounts" case. |
| 5 | With one business, routing is off: the code-stripped form is read first (it is what Studio prints), then the whole reference, so a payer who typed only the account part still resolves. |
| 6 | Leading zeros are not tolerated: numbers are fixed width per level and system printed, so `0000359` is not `000359`. |

The business is stored on the row whenever the digits own one — including the no-account and no-sub
cases, where only the account is in doubt. The account id is stored only on exactly one reading.

## API — `/api/businesses` and `/api/accounts`

Writes keep `businesses.manage`. **No route accepts a number, and none accepts a business code**:
the business and account body schemas are `.strict()`, so a client that sends `code`, `number` or
`fullNumber` gets 400 `invalid`, and the old `POST /api/businesses/:id/customers/claim` is gone. A
business is created with a name; the code is the next free one, lowest first, chosen under an
advisory lock in the same transaction as the insert.

| Method | Path | Body | Answer |
|---|---|---|---|
| POST | `/api/businesses` | `{ name }` | 201, Studio gives the next free code |
| GET | `/api/businesses` | — | each business carries `numbers: { width, capacity, used }` |
| GET | `/api/businesses/:id/accounts` | `q?` | customers with their live accounts nested |
| POST | `/api/businesses/:id/accounts` | `{ name, phone?, note? }` | 201, Studio draws the number |
| POST | `/api/accounts/:id/children` | `{ name, phone?, note? }` | 201, an account under a customer |
| PUT | `/api/accounts/:id` | `{ name, phone?, note? }` | the words around the number only |
| DELETE | `/api/accounts/:id` | — | 204; retires it and everything under it |
| POST | `/api/businesses/assign/:requestId` | `{ businessId, accountId? }` | the one-click fix |

`GET /api/money-in/unmatched` gives each unsorted payment a reason — `no_business`, `no_account`,
`no_sub` (with the customer's name), `too_many` — and the known `businessId`. The fix is always an
assign: nothing is rerouted and no number is typed by a person. A `no_business` row somebody has
already given a business to leaves the list, because that question is answered.

## The four paths that carry the full number

Money out, Ask to pay, QR and Invoices each take an optional `accountId`. When it is sent, the
server checks the account is live and in this organisation, stores `business_id` + `account_id` on
the row, and — for Ask to pay, QR and invoices — uses the account's `full_number` as the payer
reference Safaricom sees, so the money that comes back sorts itself. With no `accountId` every path
behaves exactly as before. A bulk batch keeps its business label only: one account cannot stand for
many recipients.

## Web

- Businesses page: the width line under each business ("Customer numbers: 3 digits, 412 of 900
  used"), customers with the full number printed large and "Tell them to pay 123456, account
  000359", and under each customer "Accounts under Jane" with "Add an account" (name box only).
- One picker (`AccountPicker`) everywhere a payer is chosen: business, then customer, then one of
  its accounts when it has any. Ask to pay, QR and Invoices fill the reference with the full number
  and send the account id, which is what the server uses as the payer reference.
- Money out takes `accountId` on the API and labels the row with the account; the Send money form
  itself keeps its business question and does not offer the picker yet.
- Money in: the four reasons, each with the same fix — pick an account, or add the customer and let
  Studio label the payment with the new account.
- History, Reports and Waiting take `accountId`; naming a customer includes the accounts under it.
  History shows the filter as the chip the account link opens.
- Copy in `web/src/copy/en.ts`; guide task "How account numbers work"; `pnpm -C web guide:md`.

## Tests

Server: the self-describing read on its own; the split with one hit, no hit, no sub and too many
digits; the owner's three examples; one-business routing off including the two-reading case; the
database refusing a changed number, a bad shape and a cross-business parent; the random draw with an
injected RNG; **every number minted at widths 3 to 6 reading back to itself**; width growth only at
900 used, with its audit row and its notification; retire never reissuing and still counting; the
12-digit cap; a client-supplied number refused with 400; and each of the four paths storing the
account and carrying `000359`-shaped references. Web: the page's width line and account tree, the
three-level picker, and the unmatched card's reasons.

## Out of scope, and why

- A per-customer width line for the accounts under a customer: the tracker exists per scope and the
  page shows it per business; the sentence under a customer would say the same thing at one more level.
- Re-pointing a payment from one account to another: an assign labels a row the payer's own number
  could not sort; it never moves money between accounts.
- Reports grouped per sub-account: the report narrows to one account; its per-business table stays.
## Item 1b — the words, and what "delete" means (2026-09-17, second change)

**Words.** Level 2 is an account, not a customer: it can be a clinic, a church, a room, a tenant.
Level 3 is a sub-account. The page title is Accounts, the buttons are Add an account and Add a
sub-account, the name box asks "What is this account for?"; the API is `/api/accounts` and
`/api/accounts/:id/sub-accounts`; the tracker's scope kind is `accounts`; the tracker line reads
"Account numbers: 3 digits, 412 of 900 used"; and the notification says "Account numbers for Shop
now have 4 digits." The prose that meant the person paying ("the customer scans this…") now says
payer or they, so the word does not survive anywhere the owner's rule covers.

**Delete means delete.** `accounts.retired_at` is gone: a delete removes the row and, with it, every
sub-account under it. The numbers return to the free pool of their width, and the tracker row for a
scope is dropped so the next mint opens the width it needs. `number_history` keeps one row per
deleted thing — business code, full number, level, name, phone, created and deleted dates, who did
it — and nothing else about it is kept.

| Where the record shows | How |
|---|---|
| An old money row | The digits are on the row for ever; a lateral join on `number_history` by full number gives "was <name>, deleted <date>". |
| A number handed out again | The account view (and the money row it labels) explains "This number belonged to <name> until <date>" for twelve months after the reissue. |
| "Past holders of this number" | `GET /api/accounts/:id/history` lists every holder, newest first. |

**Minting draws from the lowest width with a free number.** The live count decides, not a counter:
a width is skipped while 900 rows hold it (and marked closed at that moment), and a width that has a
free number again is reopened. Growth — the owner's notification and the audit row — is a width that
never existed before and is longer than the base, so the first width and a reopened one are not
"growth". The 12-digit cap and the advisory lock are unchanged.

**Deleting asks twice.** The route requires the exact name in the body (`400 name_mismatch` when it
does not match) behind `requireStepUp`, which wants the account password (or the PIN once item 3
lands); the page asks for both in the dialog the studio's own delete already used. A wrong name or a
wrong password writes nothing, proven by a test that counts the rows afterwards.

**Tests** (`server/test/businesses.test.ts`, 37 tests): the words in the parser; the delete that frees
a number and hands the same digits out again; the lowest free width first, with a real closed width
reopening; the history row per deleted row with the level and the deleter and no phone; the business
delete refused while accounts remain, and its code free after; the twelve-month "belonged to" line on
the account and on an old money row; "Past holders"; and both refusals (name and password) leaving
everything in place. Web: the page's Accounts/Sub-accounts wording, the delete dialog that sends the
name and the password and refuses a partial name, and the unmatched card's renamed field.
