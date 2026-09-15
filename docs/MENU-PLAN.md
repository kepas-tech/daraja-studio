# Menu plan and progress

**This file is the single source of truth for what Studio's menu promises and how much of it works.**
It is tracked in git and published, so any person, session or model can read it and know exactly
where the project stands without asking anyone.

Last updated 2026-09-16.

## The commitment

Every item in the menu ships. **Nothing is removed to make the list look finished.** An item either
works or is honestly labelled Coming soon until it does.

## The rule that keeps this file honest

**A slice is not done until its menu label stops saying Coming soon on https://darajastudio.com.**

The label is controlled by one flag, `available`, in `web/src/copy/en.ts`. That flag is the ground
truth; this table only records it. Flipping it is part of the feature's own commit, never a separate
tidy-up, and the work is not reported until it is deployed.

Anyone can verify the real state without trusting this file:

```
grep -A6 "key: 'stk'" web/src/copy/en.ts | grep available
```

If the table below ever disagrees with those flags, **the flags are right and the table is stale.**

## How to mark something done

All four steps belong to the same commit. Do not do any of them early.

1. The feature works against the fake Safaricom, with tests for the refused, timed-out,
   answered-twice and answered-after-we-gave-up paths.
2. Set `available: true` for that entry in `web/src/copy/en.ts`, and delete its route from the
   Coming soon fallback if it has a real page.
3. Update this file: set Status to `live` and put the commit and the deploy date in Evidence.
4. Gate green, commit, deploy the same day.

Status values are exactly `live`, `building`, or `planned`. One slice is `building` at a time.

## Where the project stands

| # | Menu item | key | Status | Slice | Evidence |
|---|---|---|---|---|---|
| 1 | Home | `home` | live | — | shipped before 0.4.0 |
| 2 | Balances | `balances` | live | — | shipped in 2A; merged into Home in 0.8.0 (no menu item, `/balances` opens Home) |
| 3 | Send money | `send` | live | 2A | phone sends only; other send types tracked below |
| 4 | Bulk send | `bulk` | planned | M5 | — |
| 5 | Look up a payment | `lookup` | live | — | shipped in 2A; merged into History in 0.8.0 (no menu item, `/lookup` opens History) |
| 6 | Reverse a payment | `reverse` | live | M3 | shipped 2026-09-14 |
| 7 | Money in | `money-in` | live | M2 | 0.9.0, deployed 2026-09-16 |
| 8 | Ask a customer to pay | `stk` | live | M1 | shipped 2026-09-14 |
| 9 | QR codes | `qr` | live | M6 | shipped 2026-09-14 |
| 10 | Invoices | `invoices` | planned | M7 | — |
| 11 | Standing orders | `standing-orders` | planned | M8 | — |
| 12 | Express checkout | `express` | planned | M9 | — |
| 13 | Bonga points | `bonga` | planned | M10 | — |
| 14 | Waiting for approval | `approvals` | planned | M4 | — |
| 15 | History | `history` | live | — | shipped in 2A |
| 16 | People | `people` | live | — | shipped in 3B |
| 17 | Settings | `settings` | live | — | shipped before 0.4.0 |
| 18 | Not possible via API | `not-possible` | live | — | 15 explanation cards |

**12 of 18 live (two of them folded into Home and History). 6 to build.** Each slice below removes exactly one Coming soon label.

## Send types inside Send money

These do not change the menu, because Send money is already live. They are real work and they are
tracked here so nobody assumes sending is finished.

| Send type | Daraja call | Status |
|---|---|---|
| To a phone | `b2c.send` | live |
| To a business wallet (pochi) | `b2c.toPochi` | planned |
| To a paybill or till | `b2b.pay` | planned |
| Move float, working to utility | `b2b.transferFloat` | planned |
| Top up another shortcode | `b2b.topUp` | planned |
| Pay tax to KRA | `b2b.remitTax` | planned |

The foundation they need is built: send types live one per file under `server/src/money_out/kinds/`
and are registered in one map, so each of these is a new file plus one line plus its tests.

## The slices, in order

Ordered by what a Kenyan business needs to operate, with cost as the tie-breaker. Each names the
Daraja call behind it, taken from `@kepas/daraja-js` 1.5.0, not from the label.

### M1 — Ask a customer to pay · `collect.stkPush`, `status.stkPush` — DONE 2026-09-14
The most-used M-Pesa flow in the country: the business asks, the customer's phone prompts, the money
arrives. Without it Studio can only push money out, never pull it in.

Delivers a page taking a phone number, an amount and a reference; a prompt on the customer's phone;
the result and receipt in History; and the status check for when no callback arrives.

What shipped: `POST /api/collect/stk` behind the `stk.request` permission; the kind in
`server/src/money_out/kinds/stk.ts` registered in `COLLECT_KINDS`, kept out of `MONEY_TYPES` so a
payment request never spends the monthly *send* allowance and is never polled with the wrong status
call; History reading `LEDGER_TYPES`, so both directions appear; and the page at `/ask-to-pay`.

Three rules hold here, each with the test that goes red without it: an accepted push with no
checkout reference is held rather than called sent (a blank reference can never be matched to a
callback, and asking again could charge the customer twice); a dropped connection or a 5xx is held
as unknown, never retried; and a synchronous rejection, which proves no prompt was shown, fails the
row with Safaricom's own words so it can safely be tried again. No step-up password, unlike every
send route — nothing leaves the organisation's accounts.

`status.stkPush` is not wired yet. The money-out sweep deliberately does not poll `stk`, so a held
row waits for its callback or for a human. That is the honest state, not an oversight, and it is the
first thing M2 should pick up.

### M2 — Money in · `c2b.registerUrls`, C2B confirmations, `pull.query` — DONE 2026-09-16
Customers paying the shortcode directly by paybill or till, without being asked. Registering the
confirmation address happens once per shortcode and must be idempotent and re-runnable, because
Safaricom silently keeps the first registration. `pull.query` backfills anything a missed
confirmation lost.

What shipped: `server/src/money_in/` (record, service, routes) and `callbacks/c2b.ts`; the Money
in page with Turn on (owner, step-up; registers the C2B addresses and the Pull address), Check
for missed payments, and the latest twenty; `c2b_pull` every hour; History's direction filter.
Every payment is accepted at validation (owner decision). One row per receipt whichever way it
arrived: an advisory lock on the receipt serialises a callback racing the check. `c2b` is in
`LEDGER_TYPES` only: never polled, never a send. Design: `docs/design/2026-09-16-planned-features-design.md`.

### M3 — Reverse a payment · `reversal.request` — DONE 2026-09-14
One call; the care is entirely in the rules. A reversal is irreversible, needs the receipt of a
settled payment, and must never be started twice for the same receipt.
`isSettledByRecipientSpend` decides whether Safaricom can still take it back.

The care landed where it belongs: a receipt that never settled is refused before any call, the
advisory lock is keyed on the receipt so two simultaneous presses produce one request, and a
refusal shows Safaricom's own words. Review found one real defect, fixed before the commit — a
reversal was counting against the monthly *send* allowance, which would have let a business issuing
refunds hit its cap and then be unable to pay a supplier. `MONEY_TYPES` was doing two jobs;
`BILLABLE_SEND_TYPES` now answers "what does the plan charge for" separately, and every kind must
declare `countsAsSend` rather than inherit a default.

Open follow-ups, neither a blocker: `RequestDetail` has no Reverse link, and `findSettledPayment`
binds `LEDGER_TYPES`, so a completed reversal is itself findable as a settled payment — safe only
because the duplicate guard refuses it first.

### M4 — Waiting for approval · ours, not Daraja's
A second person approves a send before it leaves, which is what makes Studio safe for a business with
staff. The `awaiting_approval` status already exists in the schema. Above a threshold set in
Settings, a send waits; an approver with a distinct permission releases or refuses it; the maker can
never approve their own. Enforced server side, not in the UI.

### M5 — Bulk send · ours, over the existing phone send
Payroll and supplier runs. A list is validated before anything is sent, then sent one at a time down
the same path a single send uses. Every row is an ordinary request row from the start, so a batch is
a grouping and never a special path that bypasses the duplicate guard or the send cap.

### M6 — QR codes · `qr.generate` — DONE 2026-09-14
A payload the customer scans to pay. Cheap, and genuinely useful at a counter or for a rider.

Synchronous, so no callback, sweep or payment row. The response handling is the part worth keeping:
the returned image is validated as a real PNG by magic bytes, header and IEND and bounded in size,
so a URL, HTML or SVG from upstream can never reach the page or a download.

### M7 — Invoices · `billManager.optIn`, `sendInvoice`, `cancelInvoice`, `acknowledgePayment`
Invoices your customers can pay. Several calls plus an opt-in lifecycle, so the first genuinely
large slice.

### M8 — Standing orders · `ratiba.create`
A recurring debit. The scheduling rules must be shown honestly, including what Daraja will not let
anyone change after creation.

### M9 — Express checkout · `express.checkout`
Business-to-business with a checkout experience. Narrow.

### M10 — Bonga points · `bonga.calculatePoints`, `bonga.redeem`
Loyalty points. Narrow, and last because few businesses need it to operate.

## Rules every slice obeys

- Real PostgreSQL in tests; Safaricom only through the fake; **no agent ever moves real money or
  sends a prompt to a real phone.** Only the owner presses Send on the live site.
- Errors are three lines, never merged: what Safaricom said, what it means, what to do now.
- Money in cents, whole shillings where Safaricom requires them.
- One gate before each commit. The lead commits and deploys the same day it is green.
- Never log or print secrets, keys, phone numbers or receipts.
