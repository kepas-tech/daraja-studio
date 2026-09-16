# Changelog

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
