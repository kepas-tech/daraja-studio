# Menu plan and progress

**This file is the single source of truth for what Studio's menu promises and how much of it works.**
It is tracked in git and published, so any person, session or model can read it and know exactly
where the project stands without asking anyone.

Last updated 2026-09-17.

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
| 4 | Bulk send | `bulk` | live | M5 | 0.11.0, deployed 2026-09-16 |
| 5 | Look up a payment | `lookup` | live | — | shipped in 2A; merged into History in 0.8.0 (no menu item, `/lookup` opens History) |
| 6 | Reverse a payment | `reverse` | live | M3 | shipped 2026-09-14 |
| 7 | Money in | `money-in` | live | M2 | 0.9.0, deployed 2026-09-16 |
| 8 | Ask a customer to pay | `stk` | live | M1 | shipped 2026-09-14 |
| 9 | QR codes | `qr` | live | M6 | shipped 2026-09-14 |
| 10 | Invoices | `invoices` | live | M7 | 0.12.0, deployed 2026-09-16 |
| 11 | Standing orders | `standing-orders` | live | M8 | 0.13.0, deployed 2026-09-16 |
| 12 | Express checkout | `express` | live | M9 | 0.13.0, deployed 2026-09-16 |
| 13 | Bonga points | `bonga` | live | M10 | 0.13.0, deployed 2026-09-16 |
| 14 | Waiting | `approvals` | live | M4 | 0.10.0, deployed 2026-09-16; widened in 0.21.0 to sent and no-answer rows, with age and Check with Safaricom |
| 15 | History | `history` | live | — | shipped in 2A |
| 16 | People | `people` | live | — | shipped in 3B |
| 17 | Settings | `settings` | live | — | shipped before 0.4.0 |
| 18 | Not possible via API | `not-possible` | live | — | 15 explanation cards |
| 19 | How to use | `guide` | live | — | 0.14.0, deployed 2026-09-16; the same text at `/guide.md` for AI agents |
| 20 | Organisation (account menu) and Go live | — | live | — | 0.15.0, deployed 2026-09-16; Settings holds app behaviour only |
| 21 | Contacts | `contacts` | live | F1 | 0.17.0, deployed 2026-09-17; the KEPAS Pay borrow list, item 1 |
| 22 | Businesses | `businesses` | live | F2 | 0.18.0, deployed 2026-09-17; the KEPAS Pay borrow list, item 2 (customers ride with it) |
| 23 | Notifications | `notifications` | live | F4 | 0.20.0, deployed 2026-09-17; the inbox and its bell, item 4 |
| 24 | Reports | `reports` | live | F6 | 0.22.0, deployed 2026-09-17; per-day in and out, success rate and failure reasons, item 6 |

**23 of 23 live (two of them folded into Home and History). Nothing left to build; the send types below are the remaining work.** Each slice below removes exactly one Coming soon label.

## Buttons that are not menu items

Real work that adds no menu entry, tracked here for the same reason the send types are.

| Button | Where | Status | Evidence |
|---|---|---|---|
| Export as a spreadsheet | History, Invoices | live | 0.19.0, deployed 2026-09-17; the KEPAS Pay borrow list, item 3; behind the already-declared `history.export` |

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
Daraja call behind it, taken from `@kepas/daraja-js` 1.6.2, not from the label.

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

### M4 — Waiting for approval · ours, not Daraja's — DONE 2026-09-16
A second person approves a send before it leaves, which is what makes Studio safe for a business with
staff. The `awaiting_approval` status already exists in the schema. Above a threshold set in
Settings, a send waits; an approver with a distinct permission releases or refuses it; the maker can
never approve their own. Enforced server side, not in the UI.

What shipped: `send.approvalThresholdCents` (Settings › Approvals, owner, step-up; 0 = off; applies
to everyone, the owner included); the send service's post-insert path is `dispatch()`, shared by a
direct send and a release, so a released send takes exactly the ordinary path; `release` flips the
row from `awaiting_approval` to `pending` in one UPDATE (the double-press guard) and picks the
operator then; `refuse` records who and why; `approvals_expire` refuses held rows after 24 hours;
permission `send.approve` and the Approver role preset (migration 021); routes under
/api/approvals; the Waiting for approval page and a count badge on the menu.

### M5 — Bulk send · ours, over the existing phone send — DONE 2026-09-16
Payroll and supplier runs. A list is validated before anything is sent, then sent one at a time down
the same path a single send uses. Every row is an ordinary request row from the start, so a batch is
a grouping and never a special path that bypasses the duplicate guard or the send cap.

What shipped: `money_out/bulkParse.ts` (phone, amount, name, note; comma or tab; quotes; header;
in-batch duplicates; whole shillings) and `money_out/bulk.ts`; the `bulk_plans` table (migration
022) holds the checked rows and each row's outcome; the `bulk_send` job sends rows in order through
`moneyOut.send()` (duplicate guard, cap, approval hold and three-line errors are a single send's),
records a refusal and goes on, and is safe to re-run; Retry re-queues rows refused before Safaricom
for a passing reason; routes under /api/send/bulk; the Bulk send page (paste or upload, check,
preview, one password) and the batch page with live per-row status and a results download.

### M6 — QR codes · `qr.generate` — DONE 2026-09-14
A payload the customer scans to pay. Cheap, and genuinely useful at a counter or for a rider.

Synchronous, so no callback, sweep or payment row. The response handling is the part worth keeping:
the returned image is validated as a real PNG by magic bytes, header and IEND and bounded in size,
so a URL, HTML or SVG from upstream can never reach the page or a download.

### M7 — Invoices · `billManager.optIn`, `sendInvoice`, `cancelInvoice`, `acknowledgePayment` — DONE 2026-09-16
Invoices your customers can pay. Several calls plus an opt-in lifecycle, so the first genuinely
large slice.

What shipped, all of Bill Manager: opt in once per environment (owner, step-up; the app key is
kept encrypted in `env.<env>.billManagerAppKey` and never echoed; opting in again is
`updateOptIn`); single invoices with optional line items and a minted `INV-000001` reference,
written only after Safaricom accepted; bulk invoices from a pasted or uploaded list in one call;
cancel (single or many, unpaid only); the payment push on `/cb/<secret>/billmanager` matched to
the open invoice by account reference, idempotent on the transaction id, recorded as a
`invoice_payment` row in History, with unmatched pushes kept and listed; recording a payment made
another way through `acknowledgePayment` so reminders stop; overdue derived at read time. The
callback router lets a handler name its own acknowledgement body, which Bill Manager needs
(`rescode 200`). Table `customer_invoices` (migration 023; not `invoices`, which an install that
came through the hosted line already has for the host's own billing); routes under /api/invoices;
the Invoices page and Settings › Invoices.

### M8 — Standing orders · `ratiba.create` — DONE 2026-09-16
A recurring debit. The scheduling rules must be shown honestly, including what Daraja will not let
anyone change after creation.

What shipped: the `ratiba` collect kind (`money_out/kinds/ratiba.ts`, in `COLLECT_KINDS`); the
collect service's STK path became one `start()` shared by M1, M8, M9 and M10; a repeat name for
the same customer is refused before the call; the consent callback on `/cb/<secret>/ratiba`
completes or fails the row; no answer in 15 minutes marks it unknown; the Standing orders page
(list, questionnaire, review with the "nothing can be changed" note). Each collection then
arrives as an ordinary Money in row.

### M9 — Express checkout · `express.checkout` — DONE 2026-09-16
Business-to-business with a checkout experience. Narrow.

What shipped: the `express` collect kind; this studio is the vendor and prompts the paying
business's till (`primaryShortCode`) to pay this paybill; the flat callback on `/cb/<secret>/express`
settles the row; the Express checkout page mirrors Ask a customer to pay.

### M10 — Bonga points · `bonga.calculatePoints`, `bonga.redeem` — DONE 2026-09-16
Loyalty points. Narrow, and last because few businesses need it to operate.

What shipped: the `bonga` collect kind; the page values points as they are typed (read only) and
the server values them again before redeeming, never trusting the browser's rate; the settlement
arrives on the C2B confirmation and `money_in/record.ts` completes the waiting bonga row under
that account number instead of writing a second row; refused until Money in is turned on.

## Rules every slice obeys

- Real PostgreSQL in tests; Safaricom only through the fake; **no agent ever moves real money or
  sends a prompt to a real phone.** Only the owner presses Send on the live site.
- Errors are three lines, never merged: what Safaricom said, what it means, what to do now.
- Money in cents, whole shillings where Safaricom requires them.
- One gate before each commit. The lead commits and deploys the same day it is green.
- Never log or print secrets, keys, phone numbers or receipts.
