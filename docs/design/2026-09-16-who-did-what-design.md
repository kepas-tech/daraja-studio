# Who did what — design (feature 10 of the KEPAS Pay borrow list)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md` section D (audit log page) and
priority item 10; the order brief. Date 2026-09-16, version 0.25.0.

## What the owner gets

One page that answers "who changed that, and when": every action Studio already records in
`audit_log`, newest first, with the person, the action, what it was done to, the before and after
values, and the address it came from. Filters: a person, an action, a date range, and free text.

The table is already there and append-only (`audit_log_no_update` refuses any UPDATE or DELETE).
Nothing in this feature writes, changes or removes a row — it is a window on what exists.

## API — `server/src/audit/routes.ts`, mounted at `/api/audit`

Owner only, the same gate `/api/people` uses: this is who did what to the owner's money settings,
and the plan puts it under Organisation. A non-owner gets the usual 403.

| Method | Path | Query | Answer |
|---|---|---|---|
| GET | `/api/audit` | `personId`, `action`, `from`, `to`, `q`, `limit` (max 100, default 25), `cursor` | `{ items: AuditRow[], nextCursor: string \| null }` |
| GET | `/api/audit/actions` | — | `{ items: string[] }` — the distinct actions, for the filter |

```ts
interface AuditRow {
  id: string; at: string;                     // ISO
  action: string;
  person: { id: string; displayName: string } | null;   // null for a row nobody signed
  target: string | null;
  before: unknown; after: unknown;            // the stored JSON, or null
  ip: string | null;
}
```

- Newest first by `(at DESC, id DESC)` with a keyset cursor built the same way `reads.ts` builds
  its own (a microsecond-exact text rendering plus the id), so two rows in the same millisecond
  still page in a stable order and a hostile cursor is a 400, never a 500.
- `q` searches `action`, `target` and the two JSON columns cast to text, with LIKE
  metacharacters escaped so a typed `%` searches for a percent sign.
- Days are Nairobi days, like every other list.
- `actions` is one `SELECT DISTINCT` over the organisation's rows.

## Web

- `web/src/pages/WhoDidWhat.tsx` at `/who-did-what`, nav entry under Manage, label **Who did what**.
  Not linked from anywhere else, and hidden for anybody who is not the owner: the page asks the API
  and shows the 403 as the explained error card if it somehow gets there.
- Filters: person (from `/api/people`), action (from `/api/audit/actions`), from and to dates, and
  one search box. A row shows when, who, what, and the target; opening a row shows the before and
  after JSON and the address.
- Copy in `web/src/copy/en.ts` under `whoDidWhat`; guide task "See who changed what".
- Paging uses the same Previous/Next stack History uses.

## Tests

Server (`server/test/audit-page.test.ts`):
1. Owner reads rows newest first; a non-owner is refused.
2. The person, action and date filters each narrow the list, and `q` finds a target by text.
3. A typed `%` searches for a percent sign, not as a wildcard.
4. Paging: `limit` is honoured and the cursor walks the list without skipping or repeating, even
   for rows written in the same millisecond.
5. A hostile or malformed cursor is 400.
6. `actions` lists each action once.
7. A row with no person shows `person: null`, and the JSON comes back as stored.

Web (`web/src/test/who-did-what.test.tsx`): the table renders person, action and target; the
filters re-ask with the right query; opening a row shows before and after; a refusal shows the
explained error.

## Out of scope

- Exporting the audit log: History, Invoices and Reports have that; the plan does not ask for it
  here. Say the word and it is the same one-route pattern.
- Retention or pruning: the plan keeps the rows (spec 4.4), and the table is append-only by trigger.
