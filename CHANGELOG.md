# Changelog

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
