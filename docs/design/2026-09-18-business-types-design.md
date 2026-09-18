# Business types — design (round 3, phase B)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md`, phase B. Date 2026-09-18, version
0.39.0. Phase A (names) is live at 0.38.0.

## The idea in one line

A business is not only a name and a code: a clinic, a church, a school and a landlord hold money in
different shapes. Studio asks which one it is, and the answer is a **row of data** — a template the
owner can edit — not code, so a new kind of business is a new row and needs no deploy.

## The template, and what each field means

`businesses.type_key` points at the organisation's own row in `business_types`. The row carries the
eight things the plan lists, as one JSON object:

| Field | Values | What it drives in this phase |
|---|---|---|
| `accountNoun` | a word the owner can edit | Accounts everywhere: "Add a tenant", "3 tenants", "No patients yet" |
| `subAccountNoun` | a word, or null | The level under an account: "Rooms or units under Jane", "Classes under …". Null hides the action |
| `regular` | `no`, `weekly`, `monthly`, `each_term` | The line the account carries ("Rent is expected every month"); phase C's arrears use it |
| `standingAmount` | `none`, `fixed`, `pledge` | Whether each account stands for a set amount — the rent, the fee, a pledge |
| `categories` | up to twelve words | The business's payment categories, shown on its card, and one press adds them to the studio's own send categories |
| `invoices`, `reminders` | `on`, `per_visit`, `each_term`, `off`; true/false | The Invoices screen says what this type does and defaults the reminder switch |
| `homeLead` | `behind`, `takings`, `giving`, `outstanding`, `nothing` | What Home leads with for this business |
| `statementNoun` | a word the owner can edit | What this business's statement is called: Reports' heading when the business is chosen |

**Words the owner types, modes they choose.** The three fields that are sentences — the account noun,
the sub-account noun, the statement noun — and the category names are free text, so a new kind of
business reads properly without a deploy. The four fields that are *behaviour* (regularity, standing
amount, invoices, what Home leads with) are chosen from a fixed set, because each one is wired to
something Studio does; the sentences around them live in `web/src/copy/en.ts`, which is where the
plan says the copy stays.

## The nine shipped types

Rental or property, clinic or health, church or religious, school, shop or retail, services or
freelance, savings group or chama, transport, and **other** — neutral words, nothing turned on. They
are seeded into every organisation (from `server/src/businesses/types.ts`, on the first read of the
list and for every organisation that has none), and each row is the owner's to edit.

## Tables — migration `server/migrations/035_business_types.sql`

```sql
business_types(
  id uuid pk, org_id uuid -> orgs, key text, name text, template jsonb,
  seeded_at, updated_at, unique (org_id, key)
)
businesses.type_key text   -- null reads as 'other'
```

The type is data: nothing in the money path reads it. Switching a business from one type to another
writes one column and one audit row — accounts, payments, invoices and numbers are untouched, which
is what "never loses a shilling of history" means here.

## Where it lands

- **The Businesses flow**: the add form asks the kind of business as its first step, and a
  "Change the type" action sits under every business afterwards.
- **Accounts**: the account and sub-account nouns, the count line, the "no accounts yet" line, the
  add buttons, and a line saying what the type expects (regular money, a standing amount).
- **Money in**: the unmatched card's words, from the business the payment is being labelled with.
- **Invoices**: what the type does with invoices and reminders, and the reminder switch's default.
- **Reports**: the statement noun for the business being looked at.
- **Home**: one leading line per the type — today's takings, this month's giving, who is behind, or
  fees outstanding — with the figures Home already reads.
- **The guide**: a section explaining the step and that the words follow the type.
