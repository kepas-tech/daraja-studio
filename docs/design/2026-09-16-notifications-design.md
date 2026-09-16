# Notifications inbox — design (feature 4 of the KEPAS Pay borrow list)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md`, priority item 4, and the order
brief. Date 2026-09-16, version 0.20.0. KEPAS Pay's shape: a bell with an unread count, a list with
filters and severity, dedupe with a count, and "Mark all read". Web push is phase 2 (feature 12) and
is not built here.

## What the owner gets

One place that says what happened while nobody was looking: money that went out and was received,
money that failed or has no answer yet, a send waiting for a second person, and an operator that
stopped working. Every line is a sentence, not a code. The bell shows how many are unread.

## Table

Migration `server/migrations/026_notifications.sql`, following 023/025's structure (idempotent DDL,
RLS, GRANT):

```sql
notifications(
  id uuid pk default gen_random_uuid(),
  org_id uuid not null default app_current_org() references orgs(id) on delete cascade,
  severity text not null check (severity in ('info','success','warning','critical')),
  category text not null,              -- money_out | money_in | approvals | operators | invoices
  type text not null,                  -- request.completed, request.failed, ... (the classifier's own key)
  title text not null,                 -- one short line for the list
  body text not null,                  -- the sentence, with the name and the receipt
  data jsonb not null default '{}',    -- { requestId } so the list can link to the row
  dedupe_key text not null,            -- what makes two of these the same event
  count int not null default 1,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

Indexes: `UNIQUE (org_id, dedupe_key)` (the dedupe), `(org_id, updated_at DESC)` for the list, and
`(org_id) WHERE read_at IS NULL` for the bell count.

A repeat of the same `dedupe_key` bumps `count`, refreshes `updated_at` and leaves `read_at` alone:
a line the owner has already read stays read, and the row moves to the top with "×2".

## Classifier — `server/src/notifications/classify.ts`

A pure function, so it is testable without a database:

```ts
type Classified = { severity: 'info'|'success'|'warning'|'critical'; category: string; type: string;
                    title: string; body: string; data: Record<string, unknown>; dedupeKey: string };
export function classify(e: { type: string; payload: unknown }): Classified | null
```

| Event | Line |
|---|---|
| `request.updated`, status `completed` | "Sent KES 300 to Joseph Ngumbao John. They received it." / money in: "Received KES 300 from Robert." |
| `request.updated`, status `failed` | "KES 300 to Joseph did not go out." + Safaricom's own words |
| `request.updated`, status `unknown` | "No answer from Safaricom for KES 300 to Joseph yet." |
| `request.updated`, status `awaiting_approval` | "KES 300 to Joseph is waiting for a second person." |
| `request.updated`, status `rejected` | "KES 300 to Joseph was refused." |
| `alert` kind `request_unknown` | same as the unknown line, so a swept row still speaks |
| `operator.updated`, status `failed` | "The operator stopped working. Sends will fail until it is fixed." (critical) |
| anything else | null — no notification |

The classifier cannot know a name or an amount from a payload that only carries an id, so the
service (`server/src/notifications/service.ts`) loads the request view for `request.updated` and
`alert` events before building the line; the payload's `status` only decides which line.

## Wiring

`server/src/notifications/writer.ts` subscribes to the event hub at boot (`server/src/index.ts`,
next to the existing hub start) and, for every event the classifier accepts, writes one row inside
the organisation the event names (`withOrg`, falling back to the current one). A failure inside the
writer logs one line and never breaks the hub, which is what the hub's subscriber contract already
promises. `server/test/notifications.test.ts` calls the writer directly — no hub, no timing.

## API — `server/src/notifications/routes.ts`, mounted at `/api/notifications`

| Method | Path | Gate | Answer |
|---|---|---|---|
| GET | `/` | session | `{ items: NotificationView[], unread: number, nextCursor: string \| null }`, newest first, `filter=unread\|all` (default all), `limit` up to 100 |
| GET | `/count` | session | `{ unread: number }` — what the bell polls once and then follows over SSE |
| POST | `/:id/read` | session + CSRF | 204 |
| POST | `/read-all` | session + CSRF | `{ read: number }` |

Any signed-in person may read and clear the inbox: it is the studio's own activity, and the plan
names no permission for it. Every write is idempotent (marking a read row read again changes
nothing).

## Web

- `web/src/app/Nav.tsx`: a bell entry next to Home, with the unread count as the existing badge,
  refreshed on `notification.created` over SSE and after "Mark all read".
- `web/src/pages/Notifications.tsx` at `/notifications`: filter All / Unread, a severity dot, the
  title, the sentence, when, and "×N" when a line repeated; press a line with a request link to open
  that payment; "Mark all read".
- Copy in `web/src/copy/en.ts` under `notifications`; the guard must pass.
- Guide: one task ("See what happened while you were away") and the machine route lines, then
  `pnpm -C web guide:md`.

## Tests

Server (`server/test/notifications.test.ts`, real PostgreSQL, no Safaricom):
1. The classifier turns a completed money-out event into a sentence with the name and the receipt,
   and returns null for an event it does not know.
2. A completed, a failed, an unknown, a held and a rejected request each write one line with the
   right severity.
3. The same event twice makes one row with `count = 2`, not two rows.
4. A read line that repeats stays read.
5. The list is newest first, `filter=unread` hides what was read, and the count matches.
6. `read-all` marks everything and answers how many.
7. No line carries Safaricom's raw JSON or a secret; the writer survives a row it cannot load.

Web (`web/src/test/notifications.test.tsx`): the bell shows the unread count; the page lists, marks
one read and marks all read; an unread-only filter hides a read line.

## Out of scope

- Web push (VAPID and a service worker): phase 2, the plan puts it after everything else.
- SMS or e-mail: phase 3, not asked for.
- Escalation of unread criticals: no second channel exists yet to escalate to.
