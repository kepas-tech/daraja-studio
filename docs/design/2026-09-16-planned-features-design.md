# The seven planned features — design

Owner decisions, 2026-09-16: ship one slice at a time, each live the day it is green; Money in
accepts every payment; approval holds apply to everyone, the owner included; Bulk send takes a
pasted list or a CSV file; Invoices cover everything Bill Manager offers.

Order, from `docs/MENU-PLAN.md`: Money in (M2) → Waiting for approval (M4) → Bulk send (M5) →
Invoices (M7) → Standing orders (M8) → Express checkout (M9) → Bonga points (M10). Each slice has
its own implementation plan, its own commit, its own deploy, and removes exactly one Coming soon
label in the same commit.

## 1. Foundation shared by all seven

Approach: one module per feature, plugging into what exists. No new engine. The kinds registry
(`server/src/money_out/registry.ts`), the callback router (`server/src/callbacks/router.ts`, the
handler map in `server/src/app.ts`), the scheduler (`server/src/scheduler/handlers.ts`), the fake
Safaricom (`server/src/dev/fakeSafaricom.ts`) and History already do the shared work.

Every slice reuses:

- `requests` for anything with a Safaricom outcome. New `type` values: `c2b`, `invoice_payment`,
  `ratiba`, `express`, `bonga`. A new type joins `LEDGER_TYPES` so History shows it, and never
  joins `MONEY_TYPES` or `BILLABLE_SEND_TYPES` unless money leaves the organisation's accounts.
- `callbacks_raw` first, then the handler; every callback answers 200.
- `events` (`request.updated`, `balance.updated`, plus one event per new list page) for live pages.
- `jobs` for timers and recurring work; `permissions/catalog.ts` for new permissions;
  `web/src/copy/en.ts` for every word; `available: true` and the MENU-PLAN row in the feature's
  own commit.

New shared pieces, built in Money in and reused after:

- `server/src/money_in/`: a `RequestKind`-like registry for things the customer initiates. Each
  kind declares `type`, `callbackPath`, a parser, how the row is written, and the duplicate key
  (the receipt). `money_in/kinds/<name>.ts`, one per feature, registered in one map, exactly as
  `money_out/kinds/` is.
- One callback handler file per path, added to the handler map in `app.ts`.
- Registrations: things registered once per environment with Safaricom (C2B addresses, Pull, Bill
  Manager opt-in) are stored as settings `env.<env>.<thing>.registeredAt` (secrets encrypted as
  today), shown as a status line with one idempotent Register button; Safaricom's "already
  registered" answer counts as success.
- Fake Safaricom grows one scenario per new call and a "customer pays" trigger that posts a
  confirmation to the studio's own callback address.

Tests per slice: refused, timed out, answered twice, answered after we gave up; real PostgreSQL;
Safaricom only through the fake; no agent ever moves real money or prompts a real phone.

## 2. Money in (M2)

Turning it on. The Money in page opens with a status card for the mode the studio is in: "Not
registered" or "Registered on <date>". Turn on (owner, password step-up) registers the
confirmation and validation addresses (`c2b.registerUrls`, `responseType: 'Completed'`) and the
Pull address (`pull.registerUrl` with the organisation's nominated number). Stored as
`env.<env>.c2b.registeredAt` and `env.<env>.pull.registeredAt`. Re-register is the same button.

Validation (`/cb/<secret>/c2b/validate`): raw stored, answer `c2bAccept()` always, nothing else.
Note for the page: Safaricom only calls validation when its support has enabled it for the
paybill; otherwise it goes straight to confirmation.

Confirmation (`/cb/<secret>/c2b/confirm`): raw stored; `parseC2bConfirmation`; insert a `requests`
row `type='c2b'`, `status='completed'`, `amount_cents`, `receipt` = `transId`,
`account_reference` = `billRefNumber`, `recipient_name` = payer name, `recipient_value` = phone
(masked in every view), `payload_json` with the balance Safaricom reported, `result_source
='callback'`. Idempotent on receipt: a repeat is stored raw with verdict duplicate and no second
row. Publishes `request.updated` and `balance.updated`. A body that does not parse answers 200,
keeps the raw and is verdict unmatched.

Missed payments. Recurring job `c2b_pull` every hour and a "Check for missed payments" button:
`pull.query` for the last 48 hours in pages of the API's size, inserting any receipt not already
present as the same row with `result_source='poll'` and a note "found by check". The button
reports "Found N missed payments" or "Nothing missed". The job runs inside the organisation
scope, only when `env.<env>.pull.registeredAt` is set for the current mode.

Where it shows: History lists `c2b` rows with an in-arrow and a direction filter (in, out, all);
Home's recent list includes them; the Money in page shows the status card, the check button and
the last 20 received with a link to History.

Not in this slice: account-number rules; refunds (Reverse already works on any receipt).

Tests: register twice is one registration; confirm inserts once, a repeat is duplicate; malformed
confirm answers 200 and keeps raw; pull inserts only unseen receipts and pages; the hourly job is
a no-op when not registered.

## 3. Waiting for approval (M4)

Setting: Settings › Approvals, "Hold sends of KES X or more for a second person", off by
default (0), owner only, step-up. Turning it on with nobody else able to approve shows a warning
that nothing can be released until an approver is added.

Permission: `send.approve`, "Can approve sends others made", owner by default, assignable in
People. The server refuses a release or refusal where `created_by` equals the approver.

Hold: in the send service, after validation and the duplicate guard and before any Daraja call,
when the threshold is on and `amount_cents >= threshold`, the row is written
`status='awaiting_approval'` with no operator chosen (the operator is picked at release) and the
send answers with that status. A held row spends no allowance and touches no balance.

Approvals page: held rows with maker, time, recipient (masked), amount, category, note. Release
(step-up, then the ordinary send path continues as if just pressed) and Refuse (reason required;
row becomes `rejected`, `approved_by` = refuser, reason in `result_desc`). Both audited. Live via
`request.updated`. Badge count on the menu item.

Expiry: recurring job `approvals_expire` rejects held rows older than 24 hours with the reason
"Not approved within 24 hours".

Bulk rows (section 4) are held under the same rule; the batch page offers Release all with one
step-up.

Tests: below threshold sends now; at threshold holds; the maker cannot release their own; no
permission is 403; release sends once when pressed twice (advisory lock on the row id); refuse
needs a reason; the expiry job touches only old held rows; changing the threshold does not touch
rows already held.

## 4. Bulk send (M5)

Input: a paste box and a file picker feeding one parser. One row per line, `phone, amount, name,
note`; first two required; comma or tab separated; a header row is skipped; blank lines ignored;
quoted fields allowed. A "Download template" link. One category for the whole batch.

Validation before anything moves: phone normalises to 254…; amount is whole shillings within the
send limits; phone+amount repeated inside the batch is flagged; the total is checked against the
utility balance and the monthly send cap. Any error shows the rows in red and nothing proceeds.

Review: every row, the count, the total, the category; one password step-up; `POST
/api/send/bulk` creates a `bulk_plans` row (id, org_id, created_by, category, total_cents,
row_count, status `sending|done|partly_done`, created_at) and one `requests` row per line with
`bulk_plan_id`, `status='pending'`, in one transaction; the duplicate guard runs per row against
history exactly as a single send.

Sending: job `bulk_send` drains one plan, rows in order, one at a time, through the same kind
send path a single send uses, with a short pause between rows; a failed or refused row is recorded
and the batch continues; the approvals threshold holds a row instead of sending it; the plan ends
`done` or `partly_done`.

Page: batch list (date, count, total, status); detail with per-row live status; Retry failed rows
(retriable ones only, re-queued under the same plan); Download results CSV (phone masked, status,
receipt).

Never: a separate send path, a skipped duplicate guard, a row without its own request.

Tests: parser cases; one bad row creates nothing; N rows in one transaction; drain sends in order
and continues past a failure; retry re-queues only retriable rows; held rows under the threshold;
the cap counts every row.

## 5. Invoices (M7): all of Bill Manager

Opt in: first visit is a questionnaire (business email, official contact phone, reminders yes or
no, optional logo) → `billManager.optIn` with the studio's `billmanager` callback address; the app
key is stored encrypted as `env.<env>.billManager.appKey` with `optedInAt`; Settings › Invoices
shows it with Change (`updateOptIn`). Owner, step-up, per environment.

Table `invoices`: id, org_id, external_reference (ours, `INV-000123`, unique per organisation),
customer_name, customer_phone, invoice_name, account_reference, billed_period, due_date,
amount_cents, items jsonb, status (`sent|paid|partly_paid|cancelled`), paid_cents, created_by,
sent_at, paid_at, cancelled_at. Overdue is derived at read time from due_date and status.

Single invoice: questionnaire customer name → phone → invoice name → account reference → billed
period → due date → amount or line items (items must sum to the amount). `sendInvoice`; rescode
200 marks it `sent`; anything else shows the three lines and stores nothing.

Bulk invoices: the Bulk send parser with columns `name, phone, invoice name, account, period, due
date, amount`; validated in full; previewed; `sendBulkInvoices` in one call; one row each.

Cancel: an unpaid invoice → Cancel (step-up, reason optional) → `cancelInvoice`; multi-select →
`cancelBulkInvoices`. Paid invoices cannot be cancelled.

Payment push (`/cb/<secret>/billmanager`): raw first; `parseBillManagerPayment`; match on
`accountReference` to an open invoice; add to `paid_cents`; set `paid` or `partly_paid`; insert
a `requests` row `type='invoice_payment'` with the receipt so it is in History; reply
`billManagerAck()`. An unmatched push is kept and listed under "Payments we could not match". A
repeated transaction id is a duplicate.

Record a payment made another way (cash, bank): on an open invoice, a questionnaire (date, amount,
reference, payer) → `acknowledgePayment` so Safaricom stops reminders; local status updated the
same way.

Page: list with filters (open, paid, overdue, cancelled), search by name or reference; detail with
items and payment history; the buttons above.

Tests: opt-in stores the key encrypted and never echoes it; a refused send stores nothing; bulk
with one bad row sends nothing; push matches once, a repeat is duplicate; partial then full
payment; unmatched push kept; acknowledge updates locally and calls Safaricom; cancel only when
unpaid; overdue derivation.

## 6. Standing orders (M8), Express checkout (M9), Bonga points (M10)

Standing orders: questionnaire order name (unique per customer; a repeat is refused before the
call) → customer phone → amount → how often (One-off, Daily, Weekly, Monthly, Every two months,
Quarterly, Half-year, Yearly) → start date → end date → account reference (12 chars) → note (13
chars). Review says: "Once created, nothing can be changed. To change it, create a new one and ask
the customer to stop the old one on their phone." `ratiba.create` → `requests` row
`type='ratiba'`, `status='sent'`; the `/ratiba` callback settles `completed` (order active) or
`failed` with Safaricom's words. Page: list with status, schedule, next collection computed
locally. Collections arrive as Money in rows, linked by account reference. Daraja offers no status
query for Ratiba: a `sent` row with no callback after 15 minutes shows "No answer yet".
Permission `ratiba.request`.

Express checkout: questionnaire the paying business's till → amount → reference → your name as they
know you. `express.checkout` with `primaryShortCode` = their till and `receiverShortCode` = ours →
`requests` row `type='express'`, `status='sent'`, `originator_conversation_id` = `requestRefId`.
The `/express` flat callback settles it and stores the receipt. Permission `express.request`. No
operator, no send cap: nothing leaves our account.

Bonga points: page with a points field → `calculatePoints` shows the shilling value live (no row).
Redeem: customer phone → points → account reference; `bonga.redeem` prompts the customer's phone;
`requests` row `type='bonga'`, `status='sent'`. Settlement arrives on the C2B confirmation: the
Money in handler completes a `sent` bonga row whose account reference matches, instead of
inserting a second row. Requires Money in registered; the page says so if not. Permission
`bonga.request`.

Common: each gets a `money_in/kinds/` file, a fake Safaricom scenario, three-line errors,
`available: true`, its MENU-PLAN row. Menu order unchanged.

Tests per feature: refused sync (row failed, words shown); callback completes; callback twice is
duplicate; callback for an unknown reference is kept unmatched; a timed-out row shows no answer.
Ratiba: repeat name refused before the call. Bonga: redeem without Money in registered is refused
with a plain message.

## Rules every slice obeys

From MENU-PLAN: real PostgreSQL in tests; Safaricom only through the fake; no agent moves real
money or prompts a real phone; errors are three lines, never merged; money in cents; one gate
before each commit; the lead commits and deploys the same day it is green; never log secrets,
keys, phone numbers or receipts; all copy in `web/src/copy/en.ts`, plain English first,
Safaricom's term in grey beneath; every multi-input form is a questionnaire.
