# Changelog

## 0.55.1 — what a studio starts as, and what Simple leaves out

- **The tier is asked at setup.** A new step, *What this studio does*, sits between "What you need"
  and your organisation details, with **Business** already chosen. The three names, their sentences
  and what each turns on come from the same list the Organisation page draws, so the wizard cannot
  describe a tier differently from the page that changes it. It saves with the same writer and the
  same audit row, and every part of it stays changeable afterwards.
- **Simple now has nothing under Advanced.** Standing orders, Express checkout and Bonga points are
  declared as parts of their own — each with its sentence, its permission and its menu entry — and
  left out of the Simple set. Turning one off refuses its routes with 409 `module_off` naming it,
  and the Advanced page stops offering it. Business and Platform keep all three, as today.
- **Scheduled payments is declared, and not built.** *Scheduled payments* — "Pay the same people on
  a timetable" — sits in the same list, marked not built yet and standing on the money out it pays
  with, which is always on and has no switch, and on the contact book, which does. Off in Simple, a
  place in Business and Platform, so the work in the scheduled-payments design has somewhere to land.
  Custody is declared the same way under Platform, as it was in 0.55.0.
- **Nothing behind either of them.** No routes, no screens, no permission of their own: the page
  lists them with "Not built yet" where the switch would be, and asking the server to switch one
  answers 409 `not_built`.
- **Outbound webhooks stop while the Developer part is off.** Every waiting delivery keeps its place
  in the queue, its attempt count and its place on the retry curve, and switching Developer back on
  sends the whole backlog — so a pause cannot spend an attempt, give up on a delivery, or lose one.
  Notifications still record rows while their part is off, which is the opposite case: nothing there
  is ever sent anywhere.
- **What a part stands on can be a part of Studio that is always on.** Money out is the payments
  themselves and no tier or owner switch turns it off, so the page names it ("Needs: Money out ·
  Contacts") and it never holds anything back; a test keeps every tier's set, and every tier's
  planned parts, closed over the dependencies that *can* be switched off.

## 0.55.0 — what this studio does

- **One page decides which parts of Studio this organisation has.** Under Organisation, **What this
  studio does** lists every part — contacts, businesses and accounts, statements and arrears,
  invoices, people and roles, approvals, reports, reconcile, case files, reversal requests,
  notifications and push, the developer side, and the payment feed — each with its own switch, one
  plain sentence, the permissions and menu entry it adds, and what turning it off hides.
- **Off means hidden and refused, never deleted.** The menu stops offering it, and a page reached by
  its own address answers **409 `module_off`**, naming the part and pointing at this page, so the
  reason is legible. Every payment, contact, invoice and account stays exactly where it was, and
  turning the part back on brings the view back unchanged.
- **Three tiers, chosen and changed by the owner.** **Simple** for a shop or a stall, **Business**
  for the studio as it stands today, **Platform** for the developer side and the payment feed. A
  tier is a starting point, not a cage: any part can be switched on its own afterwards, and the page
  says what that leaves you with. Choosing a tier shows exactly what it will change before it is
  applied.
- **A part another one stands on cannot be switched off while the other is on**, and the line beside
  it names what is holding it: statements need businesses, approvals need people, the payment feed
  needs the developer side. Switching one on brings on what it stands on, and says which.
- **Custody is declared and not built.** Holding customer balances — wallets, the double-entry
  ledger, integrity checks and the float rule — is listed under Platform as the place the later work
  hangs, and there is nothing to switch there yet.
- **Every change is written to Who did what**, and every switch and every tier change asks for the
  owner's own password. An install that was already running the whole surface is on Platform from
  the moment it upgrades; a studio that has never chosen a tier starts on Business.

## 0.54.0 — register, or be fed

- **One question, two honest answers.** A paybill number has one pair of C2B confirmation addresses
  and they belong to whoever registered them, so Money in now asks *where do your paybill payments
  arrive today?* — **Studio receives them** (today's register flow, unchanged) or **another system
  receives them** and feeds Studio. The answer is a setting the owner can change later.
- **The inbox.** `POST /api/money-in/feed` takes Safaricom's own C2B confirmation body untouched —
  the same field names the callback carries — parses it with the same parser, and records the
  payment exactly as a confirmation would, the payer's name included. It is authenticated with a
  phase E API key whose role is **Forwarder**: that role may feed money in and do nothing else.
- **Idempotent on the receipt.** A payment already recorded by the feed, by Studio's own
  confirmation, or by the hourly pull is answered as a duplicate and changes nothing — so the feed
  and the pull can both run and a payment is never counted twice. Fed payments carry their own
  `result_source`, so every screen can tell the three apart.
- **A test that proves the path** before the first real payment: it records one test payment, sends
  the same body twice to show the receipt rule, and removes it — nothing reaches the books, the
  inbox or the webhooks. Money in shows the state and the last payment fed in.
## 0.53.0 — the missing payer names come back

- **Why they were missing.** This paybill's confirmation address belongs to another system, so Studio
  only ever sees those payments in the pull — and the pull writes `MPESA` where a person should be.
  Safaricom's own record of the payment still carries the payer: a status query by receipt returns
  `DebitPartyName`, for example `254115599147 - Bazil Mwendwa Wambua`.
- **Find the missing names**, on Money in, asks about five completed payments at a time; the same
  job runs by itself every fifteen minutes. It skips a receipt it asked about in the last six hours
  and skips any payment that already has a real name.
- **It is a read.** The query writes a check row and nothing else. The name is written onto the
  payment when Safaricom's answer arrives, on the status callback, and only the name is touched:
  status, amount and receipt stay exactly as they were, and a name already known is never overwritten.
- **A refused token is expected, not an error.** Studio and the other system on this Daraja app mint
  tokens that kill each other's, so a 401 stops the run and the next one tries again.
## 0.52.0 — the deliveries page

- **Advanced › Webhooks › Deliveries** lists everything Studio has sent to the address: what
  happened, how many tries it took, what your address answered and when the next try is due, with
  Waiting, Delivered, Given up and All to narrow it. Each row about a payment links to that payment.
- **Try again** puts a delivery back in the queue, which buys one more attempt rather than a fresh
  curve — so a receiver that was down for a day can be caught up by hand.
- **The developer side is complete under Advanced**: API keys, Webhooks and Deliveries, out of the
  way of daily use and owned by the owner alone.
## 0.51.0 — webhooks, signed and retried

- **One address per organisation is told when a payment finishes.** Studio posts the same facts its
  own page shows — the event, the amount, the receipt, the person, the times — as JSON, to an https
  address the owner sets under Advanced › Webhooks.
- **Every delivery is signed.** `X-Studio-Signature: t=<seconds>,v1=<signature>`, where the signature
  is HMAC-SHA256 of `t.body` with the organisation's own secret, so the receiver can refuse anything
  it did not come from and anything old enough to be a replay. Nothing about the secret or the
  signature is ever logged.
- **The retry curve is the one the plan asked for**: one minute, five minutes, thirty minutes, two
  hours, six hours, then twenty-four hours — six attempts, and after the sixth the delivery is left
  failed for a person to look at.
- **The secret is shown once**, when the address is set and when it is rotated; only its last four
  characters are kept on the page. An address inside this network is refused, so a webhook can never
  be pointed back at Studio itself.
## 0.50.0 — API keys, under Advanced

- **Another system can call this studio with a key.** A key carries one of your roles — Viewer may
  only look, Operator may send and look, Approver may look and release held sends — and may call
  exactly what that role may call. Anything that needs a person's password or PIN (sending money,
  reversing, changing settings) cannot be done with a key at all.
- **The secret is shown once.** Studio keeps only a hash of it, so a key that is lost is replaced,
  never looked up. Replace with a new key rotates it: the new secret is shown once and the old key
  stops working in the same moment. Stop this key revokes it for good.
- **Nothing about a key is ever logged.** Audit rows carry the name and the first characters; the
  secret, its hash and any signature never reach a log, an audit row or a list.
- **A key can never manage keys**, so a leaked key cannot mint its successor.
## 0.49.0 — buy airtime, and the honest edge of the API

- **Buy airtime is listed as a send type, with the truth on it.** Safaricom's M-Pesa API has no
  airtime command — not in B2C, not in B2B, and Lipa na Bonga redeems the customer's own points
  rather than buying anything — so Studio does not pretend it can buy airtime. The row says so and
  links to the card that explains where it is really bought.
- **Not possible via API gains the airtime card**: what it is, why it is not here, the portal path
  (Business Center › Buy Airtime) and the phone code (`*544#`).
- **A kind that cannot be built says so**, rather than sitting under Coming soon for ever.
## 0.48.0 — an unread critical alert keeps buzzing

- **A red line stands at the top of every page until it is read.** Something is wrong — the operator
  that sends has stopped working, or every operator is down — used to be one line in the inbox. It
  now shows on every screen, with `I have read it` as the way to clear it.
- **Until then Studio reminds about it every fifteen minutes.** Every open tab buzzes, and every
  device gets the same line again with "Still unread" in front of it and a fresh tag, so the phone
  shows the reminder rather than replacing the banner it already showed. Reading the alert is what
  stops it; after eight reminders Studio stops on its own rather than buzzing all night.
- **Only critical lines remind.** A failed payment or money that came in is written once and left in
  the list.
## 0.47.0 — the three charts on Reports

- **Reports draws the window as three pictures** above its tables: **money per day** as a pair of
  bars for each day, with the tallest bar being the window's own busiest day; **what happened** to the
  payments as paid, failed and needing a check; and the **success rate** as one bar with the share on
  top. No chart library: bars in the brand's own colours, sized from the same read the tables use, so
  a picture can never tell a different story from the numbers beside it.
- **Each chart carries a sentence** naming what it shows, so the three are readable without seeing the
  bars.
## 0.46.0 — a staff member asks for a reversal, the owner approves

- **A reversal asked for by somebody who may not approve it now waits.** The password records the
  request; it appears on Waiting with the held payments, and Safaricom is not asked until the owner
  — or anybody with the approval right — releases it. The owner, and anybody with `send.approve`,
  still reverse in one press, exactly as before.
- **Nobody releases their own request**, the same rule held sends already follow.
- **The reverse page says which of the two it is** before the password is typed, and the result
  names the wait with a link to Waiting. The release sends the reversal down the ordinary reversal
  path, so there is one way to Safaricom, not two.
## 0.45.0 — a case file on a payment that went wrong

- **Every payment has a case file under its timeline.** Open a case with one line about what went
  wrong, record what was done as it happens — each entry keeps who wrote it and when — and close it
  with how it ended. The closed case keeps every note and stays on the payment.
- **A case is paper.** Nothing on it moves money, changes the payment or sends anything: a reversal,
  a refund or a resend stays on the screen it always had. One open case per payment; a case already
  closed takes nothing more, and a new one can follow it if the payment goes wrong twice.
- **A new permission, `cases.manage`**, is what opening, recording and closing need; reading the case
  needs only the permission the payment's own page needs. The operator preset carries it.
## 0.44.0 — the first time you pay a number

- **The review screen says when this studio has never paid the number before**, beside the name
  Safaricom holds: "You have never paid this number before. Check the number and the name before you
  send." The first payment to a number is the one worth pausing over.
- **The answer comes from Studio's own rows**, so it is there even when Safaricom cannot name the
  number or has not switched the name check on. A payout Safaricom accepted counts as paid; one that
  failed paid nobody, and a pending or cancelled row never happened, so neither counts.
- **The manual's send step now describes the review as it is**: both balances, Working and Utility,
  with what Utility will hold after the send, and the first-time line.
## 0.43.0 — recent checks on History

- **History lists the checks Studio has made with Safaricom**, under the payments: a person pressing
  Check on a payment, a receipt looked up, and the checks Studio makes by itself — newest first, each
  with what Safaricom answered and a link to the payment it was about. A check moves no money, so it
  is listed apart from the payments rather than among them.
- **A check made by hand now records who asked**, and the list shows it.
- **The manual's reconciliation step is corrected with it**: the last two balances are added together
  and compared with the money that moved between them, because which float account Safaricom credits
  is Safaricom's to decide.
## 0.42.0 — both float balances, named

- **Home names both accounts**: Working, Utility, and what is still waiting to go out, on one line
  under the two figures. Money in lands in Working and sends leave Utility, so a single figure called
  "Balance" was never the whole answer — the owner moves float between the two.
- **When Utility cannot cover what is waiting, the line says how much to move from Working**, and
  keeps the plain fact that the float move itself is not built yet, so it is done in the Safaricom
  portal. When Working cannot cover it either, it says that instead of naming an amount.
- **The send review shows both accounts too**, so a person short in Utility sees what Working holds
  before giving up, with the same move line when Working can cover the send.
- **Two stale pointers fixed**: "Refresh in Balances" pointed at a page that no longer exists; it now
  says Home, where the balances are.
## 0.41.0 — check nothing is missing

- **One page compares Safaricom's own record with Studio's.** Pick a window and press Check: Studio
  pulls Safaricom's transactions for those days and lists, first, what Safaricom shows and Studio has
  no row for, with the receipt, the amount, the payer and the account they typed; and second, what
  Studio recorded that the pull did not return.
- **The balances Safaricom reported are checked too**: money in lands in Working, payouts and their
  charges leave Utility, so the last two readings are compared with the money that moved between
  them and any difference is stated, never hidden.
- **It is a read.** Nothing found is recorded, corrected or applied by this page — Check for missed
  payments, on Money in, is the press that records one.

## 0.40.0 — statements and who is behind

- **Every account has a running statement**: each payment in, each payout out and each invoice
  raised, oldest first, built only from rows that exist — never from money Studio holds, because it
  holds none. One plain line sits on top: **paid to date, and still owed**.
- **The standing amount per account** is what a period expects — the rent, the fee, the monthly
  contribution — set by the owner on the account itself. Where the kind of business says money is
  expected regularly and an amount is set, the statement says how many periods are behind, and the
  business lists **who is behind**, the furthest first, with the oldest unpaid invoice beside each.
  A kind that expects nothing regular gets the statement with no arrears at all.
- **One press to raise the next invoice**, for the standing amount and the coming period, and **one
  press to write a reminder**: the message names the person, what is owed, the business and the
  account number, and is recorded on the account. Safaricom has no reminder call and Studio has no
  line of its own to a phone, so the message is the owner's to send — copied, or opened in their own
  messages.
- **Nothing is ever charged on its own, and nothing moves without a person pressing Send.** The
  statement only reads; the invoice press raises a demand, not a payment.

## 0.39.0 — what kind of business this is

- **A business is asked what kind it is**, as it is made, and the answer is data: a row in
  `business_types` with a template, seeded into the organisation and editable by the owner. Nine
  ship — rental or property, clinic or health, church or religious, school, shop or retail, services
  or freelance, savings group or chama, transport, and Other, which is neutral and turns nothing on.
- **The template sets eight things**: what an account is called, what an account under another is
  called, whether money is expected regularly and how often, whether each account stands for a set
  amount, the payment categories, what happens with invoices and reminders, what Home leads with,
  and what the business's statement is called. The words are the owner's to type; the four that are
  behaviour are chosen from a list, because each is wired to something Studio does.
- **The words follow the business**: "Add a tenant", "3 tenants", "Rooms or units under Jane", the
  leading line on Home ("Who is behind: 3 tenants"), the Invoices screen, and Reports, which is the
  business's statement by name — "Rent statement", "Fee statement", "Giving record".
- **Change the kind afterwards**, or edit the words in it, and add a kind of your own: a new kind of
  business needs no new version. Changing the kind changes words only — accounts, numbers, and every
  payment that already names a business stay exactly as they are.

## 0.38.0 — names, everywhere

- **A name on every row, whichever way the money went.** Studio already received far more names than
  it showed: a paybill payment arrives with up to three name parts, a payout result repeats the
  person's name, and a status result names both sides. Each of those is now read, cleaned in one
  place and stored — so a payment shows who paid and a payout shows who was paid, on Home, History,
  the request card and Waiting.
- **The name leads, the number sits under it.** Safaricom's party names arrive as
  `"254712345678 - JANE DOE"`; the repeated number is dropped and the name becomes the headline.
  Money in says **From** and money out says **To**, taken from the row's own direction rather than
  guessed by each screen.
- **A saved contact no longer hides Safaricom's name.** When the two differ, both are shown — the
  mismatch is exactly what the owner needs to see.
- **A payout is named from the moment it is sent**, from the saved contact, then the account it is
  for, then the name Safaricom confirmed on the review screen.
- **Money in shows all of it**, not only paybill payments: an express ask, a Bonga redemption, an
  invoice payment and a standing order are all money in. The Pull API's `MPESA` placeholder is
  read as "no name" rather than a person, and an invoice payment is named from the account it was
  billed to.

## 0.37.0 — the operator pool, the rest of it

- **One request in flight per operator.** A send takes a short lease on the operator that signs it,
  so a batch going out on a credential Safaricom has just started refusing cannot burn both tries in
  the same second. The lease goes back the moment Safaricom answers, and it runs out on its own if a
  process dies holding it — the queue drains instead of stalling behind it.
- **A refused send moves to the next operator.** When Safaricom turns a payment down with a
  credential code (2001, 8006, TP40153) and another verified operator is attached, the same row goes
  out again with that one — on the send path and when the refusal arrives as a result callback. The
  row keeps its number, its links and its author, and nothing final is written for an attempt that is
  about to be repeated.
- **A word when nothing is left.** When the last verified operator goes down, one critical line
  reaches the inbox and the phone: “No working operator left. Payments out cannot go until you fix
  one.”, linked to the operator cards.

## 0.36.0 — a fingerprint that looks like one

- The fingerprint icon is Studio's own drawing now: three concentric ridges around a core loop, on
  the same 24 px box and 1.6 round stroke as the other two keypad icons.
- It is drawn in the brand's own pair — the green token carries the ridges and the red one marks the
  core, the same two colours as the logo — so it reads as branded, never as a warning.
- The same component shows wherever the fingerprint is offered: the lock screen's key, the card that
  offers it, and every device listed under Organisation.

## 0.35.0 — the full logo on both PIN screens

- The lock screen shows the **full Daraja Studio logo** where the letter square and the separate
  name line used to be, with "Locked. Enter your PIN to continue." right under it.
- The money sheet carries the same logo, **small at 24 px**, so the six dots and all twelve keys
  still fit a small phone. If a screen is too short to show the whole sheet, it scrolls instead of
  cutting off the heading.

## 0.34.0 — the SDK's own words for TP40153

- `@kepas/daraja-js` **1.6.3 carries `TP40153`** in its own result-code catalog for b2c, b2b, balance
  and reversal, so Studio no longer keeps its own copy of what the code means: the cause — the API
  operator has no permission for this API, or is not in this organisation — now comes from the SDK.
- **Studio still says the one thing the SDK cannot know**: what the refusal means for the money.
  Every credential refusal keeps the line "The payment itself did not fail, and no customer's money
  moved.", and the action still says to give this operator a new credential and press Reinstate.

## 0.33.0 — the lock screen, and a fingerprint

- The lock screen is now the one the owner asked for: the studio's mark, six dots filling as you
  type, and a round-keyed keypad. **The sixth digit sends by itself** — there is no button — with a
  small buzz on every key, 25/40/90 on a successful open and 60 on a refusal. A wrong PIN, a locked
  PIN ("Try again in N min.") and a slow network each say so on the line above the keypad.
- **A fingerprint opens it too**, on a phone that has one. Studio asks once, in the page and never in
  a browser dialog; "Not now" is remembered on that device. The answer is verified on the server
  against the public key enrolled here, with the origin, the challenge and the signature counter
  checked — a counter that goes backwards is refused and the credential is left alone. Any refusal
  falls back to the PIN without a word.
- Organisation lists the devices with a fingerprint and removes one behind the password; **removing
  the PIN removes them all**. Money still asks for the PIN or the password, never a fingerprint on
  its own, and nothing about a credential — no identifier, no key, no counter — is ever logged.

## 0.32.0 — a PIN lock for the phone

- Studio can now be locked behind a **6-digit PIN**, set under Organisation with your password. It is
  asked when the page comes back from the background and after 30 quiet minutes, and while it is owed
  the app is not on screen at all.
- The PIN is **scrambled with the same argon2 as a password** and never stored, shown or logged. Five
  wrong tries lock it for 15 minutes.
- It also replaces the password on anything that moves money or changes who can: six digits instead
  of a long password on a phone. **Your password always works instead**, so a forgotten PIN is never
  a locked door.
- The lock is held by the server, not the screen: the session in Postgres is unlocked or not, so a
  money action or a request for money from a locked session is refused outright, and a page that is
  never touched locks itself after 30 minutes.

## 0.31.0 — accounts, sub-accounts, and a delete that really deletes

- The thing money comes in for is an **account**, and the thing under it a **sub-account**: a clinic,
  a room, a tenant, a church, a class. The page, the buttons, the guide and the API all say so; the
  digits are the account number at every level.
- **Delete** now means delete. Deleting an account or a sub-account removes it and everything under
  it, and its number goes back into the pool — the next account can be given the same digits. A
  business can be deleted once it has no accounts left, and its code is free again.
- Studio hands out the **shortest free number first**, so a number freed by a delete is used again
  before any longer one is opened.
- What is not lost is who held a number: a record keeps the digits, the name, the level and the
  dates. Old History rows say **was <name>, deleted <date>**; a number handed out again explains
  itself for a year ("This number belonged to <name> until <date>"); and every account can show
  **Past holders of this number**.
- Deleting asks for the same ceremony as deleting the studio: type the exact name, then your
  password. A wrong name or a wrong password deletes nothing.
## 0.30.0 — Home says when something is wrong

- Home now puts **Something is wrong** above everything else when it is: the operator Studio sends
  with has stopped working, Safaricom has not answered any payment for ten minutes while sends are
  still waiting, or the last balance check was refused.
- One sentence and one link to the page that puts it right — Settings for an operator or a refused
  balance, Waiting for payments that got no answer. It goes away by itself when the trouble does;
  there is nothing to dismiss.
- The owner also sees the line under it (which operator, how long), because fixing it is theirs.
  Everybody else gets the sentence alone, and the server does not send them the specifics at all.
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
