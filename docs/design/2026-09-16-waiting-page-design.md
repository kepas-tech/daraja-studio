# The Waiting page — design (feature 5 of the KEPAS Pay borrow list)

Source: `/Users/ADEA/.claude/plans/reflective-yawning-tome.md` section B ("Pending & held money
page") and priority item 5; the order brief. Date 2026-09-16, version 0.21.0.

## What the owner gets

One page for money that has not finished: sends waiting for a second person, sends Safaricom has
not answered yet, and sends Studio has given up checking. Each row says how long it has been
waiting, and carries the one action that helps: Release or Refuse, or "Check with Safaricom".

KEPAS Pay's "Pending & held" screen is the shape; its escrows, wallets and parked payouts stay out,
because Studio holds no customer money.

## Where the rows come from — the states that already exist

| Section | Rows | What the owner does |
|---|---|---|
| Waiting for a second person | `status = 'awaiting_approval'` | Release (password) or Refuse |
| Sent, waiting for Safaricom | `type` in the money kinds, `status in ('sent','pending')`, `checked_at is null` | Check with Safaricom, or Mark as checked |
| No answer yet | the same types, `status = 'unknown'`, `checked_at is null` | Check with Safaricom |

The sweep already moves a row through those states: it polls after two minutes, up to five times,
then writes `unknown` with "No answer from Safaricom after 5 checks." Nothing new is timed here;
this page only shows what the existing rules produced, so it can never disagree with them.

Age is `now() - coalesce(sent_at, created_at)`, shown as "3 minutes", "2 hours", "yesterday".
A row that was checked by a person (`checked_at` set) leaves the page, exactly as it leaves the
sweep.

## API — `server/src/money_out/routes.ts` (one new route beside the approvals ones)

```
GET /api/waiting        session + lookup.view
  { approvals: { items: RequestView[], canDecide: boolean },
    sent:      { items: RequestView[], count: number },
    noAnswer:  { items: RequestView[], count: number },
    badge: number }
GET /api/waiting/count  session  -> { badge: number }
```

- `approvals.items` is empty unless the caller holds `send.approve` (or is the owner):
  `canDecide` says which, so the page never shows a button that would be refused.
- `badge` = awaiting approval + no answer (the two that need a person). A row that is merely
  `sent` and two minutes old is not a badge.
- The existing `/api/approvals` routes stay exactly as they are: release and refuse keep their
  own gates, and the old count keeps working for anything still calling it.
- Limits: 100 rows per section, newest first; the page says when a section is cut off.

Nothing here writes anything. The only writes remain Release, Refuse, "Check with Safaricom"
(existing `POST /api/requests/:id/check`) and "Mark as checked".

## Web

- `web/src/pages/Approvals.tsx` becomes the three-section page; the route stays `/approvals` so no
  link or guide line breaks, and the nav entry is relabelled **Waiting** (key `approvals` stays).
- Each row: when, what, to, amount, status, **age**, and its action. The age is the point of the
  page, so it is a column, not a tooltip.
- The nav badge follows `/api/waiting/count` and refreshes on `request.updated` as today.
- Copy in `web/src/copy/en.ts` under `waiting`; the existing `approvals` strings stay where the
  release and refuse dialogs use them. Guide task updated in place, then `pnpm -C web guide:md`.

## Tests

Server (`server/test/waiting.test.ts`):
1. A `sent` row, an `unknown` row with no check, an `unknown` row already checked, and an
   `awaiting_approval` row are each in the right section and nowhere else.
2. A checked row leaves the page.
3. An operator (no `send.approve`) sees the two Safaricom sections and an empty approvals list with
   `canDecide: false`; an approver sees the held row with `canDecide: true`.
4. The badge counts held plus no-answer, and not the merely-sent.
5. A non-money row (a balance check) never appears.

Web (`web/src/test/waiting.test.tsx`): three sections render with their counts; the age shows; a
`sent` row offers "Check with Safaricom" and the held row offers Release; an operator sees no
Release button; the empty state.

## Out of scope

- Escrow, wallet and parked-payout rows: KEPAS Pay's wallet products, not built here.
- A "waiting to go out" total in shillings: that is item 9 and lands with the balance line.
