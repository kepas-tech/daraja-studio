# How to use Daraja Studio

Every page, in the order you meet them, from the first run to the last card. Each task is numbered the way the screens go.

A copy for AI agents and scripts, no login needed: /guide.md · This file is that copy.

## Contents

- What Daraja Studio is
- Before you start: what to have ready
- First-run setup
- Logging in and finding your way
- Home
- History
- Get paid
- Pay out
- Settings
- People
- Account
- Reading a result
- What the API cannot do
- For AI agents and scripts

## What Daraja Studio is

A console for one M-Pesa paybill or till, in plain English. One install is one organisation and one number.

### The idea

1. Studio mirrors the Safaricom organisation portal wherever the Daraja API allows, and lists what the API cannot do.
2. Every page title carries Safaricom’s own name for the thing in grey underneath, so you can find it in Safaricom’s portal or documents.
3. Sandbox is Safaricom’s practice area with pretend money. Production is your real M-Pesa account. The menu says which one you are in.
4. Every form asks one question per screen, with Back and Continue. The last button says Review, then the verb (Send, Ask for payment, Create).
5. Your password is asked for anything that moves money or changes who can.

## Before you start: what to have ready

Everything comes from Safaricom. Gather it once; the setup asks for it in this order.

### From Safaricom

1. Your paybill or till number, as on your Safaricom letter.
2. A Daraja app: the consumer key and consumer secret from the Daraja developer portal, under My Apps.
3. A public https address for this studio (the one you open in your browser). Safaricom posts payment results to it.
4. If you will send money out: an API operator from the Safaricom portal, plus either its password and the Safaricom certificate (.cer), or a Security Credential generated on the Daraja portal.
5. If you will prompt a customer’s phone to pay: the STK passkey from the Daraja portal, under Lipa Na M-Pesa Online for this number.

- Creating operators, giving them roles and resetting their portal passwords happen only in the Safaricom portal. See "Not possible via API".

## First-run setup

The first person to open a new install becomes the owner and walks through up to ten steps. Back keeps your answers. Every step saves before moving on, so you can stop and come back.

### The steps

Page: /setup · Who: Owner

1. Owner: your name, a username and a password of 12 or more characters. The name can be changed on the "Owner account created" screen; the username stays.
2. Environment: Sandbox or Production. Start with Sandbox if you are still testing; switch later in Account.
3. What you need: tick Receive money from customers, Send money to people or businesses, or both. A separate tick, "Prompt a customer’s phone to pay", is the one thing that needs a passkey. Your ticks decide which of the later steps appear.
4. Your organization: business name, nominated number and notification phone (2547…). Shown in the menu and on receipts.
5. Shortcode: your paybill or till number. Studio checks it with Safaricom and shows the name Safaricom holds for it.
6. Daraja app: consumer key and secret. Studio tests them at once; "accepted" means Safaricom said yes.
7. Public address: found from your browser’s address bar and shown read-only. Press Change only if people reach this studio through another domain. Test this address proves Safaricom can reach it.
8. STK passkey (only if you ticked the phone prompt): paste it and give your own phone number. Studio sends one KES 1 prompt to your phone; you may cancel it. Safaricom accepting the request is the proof.
9. API operator (only if you send money): the operator username as in the Safaricom portal, then either its password plus the certificate text, or a Security Credential. Studio tests it with a balance query and keeps it only if Safaricom accepts it. A refused one is removed and the name is free to try again.
10. Done: says "All set", or names the step still missing and takes you there. Finish opens Home.

| Method | Path | Who |
|---|---|---|
| GET | `/api/setup/status` | anyone, before setup is complete |
| POST | `/api/setup/owner` | first person |
| POST | `/api/setup/environment` | owner |
| POST | `/api/setup/uses` | owner |
| POST | `/api/setup/org` | owner |
| POST | `/api/setup/shortcode` | owner |
| POST | `/api/setup/daraja` | owner |
| POST | `/api/setup/public-url` | owner |
| POST | `/api/setup/public-url/test` | owner |
| POST | `/api/setup/passkey` | owner |
| POST | `/api/setup/operator` | owner |
| POST | `/api/setup/complete` | owner |

## Logging in and finding your way

### Log in

Page: /login · Who: Anyone with an account

1. Type your username and password and press Log in.
2. A temporary password (the one the owner gave you) must be replaced first: type it, then your new password of 12 or more characters, twice.
3. Too many wrong tries locks the account for 15 minutes.

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/login` | anyone; answers with a csrf token and sets the session cookie |
| GET | `/api/auth/me` | signed in; who you are, your permissions, the organisation and the environment in use |
| POST | `/api/auth/change-password` | signed in |
| POST | `/api/auth/logout` | signed in |

### The menu

1. The left menu shows your business name, your paybill or till number and the environment in use.
2. Home and History come first. Then Get paid (Ask a customer to pay, Money in, QR codes, Invoices), Pay out (Send money, and Waiting for approval while approvals are on), and Manage (Settings, Advanced).
3. Advanced opens a page of cards for things set up once or used now and then: Standing orders, Express checkout, Bonga points, Bulk send, Reverse a payment.
4. Below the rule: How to use (this page) and Not possible via API.
5. The account menu, top right under your name, has Organisation & shortcodes, Change password and Log out.

## Home

### Balances and the day’s shortcuts

Page: / · Who: Anyone signed in

1. The heading is the name Safaricom holds for your number, with the number, the environment and your own business name on the line under it.
2. Utility account pays phones; Safaricom’s fees come from it. Working account holds customer payments and pays paybills and tills.
3. Refresh asks Safaricom for today’s balance. "As of" says when it was last read; "Charges paid" is the fees so far. A balance more than a day old is flagged.
4. Three tiles open the most used pages: Send money, Ask a customer to pay, History.
5. Recent requests shows the last five; View all opens History.
6. If something is still missing, Home says so at the top: no API operator (you cannot send yet), public address not tested (Safaricom cannot reach you), STK passkey not set (Ask a customer to pay is off).

| Method | Path | Who |
|---|---|---|
| GET | `/api/balances/latest` | signed in |
| POST | `/api/balances/refresh` | balances.view |
| GET | `/api/requests?limit=5` | lookup.view |

## History

### Find a payment

Safaricom calls this: Account Statement · Page: /history · Who: Anyone signed in

1. Type a phone number, a name or an M-Pesa receipt in the search box.
2. Narrow by date (from, to), by direction (In and out, Money in, Money out) and by status (Paid, Waiting, Failed, Needs a check, Preparing, Cancelled).
3. Seven rows a page; Previous and Next at the bottom.
4. Press a row to open the request page: amount, who, receipt, when, and the timeline (Created, Sent, Result) with where the result came from.
5. A receipt that was not sent from here shows "This receipt was not sent from here" and a button, Ask Safaricom about this receipt. The answer lands on the same page within a few minutes.

| Method | Path | Who |
|---|---|---|
| GET | `/api/requests` | lookup.view; filters as query strings |
| GET | `/api/requests/:id` | lookup.view |
| POST | `/api/lookup` | lookup.view; body { receipt } |

### On a request page

Page: /requests/:id

1. Needs a check means Safaricom never answered. Press Check with Safaricom now; Studio also checks on its own five times.
2. Mark as checked records what you found by other means (for example, "Paid, seen in the portal").
3. Send again reopens Send money with the same details (nothing is sent until you go through Review again). Reverse this payment opens Reverse with the receipt filled in, for a paid customer payment.

| Method | Path | Who |
|---|---|---|
| POST | `/api/requests/:id/check` | signed in |
| POST | `/api/requests/:id/checked` | lookup.view, password; body { note } |

## Get paid

Money coming in. Nothing here takes money from your accounts.

### Ask a customer to pay

Safaricom calls this: STK Push · Page: /ask-to-pay · Who: Owner, Operator (stk.request)

1. Customer’s phone number.
2. Amount in KES, whole shillings.
3. What is this for? An invoice or order number, shown to the customer and on your statement.
4. Short description, optional, up to 13 characters, shown on the prompt.
5. Review, then Ask for payment. The customer has about a minute to enter their M-Pesa PIN.
6. The page waits and then says Paid or Not paid; the receipt goes to History. Ask someone else starts over.

- Asking the same number for the same amount twice in a row is questioned first: "You asked for this already at … Ask again?"
- Needs the STK passkey (Settings). Without it the page is off and Home says so.

| Method | Path | Who |
|---|---|---|
| POST | `/api/collect/stk` | stk.request; body { phone, amountCents, reference, description? } |

### Money in

Safaricom calls this: C2B · Page: /money-in · Who: Owner turns it on; anyone signed in reads it

1. Turn on once. Studio tells Safaricom where to post customer payments; the page re-reads on its own and then says "On since …" or shows Safaricom’s refusal in three lines.
2. If Safaricom says the addresses were already on record, that counts as on. Should a payment then never show, an older address may be on record; Safaricom API support can reset it.
3. Every customer payment to your number then shows here and in History the moment Safaricom reports it.
4. Check for missed payments asks Safaricom for anything whose report never arrived. Studio does the same every hour on its own.

- Every payment is accepted. Safaricom only asks Studio to approve payments if its support team has switched that on for your number.
- Test the public address in Settings first; Safaricom must be able to reach this studio.

| Method | Path | Who |
|---|---|---|
| GET | `/api/money-in/status` | money_in.view |
| GET | `/api/money-in/recent` | money_in.view |
| POST | `/api/money-in/register` | owner, password; answers 202 and works in the background |
| POST | `/api/money-in/check` | money_in.view |

### QR codes

Safaricom calls this: Dynamic QR · Page: /qr · Who: Owner, Operator (qr.generate)

1. How customers pay: Pay Bill or Buy Goods (till).
2. Payment reference: an order or account reference, up to 32 characters.
3. Who sets the amount: a fixed amount, or the customer enters it.
4. Amount in KES (when fixed). Create QR code shows the code to print or show on a screen.

- A scan does not confirm payment. Check your M-Pesa confirmation, or Money in.

| Method | Path | Who |
|---|---|---|
| POST | `/api/qr` | qr.generate |

### Invoices

Safaricom calls this: Bill Manager · Page: /invoices · Who: Owner sets it up; Owner, Operator (invoices.manage) send and cancel

1. Set up once per environment (owner): business email, official contact phone, whether Safaricom should send payment reminders, then your password.
2. New invoice: customer name, customer phone, what the invoice is for, account reference (up to 20 characters; payments are matched by it), billed period, due date, line items (optional, one per line: name, amount), amount. Send the invoice: the customer gets an SMS with a pay prompt.
3. Many at once: one line per invoice (name, phone, invoice name, account, period, due date as YYYY-MM-DD, amount). Studio checks every line, then Send them all.
4. Show Open, Overdue, Paid, Cancelled or All; search by name, reference or account.
5. Open an invoice to see its payments. Cancel this invoice stops it; select several to Cancel them together.
6. Record a payment made another way (cash, bank): when, how much, a reference, who paid. Safaricom is told, so reminders stop.

- Payments through M-Pesa land against the invoice the moment Safaricom reports them, and in History as "Invoice paid".

| Method | Path | Who |
|---|---|---|
| GET | `/api/invoices/settings` | invoices.manage |
| POST | `/api/invoices/opt-in` | owner, password |
| GET | `/api/invoices` | invoices.manage |
| GET | `/api/invoices/:id` | invoices.manage |
| POST | `/api/invoices` | invoices.manage |
| POST | `/api/invoices/bulk/check` | invoices.manage |
| POST | `/api/invoices/bulk` | invoices.manage |
| POST | `/api/invoices/:id/cancel` | invoices.manage |
| POST | `/api/invoices/cancel` | invoices.manage; body { ids } |
| POST | `/api/invoices/:id/payment` | invoices.manage |

### Standing orders

Safaricom calls this: M-Pesa Ratiba · Page: /standing-orders · Who: Owner, Operator (standing_orders.manage)

1. Press New standing order.
2. A name for this order (shown to the customer; one name per customer).
3. Customer’s phone number.
4. Amount each time, in KES.
5. How often: once, every day, week, month, two months, three months, six months or year.
6. First collection date, then last collection date.
7. Account reference (what the payments are for, up to 12 characters), then a short note (optional, up to 13 characters).
8. Review, then Create the standing order. The customer gets a prompt to agree; the page updates on its own.

- Once agreed, nothing about the order can be changed. To change it, create a new one and ask the customer to stop the old one on their phone.
- Each collection shows in History as money in.

| Method | Path | Who |
|---|---|---|
| POST | `/api/collect/ratiba` | standing_orders.manage |

### Express checkout

Safaricom calls this: B2B Express Checkout · Page: /express · Who: Owner, Operator (express.checkout)

1. Their till or paybill number: the business that is paying you.
2. Amount in KES.
3. What is this for? An order or invoice number, shown on their prompt.
4. Your name as they know you, optional.
5. Review, then Ask for payment. They approve on their phone; the money arrives in your paybill.

| Method | Path | Who |
|---|---|---|
| POST | `/api/collect/express` | express.checkout |

### Bonga points

Safaricom calls this: Lipa na Bonga · Page: /bonga · Who: Owner, Operator (bonga.redeem)

1. How many points? Studio shows what they are worth at Safaricom’s current rate.
2. Customer’s phone number.
3. What is this for? An order or invoice number; the payment is matched to it.
4. Review, then Send the prompt. The customer enters their M-Pesa PIN to pay with points.

- Safaricom pays the shilling value into your paybill the same way a customer payment arrives, so Money in must be on.

| Method | Path | Who |
|---|---|---|
| POST | `/api/collect/bonga/calculate` | bonga.redeem; body { points } |
| POST | `/api/collect/bonga/redeem` | bonga.redeem |

## Pay out

Money leaving your accounts. Every send asks for your password.

### Send money to a phone

Safaricom calls this: Initiate Transaction › Business Payment to Customer · Page: /send/phone · Who: Owner, Operator (send.phone)

1. Open Send money and press To a phone. (The other kinds, to a business wallet, a paybill, a till, float moves, top-ups and KRA, say Coming soon.)
2. Phone number.
3. Amount in KES, whole shillings.
4. What kind of payment is this? One of your own categories (Settings › Payment categories); each maps to Safaricom’s Business payment, Salary or Promotion.
5. Note, optional.
6. Review: Utility balance now and after, the fee note, and the per-send cap if one is set. Safaricom cannot check the name before sending, so check the number.
7. Send, then your password. The page says Sent, then Paid or Not paid; the receipt goes to History.

- The same amount to the same number twice in a row is questioned first: "You sent this already at … Send again?"
- When Settings › Approvals is on and the amount is at or above the threshold, the send is held for a second person instead of going out. Nothing leaves your account until it is released.
- Needs a working API operator (Settings). Without one Home says you cannot send yet.

| Method | Path | Who |
|---|---|---|
| GET | `/api/send/categories` | signed in |
| POST | `/api/send/phone` | send.phone, password; body { phone, amountCents, category, remarks? } |

### Bulk send

Safaricom calls this: Bulk Task › Bulk Payment · Page: /bulk · Who: Owner, Operator (bulk.send)

1. Paste the list into The list, one line per person: phone, amount, name, note (the first two are needed), or Upload a file (CSV). Download a template gives the layout.
2. Check the list. Every line is checked before anything moves; lines that need fixing are named. Nothing is sent until all pass.
3. Send them all, then your password. Each row goes out in turn as an ordinary send, so the duplicate guard, the cap and the approval hold all apply; a failed row never stops the rest.
4. The batch page shows every row live. Try the failed rows again resends only rows Studio refused before Safaricom. Download results gives a CSV.
5. Batches lists every earlier batch.

| Method | Path | Who |
|---|---|---|
| POST | `/api/send/bulk/check` | bulk.send |
| POST | `/api/send/bulk` | bulk.send, password |
| GET | `/api/send/bulk` | bulk.send |
| GET | `/api/send/bulk/:id` | bulk.send |
| POST | `/api/send/bulk/:id/retry` | bulk.send, password |

### Waiting for approval

Safaricom calls this: Review Transaction · Page: /approvals · Who: Approver (send.approve) releases or refuses; anyone signed in sees the count

1. Turn it on in Settings › Approvals: hold sends of this amount or more (0 turns it off). It applies to everyone, the owner included.
2. Give somebody the Approver role in People, or nothing can be released.
3. The menu shows Waiting for approval, with a count, while approvals are on or a send still waits.
4. Each held send shows the amount, who it is to, the category and note, who made it and when. Release asks for your password and sends it. Refuse asks why; the maker sees the reason.
5. Nobody can release or refuse their own send. A held send is refused on its own after 24 hours.

| Method | Path | Who |
|---|---|---|
| GET | `/api/approvals` | send.approve |
| GET | `/api/approvals/count` | signed in; { count, enabled } |
| POST | `/api/approvals/:id/release` | send.approve, password |
| POST | `/api/approvals/:id/refuse` | send.approve; body { reason } |
| PUT | `/api/settings/approval-threshold` | owner, password; body { cents } |

### Reverse a payment

Safaricom calls this: Reversal · Page: /reverse · Who: Owner, Operator (reverse.request)

1. Type the M-Pesa receipt (10 letters and numbers) and press Find that payment. Only a payment that settled here can be reversed.
2. Check the amount and the receipt: a reversal cannot be undone.
3. Reverse, then your password. Safaricom takes the money back from the customer; the page says Reversed or Not reversed, and the reversal shows in History.

- Safaricom can only take back money the customer still has. If it is spent, the reversal is refused.

| Method | Path | Who |
|---|---|---|
| GET | `/api/send/reversal/:receipt` | reverse.request |
| POST | `/api/send/reversal` | reverse.request, password |

## Settings

Every value is shown read-only. Press Change or Replace to edit it; saving asks for the owner’s password.

### Organisation

Safaricom calls this: My Preference · Page: /settings · Who: Owner edits; anyone signed in reads

1. Business name and contacts: the name in the menu and on receipts, the nominated number and the notification phone.
2. Public address: the https address Safaricom posts to. Test it after any change.
3. Safaricom verification: for Sandbox and Production, whether the number, the Daraja key and secret, and a working API operator are in place.
4. Who can log in: Manage people opens the People page.
5. Safaricom callback addresses: the Safaricom IP addresses Studio accepts payment reports from. Change only if Safaricom publishes new ones.
6. Callback secret: part of the address Safaricom posts to. Show the callback secret asks for your password; treat it like a password.
7. Appearance: System, Light or Dark.

| Method | Path | Who |
|---|---|---|
| GET | `/api/settings` | owner |
| PUT | `/api/settings/org` | owner, password |
| PUT | `/api/settings/public-url` | owner, password |
| POST | `/api/settings/public-url/test` | owner |
| PUT | `/api/settings/allowlist` | owner, password |
| POST | `/api/settings/install-secret/reveal` | owner, password |

### Sandbox settings and Production settings

Who: Owner

1. Studio shows the settings of the environment you are in. Switch environments in Account.
2. Daraja app: consumer key (last four shown) and secret; Replace tests the new pair before saving it.
3. B2C API version: Automatic (recommended), v1 or v3.
4. STK passkey: Replace; the new one is tested with a KES 1 prompt to your phone.
5. Certificate: the Safaricom .cer text, needed only when adding an operator by password.
6. API operators: Add operator (by password and certificate, or by Security Credential), Test again (a balance query), New password or New credential, Turn off. The password expiry date Safaricom set is shown.

| Method | Path | Who |
|---|---|---|
| POST | `/api/settings/environments/:env/daraja` | owner, password |
| PUT | `/api/settings/environments/:env/b2c-api` | owner, password |
| POST | `/api/settings/environments/:env/passkey` | owner, password |
| GET | `/api/settings/environments/:env/operators` | owner |
| POST | `/api/settings/environments/:env/operators` | owner, password |
| POST | `/api/settings/operators/:id/probe` | owner |
| POST | `/api/settings/operators/:id/rotate` | owner, password |
| POST | `/api/settings/operators/:id/disable` | owner, password |

### Payment categories, Approvals, Invoices

Who: Owner

1. Payment categories: your own names for a send (Personal use, Rent, …); each goes to Safaricom as Business payment, Salary or Promotion. Add, Edit, Delete; keep at least one.
2. Approvals: Second person, Off or "Hold sends of KES … or more". Change, type the amount, save with your password.
3. Invoices: whether invoicing is set up and whether reminders are on. Set it up from the Invoices page.

| Method | Path | Who |
|---|---|---|
| PUT | `/api/settings/send-categories` | owner, password |

## People

### Who can log in

Safaricom calls this: Organization Operator · Page: /people · Who: Owner

1. Open Settings › Who can log in › Manage people, or go to /people.
2. Add somebody: their name, a username, what they may do, and a temporary password (Suggest another gives a new one). Add them, then your password.
3. Tell them the temporary password yourself; Studio shows it once. They must change it at first login.
4. Roles: Owner does everything. Operator can send money and ask customers to pay. Viewer can only look. Approver can release or refuse held sends.
5. On each person: change what they may do, New temporary password, Switch off (they cannot log in) and Switch on.

- These are Studio logins. Safaricom portal operators are separate and are managed in the Safaricom portal.

| Method | Path | Who |
|---|---|---|
| GET | `/api/people` | signed in |
| POST | `/api/people` | owner, password |
| PUT | `/api/people/:id/role` | owner, password |
| POST | `/api/people/:id/reset-password` | owner, password |
| POST | `/api/people/:id/suspend` | owner, password |
| POST | `/api/people/:id/resume` | owner, password |

## Account

### Organisation & shortcodes

Page: /account · Who: Owner

1. Open the account menu (top right) and press Organisation & shortcodes.
2. Mode: Sandbox for testing, or Production. Switching a finished studio to Production asks you to type the paybill or till number back, then your password.
3. Shortcodes: the paybill or till number for each environment, with Change. Check the name with Safaricom fetches the name Safaricom holds and whether it is a paybill or a till.
4. Change password, from the same menu: your current password, then the new one twice.
5. Delete this studio, at the bottom: removes the organisation, its people, credentials and history and returns the install to first-run setup. It asks for your password and the organisation name typed exactly. It cannot be undone.

| Method | Path | Who |
|---|---|---|
| PUT | `/api/settings/mode` | owner, password |
| PUT | `/api/settings/environments/:env/shortcode` | owner, password |
| POST | `/api/settings/environments/:env/shortcode/verify` | owner |
| PUT | `/api/auth/display-name` | signed in |
| POST | `/api/org/wipe` | owner, password, name typed |

## Reading a result

### The status words

1. Preparing: Studio has the request and is about to send it to Safaricom.
2. Waiting: Safaricom has it and has not answered yet. Most answers come within seconds; a phone prompt waits for the customer.
3. Paid: done; the receipt is shown.
4. Failed: Safaricom refused it. The three lines under it say why.
5. Needs a check: Safaricom never answered. Studio checks five times on its own; you can press Check with Safaricom now, or Mark as checked once you know.
6. Waiting for approval: held for a second person. Nothing has left your account.
7. Rejected: a second person refused it, or 24 hours passed.
8. Cancelled: you stopped it before it went out.

### When something is refused

1. Safaricom said: Safaricom’s own words, unchanged.
2. What it means: the plain-English meaning from the Daraja catalogue.
3. What to do now: the next step, for example add an operator, top up Utility, or try again in a moment.

- "Something went wrong on our side" is Studio, not Safaricom: try again in a moment, and check Settings if it keeps happening.

## What the API cannot do

### Portal-only tasks

Page: /not-possible

1. Withdrawing to the bank, moving float from Utility to Working, creating operators and roles, resetting portal passwords, KYC, bank accounts, tills, settlement plans, closing the organisation, Safaricom’s own statement, changing registered paybill URLs and the portal audit log all live in the Safaricom portal.
2. Not possible via API lists each one with why, where in the portal, and the USSD code where one exists.

## For AI agents and scripts

Studio is a web app over a JSON API. An agent can read everything a signed-in person can; it never moves money.

### Session and errors

1. Log in with POST /api/auth/login { username, password }. The answer carries csrf; the session is a cookie.
2. Send the csrf value as the x-csrf-token header on every request that is not GET.
3. GET /api/auth/me tells you who you are, your permissions, the organisation, its number and the environment in use (sandbox or production).
4. GET /api/events is a server-sent events stream: request.updated, money_in.updated, invoice.updated, bulk.updated. Re-read the page or the record when one arrives.
5. Errors are JSON: { error: { code, message, details? } }. A Safaricom refusal carries details.safaricomSaid, details.meaning and details.whatToDo. Show all three lines, never merged.
6. Every page route above is a browser route; the API paths beside each task are what the page calls.

### Rules

1. An AI agent never moves money. It must not press Send, Ask for payment, Send the prompt, Create the standing order, Send them all, Release, Reverse or Turn on, and must not call POST /api/send/phone, /api/send/bulk, /api/send/reversal, /api/approvals/:id/release, /api/collect/stk, /api/collect/ratiba, /api/collect/express, /api/collect/bonga/redeem, /api/invoices, /api/invoices/bulk or /api/money-in/register. Only a person does those, in the browser, with their password.
2. An agent may read every page and record, look up a receipt (POST /api/lookup), refresh balances (POST /api/balances/refresh), test the public address, and ask Safaricom to check a request (POST /api/requests/:id/check).
3. Never log, store or repeat a phone number, a receipt, a password, a key, a secret, a passkey or a Security Credential.
4. Never type a password, key or secret on a person’s behalf; ask them to do it themselves.
5. When a form is on screen, it is one question per screen: answer, Continue, until Review. Stop at Review unless a person presses the last button.
