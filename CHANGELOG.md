# Changelog

## 0.29.1 — the business code is Studio's too

- The three-digit code in front of every account number is handed out the same way an account number
  is: nobody types one. **Add a business** asks for a name only, and the page says which code Studio
  will give it — the next free one, lowest first. Two people adding a business at the same moment can
  never be given the same code.
- The API refuses a code sent from a client, exactly as it refuses an account number, and the refusal
  writes nothing at all.
## 0.29.0 — an account number that can never be mixed up

- Account numbers are now three levels, all drawn by Studio: a three-digit business code, a customer
  number, and an account under a customer for the room, the plot or the child. `000` is a business,
  `000359` a customer, `000359123` an account under them.
- Nobody types a number and no form has a box for one. Studio draws each one at random, so a payer
  cannot guess a neighbour's number, and a retired number is never given out again.
- The length of a number is written into the number itself: a customer number starts at three digits,
  and when all 900 of them are used the next ones are four digits, then five. The Businesses page
  says where each business stands — "Customer numbers: 3 digits, 412 of 900 used" — and the bell
  tells you when a length runs out: "Customer numbers for Shop now have 4 digits."
- A payment is sorted by what the payer typed, and now always one way: the digits say their own
  length, so they can never be read as somebody else's account. Money in names the reason when a
  payment needs a person — no business has this code, no account with this number, no such account
  under that customer, or too many digits — and one press labels it.
- Ask a customer to pay, QR codes and Invoices pick a business, then a customer, then one of the
  accounts under them, and Studio fills the full number.
## 0.28.0 — a message on the device when something happens

- Notifications can now reach the phone or the computer itself, even with Studio closed. The
  Notifications page has one button that turns the device on, and **Send a test** proves it works.
  Each device is turned on on its own, and **Turn off on this device** stops that one.
- The message carries the same sentence as the line in the inbox, and pressing it opens that
  payment. The same thing happening twice replaces the earlier message instead of stacking.
- Off unless the person who runs Studio gives the server a push key pair. With no keys the page
  shows nothing at all, and nothing is ever sent.

## 0.27.0 — sign out everywhere

- Organisation gains **Sign out everywhere**: one press ends every session this person holds, on
  every device and in this browser too, for the phone left open or lent to somebody. The password
  is asked for first, so a borrowed screen cannot end somebody else's session.
- It is the same idea as the sign-out a password change already performs, offered on its own for
  the case where nothing is wrong with the password.

## 0.26.0 — what Safaricom charges on each payment

- The send review now says what the payment costs: "Safaricom's charge: KES 13, taken from
  Utility", from Safaricom's published PayBill and Disbursement tariffs. History carries the same
  figure per row. Nothing is added on top — Studio sells nothing, so there is no margin here.
- The bands are seeded from the public tariff (17 bands each for money in, money out to a phone,
  and business payments) and an amount above the top band shows no charge rather than a guess.
- Each row keeps the charge it was costed at: changing the tariff never rewrites history. The owner
  can correct the bands under Settings › Charges when Safaricom changes them.
- An amount with no band says so, instead of showing a zero that would read as free.

## 0.25.0 — Who did what

- A new owner-only page, **Who did what**, shows every action Studio already records: who did it,
  what they did, what it was done to, the before and after values, and the address it came from.
  Newest first, with filters for a person, an action, a date range, and a search box.
- The log is the one Studio already keeps and it is append-only at the database level: nothing on
  this page can change or remove a row. Nothing new is recorded for it either.

## 0.24.0 — the balance catches up with the last payment

- Every payment that finishes now asks Safaricom for the balance again, at most once a minute, so
  Home shows the balance after the last thing that happened instead of the one from this morning. A
  busy minute costs one balance query, not one per payment. The daily refresh stays as it was.
- Home gains one line: "Balance KES X · waiting to go out KES Y". The balance is the **Utility**
  account, which is what sends come from; Y is the money promised and not yet gone. When more is on
  its way out than there is to send, the line says so and points at moving float from Working.
- No balance yet says so, rather than showing a zero.

## 0.23.0 — operator cards that say Active, Standby or DOWN

- Settings › Daraja app now says plainly what each API operator is doing: **Active**, **Standby**,
  **DOWN**, or switched off; how many of the two allowed failures have happened; when the password
  expires; and a **Reinstate** button that asks Safaricom to check it again.
- One credential failure no longer takes an operator down. Two inside ten minutes does, and any
  success — a probe Safaricom accepts, or a payment that settles — clears the count. A stale
  password that the next call survives no longer costs a day of sending.
- Safaricom's `TP40153` joins 2001 and 8006 as a credential-class code, and all three now read as
  the operator's problem rather than the payment's: what Safaricom said, that the credential is what
  failed, and the steps in Settings that fix it.

## 0.22.0 — Reports: how the week went, and why some payments failed

- Reports, in the menu beside Home: money in and money out for every day in the window you pick
  (7, 30 or 90 days), with the counts, the success rate, and "Why things failed — last 7 days"
  grouped by Safaricom's own reason, each with the shillings it affected.
- The success rate counts completed against completed plus failed. A payment that never got an
  answer sits in its own column and is left out of the rate: calling "we do not know yet" a failure
  would be wrong, and calling it a success would be worse.
- The business filter every list already has narrows the numbers, and the per-day table leaves as a
  spreadsheet for whoever holds `history.export`.
- Home gains a 24-hour strip: what came in, what went out, and how many are waiting or failed.
- Balance checks and payment lookups never count: they are housekeeping, not money. Days with
  nothing show as zeros, so a gap in trade looks like a gap.

## 0.21.0 — one Waiting page for money that has not finished

- "Waiting for approval" is now **Waiting**, and it holds three kinds of unfinished payment: sends
  waiting for a second person, sends Safaricom has not answered yet, and sends Studio has stopped
  checking. Each row shows how long it has been waiting.
- Every row offers the one action that helps: Release or Refuse on a held send, "Check with
  Safaricom" on one Safaricom has gone quiet about, and Mark as checked once a person has looked.
  The page itself moves no money.
- The menu badge counts what needs a person: sends waiting for approval plus sends with no answer. A
  send that is merely in flight is not a badge.
- `GET /api/waiting` and `/api/waiting/count`. The approval routes are unchanged, so Release and
  Refuse keep their own gates.

## 0.20.0 — a bell that says what happened while you were away

- Notifications: every payment that settles, fails or goes unanswered, every send that waits for a
  second person, and an operator that stops working now leaves one line in an inbox. The bell in
  the menu carries the unread count.
- Each line is a sentence with the owner's own name for the person and the receipt: "Sent KES 300
  to Joseph Ngumbao John. They received it. Receipt UIG517BUAZ." Money in reads "Received KES 300
  from Robert." A failure adds Safaricom's own words. No line carries a phone number, and the raw
  callback body is never copied into one.
- The same event twice is one line with "×2", not two lines, and a line that has been read stays
  read when it happens again. Open a line to mark it read, or clear the lot with "Mark all read".
  Any signed-in person may read and clear the inbox; there is no permission for it.
- Table `notifications` (migration 026), routes under `/api/notifications`, and
  `notification.created` over the existing event stream so the bell keeps itself current. Web push
  is phase 2 and is not in this version.
- The manual gains "See what happened while you were away".

## 0.19.0 — take History and Invoices out as a spreadsheet

- History and Invoices each get "Export as a spreadsheet". The file carries every row the filters
  select, not only the page on screen, so a month of payments or invoices leaves in one press. The
  button shows for the owner, or for somebody given the already-declared `history.export`.
- The columns read the way the pages read. The kind of payment and the status are words
  ("Business payment", "Paid"), a saved contact or customer name comes before Safaricom's own, and
  an amount is shillings with two decimals, the shape a spreadsheet adds up.
- Every cell is quoted, and a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage
  return gets a leading apostrophe, so a customer's own text can never run as a formula.
- Each export writes one audit entry naming the filters that were used. The search text stays out
  of it, because it is often a phone number.
- The file is named `history-YYYY-MM-DD.csv` or `invoices-YYYY-MM-DD.csv` after the day it was
  made in Nairobi time, and it is never cached.

## 0.18.0 — several businesses on one paybill, sorted by what the payer types

- One paybill can serve more than one business. Each business gets a three-digit code, 000 to 999,
  and each customer gets a number Studio gives them, so the account number a payer types reads as
  <business code><customer number>: 000123 is business 000, customer 123. Money in sorts itself
  from that number, so a payment keeps a name instead of a bare reference.
- Pay out: Send money to a phone and Bulk send ask which business the money is for, and the answer
  defaults to the last one used. A business's customers can be picked on Ask a customer to pay, QR
  codes and Invoices, and Studio fills the account reference with that customer's account number.
- Money in gains an "Unmatched payments" card for anything Studio could not place, with one click
  to assign a business or to take the number the payer typed as a new customer. Nothing is ever
  rerouted: an assign only labels the row and writes an audit entry.
- History filters by business, and by customer through the link Money in offers. Home shows one
  line per business, in and out for the day, once there is more than one.
- With a single business nothing changes: routing is off, every payment belongs to it, and the
  page says so until a second business exists. A business is switched off, never deleted, so a
  code is never reused; a customer is retired and their number is never given to anyone else.
- New permission `businesses.manage`. Reading the lists needs only a session, because the
  pickers have to work for whoever may send.

## 0.17.0 — Contacts, so a repeat payment is a name you pick

- Pay out › Contacts: save the people and businesses you pay. A contact is a name and one of three
  things: a phone number, a till number, or a paybill number with the account reference the paybill
  asks for. Send money to a phone and Bulk send pick from the list, so the number is not retyped
  and mistyped. History shows your own name for the person beside Safaricom's own.
- Anyone signed in may read the list, because the pickers have to work for whoever may send.
  Adding, changing and deleting take the new `contacts.manage` permission: the owner, or a role
  given it. Deleting retires a contact rather than erasing it, so History keeps the name the money
  was paid under, and the name can be used again.
- `POST /api/send/phone` takes an optional `contactId`. The number being dialled is still the one
  on the review screen, and Studio refuses a pair that disagrees (400 `contact_mismatch`) instead
  of guessing which one you meant. Bulk rows are matched to a saved contact by phone.
- Table `contacts` (migration 024), `requests.contact_id`, routes under `/api/contacts`. The
  manual has a new task, "Keep a list of people you pay".

## 0.16.3 — Safaricom's reference on a refused invoicing set-up

- When Safaricom refuses the Bill Manager set-up with "not allowed", the page now shows
  Safaricom's own reference number and error code for that refusal, and asks you to quote them
  in the email to API support. The server log carries the same two values. Never the body.

## 0.16.2 — Bill Manager on the address Safaricom's own email gives

- `@kepas/daraja-js` 1.6.2. Safaricom's go-live email lists the production Bill Manager
  addresses with the first part twice (`/v1/billmanager-invoice/v1/billmanager-invoice/optin`),
  unlike its docs page, and the documented address answers "Invalid Access Token" even with
  Bill Manager ticked and a fresh token. The SDK now tries the email's address when the
  documented one is refused, so Set up invoicing can go through. Nothing is sent twice: a refusal
  happens at the gate, before Bill Manager sees anything.
- Send money › To a phone: when Safaricom has not switched on name checks for your number, the
  review says so and points at the manual, instead of the generic "cannot check" line.

## 0.16.1 — Safaricom's own words when a number is unknown

- `@kepas/daraja-js` 1.6.1: the name check's "The customer does not exist." now arrives as the
  error message itself, whichever shape Safaricom sends it in. Studio already read both shapes;
  this keeps the SDK honest for everyone else too.

## 0.16.0 — the name behind the number, before you send

- Send money › To a phone: the review now asks Safaricom for the name registered to that number
  and shows it (first name in full, the rest hidden by Safaricom). When Safaricom does not know
  the number, a red notice says so before you send. When Safaricom has not switched the check on
  for your paybill or till, the review says what it always said: check the number. Safaricom calls
  this B2C Hakikisha; it needs their approval, and the manual says how to ask.
  `POST /api/send/name-check`.
- `@kepas/daraja-js` 1.6.0: the name lookup, and a fix for a 401 that lasted up to an hour after a
  product was added to the app on the Daraja portal (the cached token was minted before the
  change; the SDK now drops it and asks again with a fresh one).

## 0.15.3 — Safaricom's own words on a refused key

- `@kepas/daraja-js` 1.5.1. When Safaricom answers HTTP 401, the line it sent ("Invalid Access
  Token", "Invalid API call as no apiproduct match found") now reaches the three-line error instead
  of a fixed "authentication failed", so a wrong key reads differently from a product that is not
  ticked on the app.

## 0.15.2 — "not allowed" on Bill Manager says what it is

- When Safaricom answers HTTP 401 to the invoicing set-up while the same key works everywhere
  else, Studio no longer says the key and secret were refused. It says Bill Manager is not
  allowed for this app or number, and shows the two ways out with the clicks: tick Bill Manager
  under Update App on the Daraja portal, or ask Safaricom's API support to enable it for the
  paybill. The manual carries the same note.

## 0.15.1 — invoicing set-up you can watch

- Set up invoicing answers at once and tells Safaricom in the background; the page says it is
  doing so, re-reads every few seconds, and then shows either the set-up done or Safaricom's own
  refusal in three lines, with the form ready to try again. Before this, a slow answer from
  Safaricom let the proxy in front of Studio give up first, and the browser saw only "Something
  went wrong on our side". `POST /api/invoices/opt-in` answers 202; `GET /api/invoices/settings`
  carries `registering` and `lastError`.
- A reply that never came from Studio (a dropped connection, a proxy page) now says so instead
  of blaming Studio.

## 0.15.0 — Organisation, a calmer Settings, and Go live

- The account menu opens Organisation: Business (name and contacts), Mode, one card each for
  Sandbox and Production (the one in use first, the other behind Show) with a status line and
  the number, Daraja app, passkey, certificate and API operators inside, Who can log in, and
  Delete this studio. Every form there carries "Where to get it" for Safaricom.
- Settings keeps only how Studio behaves: Appearance, Public address, Payment categories,
  Approvals, Invoices, and an Advanced fold (closed by default) for the B2C version, Safaricom's
  callback addresses and the callback secret.
- Go live, for a Sandbox studio: Organisation › Go live (and a line on Home) walks the owner
  from pretend money to real money one screen at a time, asking the password once: the number,
  the Consumer Key and Secret, the switch with the number typed back, then the passkey and the
  API operator only if the business uses them. Steps already done say so. New:
  `POST /api/settings/environments/:env/passkey/prove`; `GET /api/settings` carries `uses` and
  each environment's `passkeyProven`.

## 0.14.4 — the M-Pesa business portal, as it really is

- The API operator trail now matches the live M-Pesa business portal: Search › Organization
  Operator › pick your number › Search, + Create (Business Administrator only), Access Channel
  API, Rule Profile Web Operator Rule Profile, the three roles; then Detail › Set Password by a
  Business Manager, which turns Pending Active into Active. The number is under Search › My
  Organization. A Web user holding the same roles also works.
- When Safaricom refuses an operator with "initiator information is invalid", What to do now
  says exactly that: Active not Pending Active, the two roles, then add it again.

## 0.14.3 — setup steps say exactly where on Safaricom’s sites

- Every setup step and Settings form that takes something from Safaricom now shows "Where to
  get it": a button to the exact Safaricom page and the clicks once there (a → b → c), read off
  the live Daraja portal: the app card on My Apps for the Consumer Key, Secret and Passkey, Test
  Credentials for a Security Credential, Go Live and its fields, Self Service › URL Management
  for registered payment addresses, and the M-Pesa business portal for the number and the API
  operator (roles, access channel, who sets the password and with which characters). The
  wizard’s own hints, the Money in caveat and the Not possible card for callback addresses say
  the same. One data source feeds the forms and the manual.

## 0.14.2 — the manual in everyday words, with Safaricom’s clicks

- How to use is rewritten for people who are not technical: no routes, codes or permission
  names, and every screen named as it appears. A new section, Getting things from Safaricom,
  walks through each item Studio asks for (a Daraja account and app, the Consumer Key and
  Secret, Go Live, the Passkey, the M-Pesa business portal administrator, a portal user for
  Studio, the certificate file, a Security Credential, the paybill or till number) with a button
  to the right Safaricom page and the clicks once there, written as a trail (a → b → c). Each
  task also says where it is in Studio’s menu and who can do it.

## 0.14.1 — the manual, tidied

- The How to use page shows the tasks and steps only. The Markdown copy at `/guide.md` is for
  tools that read plain text; a browser asking for it gets the app, which opens Home.

## 0.14.0 — How to use

- A How to use page at `/guide`, written from a walk through every page of the live studio: what
  to have ready, the ten setup steps, logging in, Home, History, every Get paid and Pay out task
  as numbered steps the way the screens go, Settings row by row, People, Account, the status
  words and the three-line error, and what the API cannot do. Reachable from the menu (above Not
  possible via API), from the Login page and from the setup wizard, so a reader without an
  account can still read it. One source (`web/src/copy/guide.ts`) feeds the page and a Markdown
  copy at `/guide.md`; a test fails when they drift.

## 0.13.8 — Waiting for approval only when it applies

- The menu shows Waiting for approval only while Settings › Approvals is on, or while a send held
  earlier still waits. `GET /api/approvals/count` also says whether approvals are on.

## 0.13.7 — "already registered" counts as on

- A production paybill takes one C2B registration; Safaricom refuses the next with "URLs are
  already registered". Money in now treats that answer as registered and says so on the page,
  with the caveat that an older address could be on record and that the hourly check finds
  every payment regardless.

## 0.13.6 — Money in registration you can watch

- Turn on answers at once and the registration runs behind it; the page says it is telling
  Safaricom, re-reads every few seconds, and then shows either "On since …" or Safaricom's own
  refusal in three lines. A cut connection in between can no longer hide the answer, and a
  failure is logged. `POST /api/money-in/register` answers 202; status carries `registering` and
  `lastError`.

## 0.13.5 — Paybill or Till, by name

- The number is called what it is: Paybill or Till once Safaricom has said which (learned when the
  name is checked), "Paybill or till" until then. It shows under the business name in the menu and
  in the account menu on every page, and on Home's line under the heading.
- Account › Shortcodes has "Check the name with Safaricom"; the name is also fetched the moment a
  key and secret are accepted, for a number entered before them.
- Saving the business name renames the organisation itself, so the header and Home show it at
  once. Before this fix the name looked stuck on "My organisation" after a reset.

## 0.13.3 — Home names the account

- Home's heading is the name Safaricom holds for your shortcode (recorded when the shortcode was
  checked), with the shortcode, the environment in use and your own business name on the line
  below. `GET /api/auth/me` carries `shortcode` and `safaricomName` for the active environment.

## 0.13.4 — Advanced is a page

- Advanced is a plain menu item under Manage that opens a page of cards, grouped Get paid and Pay
  out: Standing orders, Express checkout, Bonga points, Bulk send, Reverse a payment. Each card
  opens the real page. The fold from 0.13.2 is gone.
- People leaves the menu; it is reached from Settings › Organisation › Who can log in.
- Settings › Organisation shows the name Safaricom holds for each shortcode and says when the
  business name is still the starting one. Environment labels read Sandbox and Production, without
  "test money" or "real money".

## 0.13.2 — an Advanced fold in the menu

- Five destinations used rarely or set up once (Standing orders, Express checkout, Bonga points,
  Bulk send, Reverse a payment) fold under Advanced at the bottom of the menu, grouped as Get paid
  and Pay out inside it. The fold remembers whether you opened it and opens itself when you are
  on one of its pages. The everyday menu is ten items.

## 0.13.1 — the menu follows the day

- Menu regrouped by how a business uses it: Home and History first, then Get paid (Ask a customer
  to pay, Money in, QR codes, Invoices, Standing orders, Express checkout, Bonga points), Pay out
  (Send money, Bulk send, Waiting for approval, Reverse a payment), Manage (People, Settings).
- Business name and contacts are edited at the top of Settings; the name in the menu updates at once.
- "Delete this studio" no longer sits in the header account menu. It stays at the bottom of the
  Account page, behind the owner's password and the name typed back.

## 0.13.0 — standing orders, express checkout, Bonga points

- Standing orders (M-Pesa Ratiba): set one up for a customer, they agree once on their phone,
  Safaricom collects on the schedule; the page says plainly that nothing can be changed afterwards.
- Express checkout: prompt another business's till to pay your paybill.
- Bonga points: see what a customer's points are worth, then let them pay with them; the payment
  arrives through Money in. Every menu item is now live. New: `POST /api/collect/ratiba`,
  `POST /api/collect/express`, `POST /api/collect/bonga/calculate`, `POST /api/collect/bonga/redeem`;
  callbacks `/cb/<secret>/ratiba` and `/cb/<secret>/express`.

## 0.12.0 — invoices

- Invoices, through Safaricom Bill Manager: set up once (owner, password), then send an invoice
  by SMS with a pay prompt, one at a time or many from a list; cancel unpaid ones; see payments
  land against them the moment Safaricom reports them, and in History; record a payment made
  another way so reminders stop; open, overdue, paid and cancelled views. New: routes under
  `/api/invoices`; callback `/cb/<secret>/billmanager`; Settings › Invoices.

## 0.11.0 — bulk send

- Bulk send: paste a list or upload a CSV (phone, amount, name, note), check it, and send it with
  one password. Every row is checked before anything moves; each row then goes out in turn as an
  ordinary send, so the duplicate guard, the cap and the approval hold all apply; a failed row never
  stops the rest. The batch page shows every row live, offers Retry for rows the studio refused
  before Safaricom, and a results download. New: `POST /api/send/bulk/check`, `POST /api/send/bulk`,
  `GET /api/send/bulk`, `GET /api/send/bulk/:id`, `POST /api/send/bulk/:id/retry`.

## 0.10.0 — a second pair of eyes

- Waiting for approval: Settings › Approvals holds any send at or above an amount you set until a
  second person releases or refuses it. Applies to everyone, the owner included; nobody can approve
  their own; a held send is refused after 24 hours. New Approver role in People, a count on the
  menu, and the Waiting for approval page. New: `PUT /api/settings/approval-threshold`,
  `GET /api/approvals`, `GET /api/approvals/count`, `POST /api/approvals/:id/release`,
  `POST /api/approvals/:id/refuse`.

## 0.9.0 — money in

- Money in: customers paying your paybill or till from their own phone now land in History and on
  the new Money in page. Turn on once (owner, password) to register the confirmation address with
  Safaricom; the studio checks every hour for any payment whose confirmation never arrived, and a
  button does the same on demand. New: `GET /api/money-in/status`, `GET /api/money-in/recent`,
  `POST /api/money-in/register`, `POST /api/money-in/check`; callbacks `/cb/<secret>/c2b/validate`
  and `/cb/<secret>/c2b/confirm`.
- History has a direction filter: in and out, money in, money out.

## 0.8.1 — a wizard you can walk back through

- Back keeps your answers: every step starts from what was saved (environment, what you need,
  organisation, shortcode, public address). Steps that hold a secret show "accepted" with
  Replace instead of blank fields; a proven passkey stays proven.
- Environment first, right after the owner, with a plain explanation and Sandbox recommended.
  Choosing Production during setup never asks for the shortcode to be typed back; that guard
  applies only to a finished studio switching to real money.
- What you need: Receive (C2B, most common, nothing extra), Send (B2C/B2B, needs an API
  operator), and, on its own, the phone prompt (STK Push), the one option that needs a passkey.
- Public address is found from the browser's address bar and shown read-only, with Change;
  a failed test says the address is not this studio.
- The owner's name can be changed on the "Owner account created" screen.
- Only an operator Safaricom accepts is kept. One refused before it ever worked is removed, its
  reason shown once, and the same name is free to try again. The Done step names the step still
  missing and takes you there; the operator step no longer offers Skip.

## 0.8.0 — one question at a time, two pages fewer

- Every form with more than one input asks one question per screen: Back, Next, a counter, then
  the review or save. Send money, Ask a customer to pay, QR codes, Add somebody, Change password,
  every Settings edit, and the setup wizard's multi-field steps.
- Balances merged into Home (charges paid and the stale warning included); `/balances` opens Home.
- Look up a payment merged into History: type a receipt; if it was not sent from here, one button
  asks Safaricom about it and the answer shows there. `/lookup` opens History.
- A paid customer payment's page offers Reverse this payment, opening Reverse on the review step.
- Shortcodes are edited on the Account page only.

## 0.7.0 — your own payment categories, an account menu, one environment at a time

- Send money takes your own payment categories (Personal use, Rent, …); each sits on one of
  Safaricom's three kinds. Add, edit and delete them in Settings › Payment categories.
  New: `GET /api/send/categories`, `PUT /api/settings/send-categories`, `category` on a send.
- History shows seven rows a page with Previous and Next.
- Settings shows the settings of the mode you are in; switching Mode swaps them. No tabs.
- Header and sidebar stay fixed; only the content scrolls.
- One account button in the header: organisation and shortcodes, change password, log out, and
  Delete this studio (owner, password plus the organisation name typed exactly; returns the
  install to first-run setup). New: `POST /api/org/wipe`.
- "Not possible via API" sits last in the menu.

## 0.6.1 — one page, one job

- Header: the DS mark with the name in text; one line for the environment; a quiet Log out.
- Sidebar: one line per destination, grouped into Money and Manage; the seven unbuilt features
  fold behind "7 planned features".
- Home: your balances first, then the three most-used actions, then recent requests.
- Task pages (Send, Ask to pay, Look up, Reverse, QR) sit in one box with one primary button.
- Settings shows each value read-only and opens its form only when you press Change or Replace.
- Appearance follows your system by default; Light and Dark are a click away at the top of Settings.
- Wording cut to what changes what you do next.

## 0.6.0 — new look

- Light theme only, with one palette: Safaricom's green and neutrals plus the red and dark green of
  the Daraja Studio logo. A test refuses any other colour in the source.
- Components follow GitHub's Primer design: one-pixel borders, six-pixel corners, bordered cards
  with a muted header, pill labels, and banners with a leading icon.
- Menu grouped into Money and Manage, with the seven unbuilt items folded under Coming soon.
- Home opens with the three most-used actions as tiles.
- Guided setup shows "Step N of M", counts only the steps your answers need, and ends every step
  with the same Back and Next buttons.
- Animated line icons (line-md), bundled with the app.
- Logo and icons exported at the sizes they are shown at; square favicons and a home-screen icon.

## 0.5.0 — first public release

Self-hosted, single-organisation M-Pesa console. One install = one organisation = one shortcode.

- Guided first-run setup: what the business needs (pay out, take money in, or both), the Daraja
  app, the shortcode, the public address, and — only when the business takes money in — a passkey
  proved by a real Safaricom acknowledgement before the wizard will call it ready.
- Send money to a phone, with balance checks, duplicate protection and a five-attempt status sweep
  for anything Safaricom never answered.
- Ask a customer to pay (STK Push), with the result and receipt in History.
- Reverse a payment, guarded by the receipt of a settlement that can still be taken back.
- QR codes for a counter or a rider.
- Look up a payment by receipt, People with role-based permissions, and Settings for every
  Daraja credential, mirroring what the Safaricom organisation portal itself would show.
- Everything the Daraja API cannot do, listed honestly rather than left unexplained.
