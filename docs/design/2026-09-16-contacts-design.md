# Contacts — design (feature 1 of the KEPAS Pay borrow list)

Owner decision source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md`, priority item 1,
and the order brief `kepas-pay-borrow-brief-for-dsh.md`. Date 2026-09-16. Version 0.17.0.

## What the owner gets

A saved address book for the people and businesses this studio pays: a name, and either a phone
number, a till number, or a paybill number with an account reference. Send money to a phone and
Bulk send can pick from it, so a repeat payment is a name, not a number to retype and mistype.

KEPAS Pay's shape is kept (kind tabs, Pay / Edit / Delete per row, bulk pick with an amount each).
The hub layer is dropped: no app, no wallet, no code the operator has to remember.

## Table

Migration `server/migrations/024_contacts.sql`, following 023's structure (RLS, GRANT, idempotent
DDL):

```sql
contacts(
  id uuid pk default gen_random_uuid(),
  org_id uuid not null default app_current_org() references orgs(id) on delete cascade,
  kind text not null check (kind in ('phone','till','paybill')),
  name text not null,                       -- 1..80 after btrim, checked in SQL
  phone text,                               -- kind = 'phone', stored 2547XXXXXXXX (normalizePhone)
  shortcode text,                           -- kind = 'till' | 'paybill', 5..7 digits
  account_reference text,                   -- kind = 'paybill', optional, 1..20 alphanumeric
  note text,                                -- optional, 200 max
  created_by uuid references people(id),
  created_at, updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (shape per kind, below)
)
```

Shape check, the KEPAS Pay migration 015 idea as SQL (the database is the last line, not the only
one):

| kind | phone | shortcode | account_reference |
|---|---|---|---|
| phone | required | null | null |
| till | null | required | null |
| paybill | null | required | optional |

Indexes: unique live name per organisation (`lower(name)` where `deleted_at is null`) so a
duplicate is a plain 409 instead of two rows nobody can tell apart; a live `(org_id, kind)` index
for the tabs.

Plus, in the same migration:

```sql
alter table requests add column if not exists contact_id uuid references contacts(id) on delete set null;
create index if not exists requests_contact_idx on requests(contact_id) where contact_id is not null;
```

Deleting a contact is soft (`deleted_at = now()`): History keeps the name it was paid under. The
unique index is partial, so a retired name can be used again.

## Permission

`contacts.manage` joins `server/src/permissions/catalog.ts` (label "Can keep the contact list",
Safaricom role: null). It is **not** added to the operator, viewer or approver presets: changing
where money goes is the owner's job, and a custom role can still grant it.

Reading the list needs no permission beyond a session, because the Send and Bulk pickers must work
for whoever may send. This is a deliberate reading of the brief's "permission contacts.manage":
writes are gated, reads are not. Say so in the report.

## API — `server/src/contacts/routes.ts`, mounted at `/api/contacts`

All JSON; errors are the usual `HttpError(code, plain line)`; every write writes an
`audit_log` row (`contact.added`, `contact.edited`, `contact.deleted`).

| Method | Path | Gate | Body / query | Answer |
|---|---|---|---|---|
| GET | `/api/contacts` | session | `kind?`, `q?` (name contains, case-insensitive) | `{ items: ContactView[] }` by name |
| POST | `/api/contacts` | `contacts.manage` | `{ kind, name, phone?, shortcode?, accountReference?, note? }` | 201 `ContactView` |
| PUT | `/api/contacts/:id` | `contacts.manage` | same body as POST (full replace) | `ContactView` |
| DELETE | `/api/contacts/:id` | `contacts.manage` | — | 204 |

```ts
interface ContactView {
  id: string; kind: 'phone' | 'till' | 'paybill';
  name: string; phone: string | null; shortcode: string | null;
  accountReference: string | null; note: string | null; createdAt: string;
}
```

Validation: `name` 1..80 after trim; `phone` through `normalizePhone` (SDK) so `0712 345 678`
is stored `254712345678`; `shortcode` `^[0-9]{5,7}$`; `accountReference` `^[A-Za-z0-9]{1,20}$`;
`note` 200 max. A field that does not belong to the kind (a phone on a till, an account on a
phone) is a 400, never silently dropped — the SQL check would refuse it anyway. A duplicate live
name is 409 `name_taken`, "You already have a contact called <name>."

## Send money to a phone

`POST /api/send/phone` takes an optional `contactId` (uuid). In `MoneyOutService.send`:

- load the contact inside the caller's organisation, live, `kind = 'phone'`; missing → 400
  `unknown_contact` ("That saved contact is gone. Pick them again.").
- `normalizePhone(contact.phone) !== phone` → 400 `contact_mismatch` ("That number is not the
  one saved for this contact. Pick the contact again, or send without it."). The operator's own
  review screen always shows the number that will be dialled, and the row stores the same one.
- the insert stores `contact_id`.

`reads.ts` adds `left join contacts ct on ct.id = r.contact_id` and exposes
`contactName: string | null` in `RequestView` (the plan's "History shows the name"). The
Safaricom-returned `recipient.name` is untouched — the saved name is the owner's own label and is
shown beside it.

## Bulk send

`bulk.create` resolves every parsed row's phone against the organisation's live phone contacts
(one `= ANY($1)` query) and passes the match into `moneyOut.send` as the row's `contactId`, so
bulk rows carry the same `contact_id`. This changes no money behaviour: the phone already decided
the destination.

The Bulk page gets "Pick saved contacts": tick contacts, type an amount for each, and the page
appends `phone, amount, name` lines to the list. The check and send paths are unchanged.

## Web

- `web/src/pages/Contacts.tsx` at `/contacts`, nav entry `{ key: 'contacts', label: 'Contacts',
  icon: 'account', group: 'out', phase: 5, available: true }` (no Safaricom name: it is ours).
- Tabs Phone / Till / Paybill. Add form per tab. Row: name, number (formatted) or shortcode +
  account, note, and Pay / Edit / Delete. Pay on a phone row opens `/send/phone?contact=<id>`;
  Pay on a till or paybill row is not shown yet, with one plain line saying those send types are
  not built (they are the planned send types in MENU-PLAN.md).
- Send money to a phone: a "Pick a saved contact" select (only live phone contacts) that fills the
  number and remembers the id; typing a different number clears the id. `?contact=<id>` prefills
  both.
- Bulk: the picker above.
- History: show `contactName` beside the number, falling back to the Safaricom name.
- All strings in `web/src/copy/en.ts` under `contacts`, `send.phone.fromContacts`,
  `bulk.fromContacts`; plain English, checked with `node ~/.dsh/ai-style/guard.mjs`.
- Guide: one new task in `web/src/copy/guide.ts` ("Keep a list of people you pay"), then
  `pnpm -C web guide:md`.

## Tests

Server (`server/test/contacts.test.ts`, real PostgreSQL, fake Safaricom, no real money):

1. SQL shape: the database itself refuses a phone contact with a shortcode and a blank name.
2. Create a phone contact from `0712 345 678`; the list shows `254712345678`.
3. Duplicate live name → 409; after a soft delete the same name is free again.
4. A person without `contacts.manage` may read the list and gets 403 on create, edit and delete.
5. Edit and soft delete: gone from the list, still on the row it was paid from.
6. Send with a matching `contactId` stores it, and `GET /api/requests/:id` shows `contactName`.
7. Send with a `contactId` whose number differs from the typed phone → 400 `contact_mismatch`,
   and no request row is written.
8. Send with an unknown or another organisation's `contactId` → 400 `unknown_contact`.
9. Bulk: a row whose phone matches a live contact stores that `contact_id`.

Web (`web/src/test/contacts.test.tsx`): the page lists the three tabs and an added contact; the
Send phone picker fills the number and the request carries `contactId`; History shows the saved
name.

## Out of scope, and why

- Paying a till or paybill contact: those send types are planned, not built (MENU-PLAN.md).
- Importing contacts from a file or a phone: not asked for.
- Contacts for invoices and QR account references: that is feature 2 (customers), which is where
  the account number belongs.
