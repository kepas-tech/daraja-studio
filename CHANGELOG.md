# Changelog

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
