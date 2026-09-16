# Changelog

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
