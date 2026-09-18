# How to use Daraja Studio

Every page, in the order you meet them. Each task is numbered the way the screens go, and wherever you need something from Safaricom there is a link and the exact clicks.

This is the copy for AI agents and scripts. The page people see at /guide has the same tasks in everyday words, without the routes, permission keys, API calls or the agent rules.

## Contents

- What Daraja Studio is
- Before you start: what to have ready
- Getting things from Safaricom
- First-run setup
- Kinds of business, and the words they bring
- Logging in and finding your way
- Home
- History
- Get paid
- Pay out
- Settings
- Organisation
- People
- Reading a result
- What still has to be done on Safaricom’s site
- For AI agents and scripts

## What Daraja Studio is

Your M-Pesa paybill or till, on one screen, in everyday words. One Studio is one business and one number.

### The idea

1. Studio does the things you would otherwise do on Safaricom’s business website, and tells you plainly which things still have to be done there.
2. Under every page title, in grey, is the name Safaricom uses for the same thing, so you can find it on Safaricom’s site or ask their support about it.
3. Sandbox is Safaricom’s practice area with pretend money. Production is your real M-Pesa account. The menu always says which one you are in.
4. Every form asks one question per screen, with Back and Continue. The last button says Review, then the action (Send, Ask for payment, Create).
5. Studio asks for your password before anything that moves money or changes who can log in.

## Before you start: what to have ready

Everything on this list comes from Safaricom. The next section shows where each one is and what to click.

### The list

1. Your paybill or till number.
2. A Daraja app on Safaricom’s developer site, with its two codes: the "Consumer Key" and the "Consumer Secret".
3. The web address people use to open this Studio. Safaricom sends payment news to it, so it must open from anywhere, not only inside your office.
4. If you will send money out: a Safaricom portal user made for Studio (Safaricom calls it an operator), with its username, and either its password plus Safaricom’s certificate file, or a "Security Credential" made on the Daraja site.
5. If you will prompt their phone to pay: the "Passkey" for your number.

- Sandbox needs none of the real ones: Safaricom gives practice codes on the Daraja site, and Studio works with those until you switch to Production.

## Getting things from Safaricom

Two Safaricom websites matter. The Daraja portal is where your app, its two codes and the passkey live. The M-Pesa business portal is where your business, its users and your number live. Each task below has a button to the right page and the clicks once you are there, read off the live sites.

### A Daraja account and an app

Who: Owner

1. Open the Daraja portal and press Log In, or Sign Up the first time (email and a password; Safaricom sends a confirmation).
2. Once in, the left menu shows My Apps, Test Credentials, Go Live and APIs. Open My Apps.
3. Press Create Sandbox App. Give it an Application Name (letters, numbers, spaces and the _ sign only; your business name is fine).
4. Tick the products: "M-Pesa Sandbox" (covers receiving, sending and the rest), and "Lipa Na M-Pesa Sandbox" if you will prompt payers phones. Press Create App.
5. Your app now shows as a card on My Apps with its Consumer Key, Consumer Secret, Passkey, Short Code and Products. A new app is Sandbox; real money needs Go Live, below.

- [Open My Apps on the Daraja portal](https://developer.safaricom.co.ke/dashboard/myapps) — then: Daraja portal → Log In → My Apps → Create Sandbox App → Application Name → tick the products → Create App

### The Consumer Key and Consumer Secret

Who: Owner

1. On My Apps, find your app’s card. Sandbox and Production apps are separate cards; use the one for the mode you are setting up.
2. Press the small copy icon next to Consumer Key. Paste it into Studio’s "Consumer key" box.
3. Press the copy icon next to Consumer Secret. Paste it into Studio’s "Consumer secret" box. Studio checks the pair with Safaricom at once and says "accepted".

- The eye icon on the card shows or hides the values; the copy icon works either way.

- [Open My Apps on the Daraja portal](https://developer.safaricom.co.ke/dashboard/myapps) — then: Daraja portal → Log In → My Apps → your app card → the copy icon next to Consumer Key → then the one next to Consumer Secret

### Go Live: moving your app to real money

Who: Owner, with the M-Pesa business portal administrator’s username and phone

1. On the Daraja portal open Go Live. Verification Type stays "Short Code".
2. Organization ShortCode: your paybill, till store number, head office number or B2C number. Organization Name: your business name, shortened, without symbols.
3. M-PESA Username: the username of the Business Administrator or Business Manager on the M-Pesa business portal. It is case sensitive.
4. Tick "I accept Safaricom’s Terms and Conditions" and press Next. A one-time code goes by SMS to the phone on that portal user’s profile (it must be a Safaricom line). Type it.
5. Safaricom answers within 24 working hours (Monday to Friday, 8am to 5pm). Your sandbox app is then moved to Production with a new Consumer Key and Secret, and the Passkey appears on the card.

- To send money to phones in Production your number must be one that can both receive and pay out. If the B2C product is missing at Go Live, ask Safaricom’s business team for a B2C or "one account" number.

- [Open Go Live on the Daraja portal](https://developer.safaricom.co.ke/dashboard/golive) — then: Daraja portal → Log In → Go Live → Verification Type: Short Code → Organization ShortCode → Organization Name → M-PESA Username → tick the Terms and Conditions → Next → type the code sent by SMS
- [Email Safaricom’s business team](mailto:M-PESABusiness@Safaricom.co.ke) — then: a new email opens

### The Passkey (only for prompting their phone)

Who: Owner

1. Production: on My Apps, your Production app card has a Passkey row. Press the copy icon next to it. Safaricom also emails it to the app owner after Go Live.
2. Sandbox: open APIs, then M-Pesa Express(Prompt), then Simulate, then Open Simulator on the right. Pick your sandbox app under "Select or search one of your apps"; the test data fills in, including a Passkey box. Copy it.
3. Paste it into Studio’s "STK passkey" screen with your own phone number. Studio sends one KES 1 prompt to your phone as the proof; cancel it on the phone, nothing is taken.

- Safaricom’s own words: you only need a passkey if your app has the Lipa na M-Pesa or M-Pesa Express product.

- [Open My Apps on the Daraja portal](https://developer.safaricom.co.ke/dashboard/myapps) — then: Daraja portal → Log In → My Apps → your Production app card → the copy icon next to Passkey
- [Open the M-Pesa Express simulator](https://developer.safaricom.co.ke/dashboard/apis?api=MpesaExpressSimulate) — then: Daraja portal → Log In → APIs → M-Pesa Express(Prompt) → Simulate → Open Simulator → Select or search one of your apps → your sandbox app → the Passkey box

### Your paybill or till number

Who: Owner

1. It is on the letter or email Safaricom sent when the number was opened, and on your Production app card on the Daraja portal as Short Code after Go Live.
2. On the M-Pesa business portal: Search, then My Organization; the number and your business name are at the top of the page.
3. Type it into Studio’s "Shortcode" screen. Studio asks Safaricom for the name held against it and shows the name, so you can see you typed the right number.

- [Open the M-Pesa business portal](https://org.ke.m-pesa.com) — then: M-Pesa business portal → Log in (paybill or till number, username, password, the code on screen, then the code sent by SMS) → Search → My Organization → the number and name at the top of the page

### The M-Pesa business portal and its administrator

Who: Owner

1. The M-Pesa business portal is where Safaricom keeps your business, its users and its money. You need a Business Administrator login there before Go Live and before any portal user for Studio.
2. If your business has none yet: Safaricom’s business team sets one up. Your number must first settle to a bank through a Head Office; the same team sends the forms. Then they create the Business Administrator username.
3. First login: open the portal, type the paybill or till number, the administrator username and the first-time password from Safaricom’s email, then the code shown on screen, then the code sent by SMS. Set your own password and two security questions.
4. After that, logging in is the number, username, password, the code on screen and the SMS code.

- [Open the M-Pesa business portal](https://org.ke.m-pesa.com) — then: M-Pesa business portal → Log in (paybill or till number, username, password, the code on screen, then the code sent by SMS)
- [Email Safaricom’s business team](mailto:M-PESABusiness@Safaricom.co.ke) — then: a new email opens

### A portal user for Studio (Safaricom calls it an API operator)

Who: Owner, as the Business Administrator

1. Log in to the M-Pesa business portal as the Business Administrator. Open Search, then Organization Operator. Press the … next to Organization Short Code, type your number, Search, Confirm, then Search again: every user under your number is listed.
2. Press + Create (it is greyed out unless you are the Business Administrator). Username: a name for Studio, for example your business name. Access Channel: API. Rule Profile: Web Operator Rule Profile.
3. Roles: tick ORG B2C API initiator (sending money to phones), Balance Query ORG API (the balance on Home, and the test Studio runs) and Transaction Status query ORG API (checking a payment). Add Org Reversals Initiator if you will reverse payments.
4. Fill in the person responsible and Submit. The user shows in the list as Pending Active until it has a password.
5. The password is set by a portal user who has the Set Restricted ORG API PASSWORD role (a Business Manager): on the same list press Detail on the user’s row, then Set Password at the top right; type it twice and Submit. Use letters, numbers and only # & % $ as symbols; never @ or a full stop, and no brackets. The user then shows as Active.
6. Type the username and that password into Studio’s "API operator" screen, with the certificate (next task). Studio asks Safaricom for your balance with them and keeps the user only if Safaricom accepts it.

- A user with access channel Web that holds the same roles also works; the roles are what count.
- Studio never keeps the password itself, only a scrambled version made with Safaricom’s certificate.
- Too many wrong tries lock the user ("security credential is locked"); the Business Administrator unlocks it on the portal.
- Safaricom sometimes refuses one call and accepts the next with the same password, so Studio only marks the user DOWN after two refusals inside ten minutes. The card then shows "1 of 2 failures"; after you give it a new password, Reinstate tests it again.

- [Open the M-Pesa business portal](https://org.ke.m-pesa.com) — then: M-Pesa business portal → Log in (paybill or till number, username, password, the code on screen, then the code sent by SMS) → Search → Organization Operator → the … next to Organization Short Code → type your number → Search → Confirm → Search → + Create (only a Business Administrator sees it live) → Username → Access Channel: API → Rule Profile: Web Operator Rule Profile → Roles: ORG B2C API initiator, Balance Query ORG API, Transaction Status query ORG API → the person’s details → Submit
- [Open the M-Pesa business portal](https://org.ke.m-pesa.com) — then: M-Pesa business portal → Log in (paybill or till number, username, password, the code on screen, then the code sent by SMS) → Search → Organization Operator → the … next to Organization Short Code → type your number → Search → Confirm → Search → Detail on the user’s row → Set Password (top right; shown to a Business Manager) → Password → Confirm Password → Submit

### Safaricom’s certificate file

Who: Owner

1. Press the button for the mode you are setting up: Sandbox or Production. A small file ending in .cer downloads.
2. Open it with a plain text program: Notepad on Windows, TextEdit on a Mac (right-click the file, Open With). It is a block of letters between a BEGIN line and an END line.
3. Select all of it, copy, and paste into Studio’s "Certificate" box (on the "API operator" screen during setup, or under Settings later).

- [Download the Sandbox certificate](https://developer.safaricom.co.ke/certificates/SandboxCertificate.cer) — then: a file called SandboxCertificate.cer downloads
- [Download the Production certificate](https://developer.safaricom.co.ke/certificates/ProductionCertificate.cer) — then: a file called ProductionCertificate.cer downloads

### A "Security Credential" (instead of the password and certificate)

Who: Owner

1. This is the same scrambled password Studio would make for you, made on Safaricom’s site instead. Use it if you would rather not type the portal user’s password into Studio.
2. On the Daraja portal open Test Credentials. Under "Generate Security Credential Value", type the portal user’s password as Initiator Password, choose Sandbox or Production, and press Generate Password.
3. Copy the long text it shows. In Studio’s "API operator" screen choose "I already generated a Security Credential on the Daraja portal" and paste it.

- [Open Test Credentials on the Daraja portal](https://developer.safaricom.co.ke/dashboard/testcredentials) — then: Daraja portal → Log In → Test Credentials → Initiator Password → Sandbox or Production → Generate Password → copy the long text

### Where Safaricom sends news of payments

Who: Owner

1. Studio registers its own address with Safaricom when you press Turn on under Money in. In Production, Safaricom accepts that once per number.
2. If Safaricom says the addresses are already on record and payments still do not show, an older address is on record. Open URL Management on the Daraja portal, press View URLs, prove it is you (paybill or till number, the M-PESA admin username, the SMS code), then delete the old ones and press Turn on again in Studio.

- [Open URL Management on the Daraja portal](https://developer.safaricom.co.ke/dashboard/urlmanagement) — then: Daraja portal → Log In → Self Service → URL Management → View URLs → paybill or till number → M-PESA admin username → the code sent by SMS
- [Email Safaricom’s API support](mailto:apisupport@safaricom.co.ke) — then: a new email opens

## First-run setup

The first person to open a new Studio becomes the owner and walks through up to ten steps. Back keeps your answers, and every step saves before moving on, so you can stop and come back later.

### The steps

Who: Owner · Route: /setup

1. Owner: your name, a username and a password of 12 or more characters. You can change the name on the "Owner account created" screen; the username stays.
2. Environment: Sandbox or Production. Start with Sandbox if you are still trying things out; when Safaricom has approved your app for real money, Organisation › Go live takes you across.
3. What you need: tick "Receive money from payers", "Send money to people or businesses", or both. A separate tick, "Prompt their phone to pay", is the one thing that needs the passkey. Your ticks decide which of the later steps appear.
4. Your organization: business name, nominated number and notification phone (starting 2547). Shown in the menu and on receipts.
5. Shortcode: your paybill or till number. Studio checks it with Safaricom and shows the name Safaricom holds for it.
6. Daraja app: paste the "Consumer Key" and "Consumer Secret" (see Getting things from Safaricom). Studio tests them at once; "accepted" means Safaricom said yes.
7. Public address: Studio reads the address from your browser and shows it. Press Change only if people open Studio through a different address. Press "Test this address" so Safaricom can prove it reaches you.
8. STK passkey (only if you ticked the phone prompt): paste the passkey and give your own phone number. Studio sends one KES 1 prompt to your phone; cancel it, nothing is taken.
9. API operator (only if you send money): the portal user’s username, then either its password plus the certificate text, or a "Security Credential". Studio tests it with a balance check and keeps it only if Safaricom accepts it. A refused one is removed and the name is free to try again.
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

## Kinds of business, and the words they bring

What kind of business this is decides what Studio calls the things it holds and what it watches for. It is a row of data, not a setting built into the program: you pick one, and you may change its words or add your own.

### Pick the kind when you make a business

Where: Businesses · Who: Owner, or anybody given permission to change businesses · Route: /businesses · Permission: businesses.manage

1. Press Add a business, type its name, and answer "What kind of business is this?".
2. The kind sets eight things: what one account is called, what an account under another is called, whether money is expected regularly and how often, whether each account stands for a set amount, the payment categories, what happens with invoices and reminders, what Home leads with, and what this business’s statement is called.
3. Nine kinds ship with Studio: rental or property, clinic or health, church or religious, school, shop or retail, services or freelance, savings group or chama, transport, and Other, which is neutral and turns nothing on.
4. Every account, and every payment that already names the business, keeps its number and its record whatever kind you pick. Changing the kind changes words only, never money.

| Method | Path | Who |
|---|---|---|
| GET | `/api/business-types` | signed in |
| POST | `/api/businesses` | businesses.manage; body { name, typeKey } |

### Change the kind, or the words in it

Where: Businesses → a business · Route: /businesses

1. Change the kind, on the business’s own row, moves it to another kind. The promise on screen is the whole of it: accounts, numbers, and every payment that already names this business stay exactly as they are.
2. Under Kinds of business, at the bottom of the page, press Edit the words on any kind: the account noun, the account-under noun, the statement name and the categories are words you type, so a kind of business Studio has never heard of reads properly without waiting for a new version.
3. The four that are behaviour — how often money is expected, whether an account stands for a set amount, what happens with invoices and reminders, and what Home leads with — are picked from the list, because each one is wired to something Studio does.
4. Deleting a kind is allowed only while no business uses it. Deleting one keeps its name out of the way for ever; it never comes back on its own.
5. The words show up as you work: Accounts, Money in, Invoices, Reports and Home all use them.

| Method | Path | Who |
|---|---|---|
| PUT | `/api/businesses/:id/type` | businesses.manage; body { typeKey } |
| POST | `/api/business-types` | businesses.manage; body { name, template } |
| PUT | `/api/business-types/:key` | businesses.manage; body { name, template } |
| DELETE | `/api/business-types/:key` | businesses.manage; refused while a business uses it |

### One account’s statement, and who is behind

Where: Businesses → an account → Open the statement · Route: /accounts/:id

1. Open the statement from any account. On top is one plain line: paid to date, and still owed.
2. Under it, every row that exists for that account, oldest first — each payment in, each payout out, and each invoice raised. Nothing here is money Studio holds, because Studio holds none.
3. When the kind of business expects money regularly and the account has a standing amount, the same page says what each period expects, how many periods are behind, and when a reminder was last written. Set the amount on the account itself; nothing ever charges it.
4. Raise the next invoice makes one invoice for the standing amount and the coming period, and sends it to Safaricom the way the Invoices page does. It happens only when you press it.
5. Write a reminder writes the message for you — the name, what is owed, the business and the account number. Safaricom has no reminder call and Studio has no line of its own to a phone, so the message is yours to send: copy it, or open it in your own messages.
6. Who is behind, on a business, lists every account that owes something, the most behind first, with the oldest unpaid invoice. A kind of business that expects nothing regularly has no such list and no arrears: its statement is just the rows.

| Method | Path | Who |
|---|---|---|
| GET | `/api/accounts/:id/statement` | signed in |
| GET | `/api/businesses/:id/arrears` | signed in |
| POST | `/api/accounts/:id/next-invoice` | invoices.manage; one invoice, nothing automatic |
| POST | `/api/accounts/:id/remind` | businesses.manage; writes the message and records it |

## Logging in and finding your way

### Log in

Who: Anyone with a login · Route: /login

1. Type your username and password and press Log in.
2. If the owner gave you a temporary password, Studio asks you to choose your own first: type the temporary one, then your new password of 12 or more characters, twice.
3. Too many wrong tries locks the login for 15 minutes.

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/login` | anyone; answers with a csrf token and sets the session cookie |
| GET | `/api/auth/me` | signed in; who you are, your permissions, the organisation and the environment in use |
| POST | `/api/auth/change-password` | signed in |
| POST | `/api/auth/logout` | signed in |

### Lock Studio with a PIN

Where: Organisation · Who: Owner · Route: /account

1. On Organisation, under PIN lock, type a 6-digit PIN twice and press Set the PIN. Studio asks for your password to confirm it, then scrambles the PIN and keeps only that.
2. From then on Studio asks for the PIN when the page comes back and after 30 minutes without a touch, and shows nothing else until it is typed.
3. Type it on the keypad: six dots fill as you go, the sixth digit sends by itself, and the phone gives a small buzz. There is no button to press.
4. Five wrong PINs lock the PIN for 15 minutes, and the line says how long is left. Your password always works instead: press "Use your password instead" on the lock screen, or on any confirmation Studio asks for.
5. On a send, or anything else that moves money, the same keypad replaces the password box — six digits instead of a long password on a phone.
6. Fingerprint: after a PIN opens Studio on a phone that has none set up, a card asks once whether to use the fingerprint this device already has. Say yes and the next time the fingerprint opens Studio by itself. The PIN keeps working, and money still asks for the PIN or the password, never the fingerprint alone.
7. Organisation lists the devices with a fingerprint, each with Remove (your password or PIN is asked for first). Removing the PIN removes every fingerprint with it.
8. Change or remove the PIN on Organisation, next to where you set it. Both ask for your password (or the PIN) first.

| Method | Path | Who |
|---|---|---|
| PUT | `/api/auth/pin` | owner, password or PIN; body { newPin } |
| DELETE | `/api/auth/pin` | owner, password or PIN; removes the fingerprints too |
| POST | `/api/auth/open` | signed in; body { pin } or { password } |
| POST | `/api/auth/lock` | signed in; locks this session now |
| POST | `/api/auth/webauthn/open/options and /open/verify` | signed in; the fingerprint ceremony; opens exactly what the PIN opens |
| POST | `/api/auth/webauthn/register/options and /register/verify` | open session; enrols this device |
| GET | `/api/auth/webauthn/credentials` | open session; the devices enrolled, never a key or a counter |
| POST | `/api/auth/webauthn/credentials/remove` | open session, password or PIN; body { id } |

### The menu

1. The left menu shows your business name, your paybill or till number and whether you are in Sandbox or Production.
2. Home, Notifications, History and Reports come first. Then Get paid (Ask for payment, Money in, QR codes, Invoices), Pay out (Send money, Contacts, Bulk send, and Waiting whenever a send needs a person), and Manage (Businesses, Settings, Advanced).
3. Advanced opens a page of cards for things you set up once or use now and then: Standing orders, Express checkout, Bonga points, Bulk send, Reverse a payment.
4. Below the line: How to use (this page) and Not possible via API.
5. Your name at the top right opens the account menu: Organisation, Change password, Log out.

## Home

### Your balances and the day’s shortcuts

Where: Home · Who: Anyone logged in · Route: /

1. The heading is the name Safaricom holds for your number. Under it: the number, Sandbox or Production, and your own business name.
2. Utility account is the money you pay out to phones; Safaricom’s fees come from it too. Working account is where payments land; it also pays other paybills and tills.
3. Refresh asks Safaricom for today’s balance. "As of" says when it was last read; "Charges paid" is the fees so far. A balance more than a day old is flagged.
4. Studio also reads the balance by itself: every time a payment finishes, it asks Safaricom again within a minute, so the number follows the last thing that happened. Nothing is charged for this and the Refresh button still works.
5. Under the figures, one line: "Balance KES X · waiting to go out KES Y". The first is the Utility account, the second is every payment that has not finished yet. When more is waiting than Utility holds, the line turns red and tells you to move float from Working first.
6. Three tiles open the pages used most: Send money, Ask for payment, History.
7. Under the balance, a strip covers the last 24 hours: what came in, what went out, and how many payments are waiting or failed. Reports shows the same numbers over a longer window.
8. Recent requests shows the last five; View all opens History.
9. If something is still missing, Home says so at the top: no portal user (you cannot send yet), address not tested (Safaricom cannot reach you), passkey not set (Ask for payment is off).
10. Something is wrong appears above all of that when it is: the operator that sends has stopped working, Safaricom has not answered any payment for ten minutes while sends are still waiting, or the last balance check was refused. One sentence and one link to the page that puts it right. It goes away by itself when the trouble does, so there is nothing to dismiss. The owner also sees the line under it — which operator, and how long — because fixing it is theirs.

| Method | Path | Who |
|---|---|---|
| GET | `/api/health/problems` | signed in; the owner also gets the specifics behind each sentence |
| GET | `/api/balances/latest` | signed in |
| POST | `/api/balances/refresh` | balances.view |
| GET | `/api/requests?limit=5` | lookup.view |

### See what happened while you were away

Where: Home → Notifications · Who: Anyone logged in · Route: /notifications

1. The bell in the menu, next to Home, carries the number of lines you have not read.
2. Open Notifications for the list, newest first. Each line is a sentence: what happened, with the amount, the name and the receipt already in it.
3. All shows every line; Unread hides what you have read. A number like ×3 means the same thing happened three times.
4. Open this payment on a line about a payment opens that record in History.
5. Mark as read clears one line; Mark all read at the top clears the bell.
6. The page keeps itself up to date: a payment that finishes while the page is open gets its own line without a refresh.
7. On this device, at the top, turns on notifications the phone or computer shows while Studio is closed. Press Turn on notifications on this device and allow them when the browser asks. Send a test proves it works; Turn off on this device stops it for that one device.

- These lines are written by Studio from what Safaricom reports. They are not a message from Safaricom.
- Device notifications are off unless the person who runs Studio has set the server up for them, and each device is turned on separately.
- A message on a device shows the same sentence as the line here. Pressing it brings Studio back to the front, or opens that payment when Studio is not already running.
- A line that happens again does not make a second line: it moves to the top and its count goes up. Reading it does not bring it back.

| Method | Path | Who |
|---|---|---|
| GET | `/api/notifications` | signed in; filter=unread|all, limit |
| GET | `/api/notifications/count` | signed in; the number on the bell |
| POST | `/api/notifications/:id/read` | signed in; CSRF header |
| POST | `/api/notifications/read-all` | signed in; CSRF header; answers { read } |
| GET | `/api/push/key` | signed in; answers { configured, publicKey }; configured false means this server has no push keys |
| POST | `/api/push/subscribe` | signed in; CSRF header; body { endpoint, keys: { p256dh, auth } }; answers { devices } |
| POST | `/api/push/unsubscribe` | signed in; CSRF header; body { endpoint }; 204 |
| POST | `/api/push/test` | signed in; CSRF header; a test to your own devices |

### See how the days went

Where: Home → Reports · Who: Anyone logged in · Route: /reports · Permission: lookup.view; the spreadsheet also needs history.export

1. Open Reports from the menu, under Home.
2. Choose how far back: Last 7 days, Last 30 days or Last 90 days. The choice applies to the table, to the failure list and to the file.
3. The line under the buttons adds the window up: what came in, what went out, and the share of finished payments that went through. A payment Safaricom has not answered yet has its own column and is left out of that share.
4. The table has one line per day, days with nothing included, so a quiet day reads as a quiet day. Money in and money out are in shillings; Paid, Failed and Needs a check are counts.
5. Why things failed — last 7 days lists Safaricom’s own reason for each failure, with how many payments it explains and how much they came to.
6. Export as a spreadsheet saves the day-by-day table with the same window and business you chose. The button shows for the owner and for anybody given permission to export.

- Only money counts here. Balance checks and payment lookups are left out, and the numbers are the same ones History shows.
- By business appears when you run more than one business: each one’s own money in and out for the window. It is history, not cash: M-Pesa holds one pool for the whole paybill.

| Method | Path | Who |
|---|---|---|
| GET | `/api/reports` | lookup.view; days=7|30|90, businessId |
| GET | `/api/reports/summary` | lookup.view; the last 24 hours on Home |
| GET | `/api/reports/export.csv` | history.export; the same query as the page |

## History

### Find a payment

Safaricom calls this: Account Statement · Where: History · Who: Anyone logged in · Route: /history · Permission: lookup.view

1. Type a phone number, a name or an M-Pesa receipt in the search box.
2. Narrow it down by date (from, to), by direction (In and out, Money in, Money out) and by status (Paid, Waiting, Failed, Needs a check, Preparing, Cancelled).
3. Seven rows a page; Previous and Next at the bottom.
4. Press Export as a spreadsheet to save every row your filters select, not only the seven on screen, as a file you can open in Excel. The button shows for the owner and for anybody given permission to export.
5. Press a row to open the payment’s own page: amount, who, receipt, when, and the timeline (Created, Sent, Result) with where the result came from.
6. A receipt that was not sent from here shows "This receipt was not sent from here" and a button, Ask Safaricom about this receipt. The answer lands on the same page within a few minutes.

| Method | Path | Who |
|---|---|---|
| GET | `/api/requests` | lookup.view; filters as query strings |
| GET | `/api/requests/:id` | lookup.view |
| GET | `/api/requests/export.csv` | history.export; the same filters as the list, every matching row |
| POST | `/api/lookup` | lookup.view; body { receipt } |

### On a payment’s page

Where: History → a row · Route: /requests/:id

1. Needs a check means Safaricom never answered. Press Check with Safaricom now; Studio also checks on its own five times.
2. Mark as checked records what you found out another way (for example, "Paid, seen on Safaricom’s site").
3. Send again reopens Send money with the same details; nothing goes out until you go through Review again. Reverse this payment opens Reverse with the receipt filled in, for a payment that was paid.

| Method | Path | Who |
|---|---|---|
| POST | `/api/requests/:id/check` | signed in |
| POST | `/api/requests/:id/checked` | lookup.view, password; body { note } |

## Get paid

Money coming in. Nothing here takes money out of your accounts.

### Ask for payment

Safaricom calls this: STK Push · Where: Get paid → Ask for payment · Who: Owner or Operator · Route: /ask-to-pay · Permission: stk.request

1. Their phone number.
2. Amount in KES, whole shillings.
3. What is this for? An invoice or order number; the payer sees it, and so does your statement.
4. Short description, optional, up to 13 characters, shown on their phone.
5. Review, then Ask for payment. The payer has about a minute to enter their M-Pesa PIN.
6. The page waits and then says Paid or Not paid; the receipt goes to History. Ask someone else starts over.

- Asking the same number for the same amount twice in a row is questioned first: "You asked for this already at … Ask again?"
- Needs the passkey (Settings). Without it the page is off and Home says so.

| Method | Path | Who |
|---|---|---|
| POST | `/api/collect/stk` | stk.request; body { phone, amountCents, reference, description? } |

### Money in

Safaricom calls this: C2B · Where: Get paid → Money in · Who: Owner turns it on; anyone logged in can look · Route: /money-in · Permission: money_in.view

1. Turn on once. Studio tells Safaricom where to send news of payments; the page updates on its own and then says "On since …" or shows Safaricom’s refusal in three lines.
2. If Safaricom says the addresses were already on record, that counts as on. Should a payment then never show, an older address may be on record at Safaricom; their API support can reset it.
3. From then on every payer payment to your number shows here and in History the moment Safaricom reports it.
4. Check for missed payments asks Safaricom for anything whose news never arrived. Studio does the same every hour on its own.

- Every payment is accepted. Safaricom only asks Studio to approve payments if its support team has switched that on for your number.
- Test the address in Settings first; Safaricom must be able to reach Studio.

| Method | Path | Who |
|---|---|---|
| GET | `/api/money-in/status` | money_in.view |
| GET | `/api/money-in/recent` | money_in.view |
| POST | `/api/money-in/register` | owner, password; answers 202 and works in the background |
| POST | `/api/money-in/check` | money_in.view |

### How account numbers work

Where: Manage → Businesses · Who: Anyone signed in can look; the owner, or a role given the permission, changes them · Route: /businesses · Permission: businesses.manage

1. Open Businesses in the menu. With one business, routing is off: every payment belongs to it, and the page says so.
2. Add a business: a name, and nothing else. Studio gives it the next free three-digit code, lowest first, and the page says which one before you press Save.
3. An account number has three parts: the business code (three digits, 000 to 999), the payer number, and, if you want to tell things apart under one payer, an account under it. So 000 is the business, 000359 is a payer, and 000359123 is the account under that payer.
4. Every digit is Studio’s to choose: it draws the number and nobody types one. Add a payer with a name and a phone number and the number appears at once, with the sentence to give the payer: pay 123456, account 000359.
5. A number says how long it is. A payer number starts at three digits; when all 900 of them are used, new ones get four digits, then five. The line under each business says which length is in use: Payer numbers: 3 digits, 412 of 900 used. Old numbers keep their length, so nothing a payer already knows changes.
6. From the day there are two businesses, payers must start the account number with the code. Money in shows which account a payment belongs to, and History filters by business or by one account.
7. A payment whose digits name no business, no account, or no account under a payer waits in Money in under Payments we could not sort. Pick an account for it, or add the payer, and Studio labels the payment with the new account.
8. Ask for payment, QR codes and Invoices can pick a business, then a payer, then one of the accounts under them; Studio fills the full number.

- A business is switched off, never deleted, so an old account number keeps meaning what it meant. Retiring an account keeps its number out of circulation for ever: it is never given to anyone else.
- Numbers are drawn at random, so a payer cannot guess a neighbour’s number from their own, and no number is ever issued twice. The length is written into the number itself, so the digits a payer types can never be read as somebody else’s account.
- When all 900 numbers of a length are used, the next length opens, Studio writes it in the record of what it did, and the bell tells you: Payer numbers for Shop now have 4 digits.
- One business means nothing is stripped from the account number and nothing is unmatched.
- Balances stay one pool: M-Pesa holds one balance per paybill. The line per business on Home is that business own history, not cash.

| Method | Path | Who |
|---|---|---|
| GET | `/api/businesses` | signed in; each business carries its open number length and how much of it is used |
| POST | `/api/businesses` | businesses.manage; body { name } only, Studio gives the next free code |
| PUT | `/api/businesses/:id` | businesses.manage; body { name, active } |
| GET | `/api/businesses/:id/accounts` | signed in; q narrows by name or number; payers carry their accounts nested |
| POST | `/api/businesses/:id/accounts` | businesses.manage; body { name, phone?, note? }; Studio draws the number |
| POST | `/api/accounts/:id/children` | businesses.manage; an account under a payer; Studio draws its number too |
| PUT | `/api/accounts/:id` | businesses.manage; the words around the number only, which is never edited |
| DELETE | `/api/accounts/:id` | businesses.manage; retires it and everything under it; the number is never reissued |
| POST | `/api/businesses/assign/:requestId` | businesses.manage; body { businessId, accountId? } |
| GET | `/api/businesses/summary` | signed in; per business in and out for the day |

### QR codes

Safaricom calls this: Dynamic QR · Where: Get paid → QR codes · Who: Owner or Operator · Route: /qr · Permission: qr.generate

1. How people pay: Pay Bill or Buy Goods (till).
2. Payment reference: an order or account reference, up to 32 characters.
3. Who sets the amount: a fixed amount, or the payer enters it.
4. Amount in KES (when fixed). Create QR code shows the code to print or show on a screen.

- A scan does not confirm payment. Check your M-Pesa confirmation, or Money in.

| Method | Path | Who |
|---|---|---|
| POST | `/api/qr` | qr.generate |

### Invoices

Safaricom calls this: Bill Manager · Where: Get paid → Invoices · Who: Owner sets it up; Owner or Operator sends and cancels · Route: /invoices · Permission: invoices.manage

1. Set up once for Sandbox and once for Production (owner): business email, official contact phone, whether Safaricom should send payment reminders, then your password.
2. New invoice: payer name, payer phone, what the invoice is for, account reference (up to 20 characters; payments are matched by it), billed period, due date, line items (optional, one per line: name, amount), amount. Send the invoice: the payer gets an SMS with a pay prompt.
3. Many at once: one line per invoice (name, phone, invoice name, account, period, due date as year-month-day, amount). Studio checks every line, then Send them all.
4. Show Open, Overdue, Paid, Cancelled or All; search by name, reference or account.
5. Press Export as a spreadsheet beside the filter to save every invoice your filter and search select, as a file you can open in Excel.
6. Open an invoice to see its payments. Cancel this invoice stops it; tick several to cancel them together.
7. Record a payment made another way (cash, bank): when, how much, a reference, who paid. Safaricom is told, so reminders stop.

- Payments through M-Pesa land against the invoice the moment Safaricom reports them, and in History as "Invoice paid".
- If Safaricom answers "not allowed" to the set-up, Bill Manager is not enabled for your app or number: tick it under Update App on the Daraja portal, or ask Safaricom’s API support to enable it for your paybill.

- [Open My Apps on the Daraja portal](https://developer.safaricom.co.ke/dashboard/myapps) — then: Daraja portal → Log In → My Apps → your Production app card → the ⋮ menu → Update App → tick Bill Manager → Save
- [Email Safaricom’s API support](mailto:apisupport@safaricom.co.ke) — then: a new email opens

| Method | Path | Who |
|---|---|---|
| GET | `/api/invoices/settings` | invoices.manage |
| POST | `/api/invoices/opt-in` | owner, password |
| GET | `/api/invoices` | invoices.manage |
| GET | `/api/invoices/export.csv` | history.export; filter and q, every matching row |
| GET | `/api/invoices/:id` | invoices.manage |
| POST | `/api/invoices` | invoices.manage |
| POST | `/api/invoices/bulk/check` | invoices.manage |
| POST | `/api/invoices/bulk` | invoices.manage |
| POST | `/api/invoices/:id/cancel` | invoices.manage |
| POST | `/api/invoices/cancel` | invoices.manage; body { ids } |
| POST | `/api/invoices/:id/payment` | invoices.manage |

### Standing orders

Safaricom calls this: M-Pesa Ratiba · Where: Manage → Advanced → Standing orders · Who: Owner or Operator · Route: /standing-orders · Permission: standing_orders.manage

1. Press New standing order.
2. A name for this order (the payer sees it; one name per payer).
3. Their phone number.
4. Amount each time, in KES.
5. How often: once, every day, week, month, two months, three months, six months or year.
6. First collection date, then last collection date.
7. Account reference (what the payments are for, up to 12 characters), then a short note (optional, up to 13 characters).
8. Review, then Create the standing order. The payer gets a prompt to agree; the page updates on its own.

- Once agreed, nothing about the order can be changed. To change it, create a new one and ask the payer to stop the old one on their phone.
- Each collection shows in History as money in.

| Method | Path | Who |
|---|---|---|
| POST | `/api/collect/ratiba` | standing_orders.manage |

### Express checkout

Safaricom calls this: B2B Express Checkout · Where: Manage → Advanced → Express checkout · Who: Owner or Operator · Route: /express · Permission: express.checkout

1. Their till or paybill number: the business that is paying you.
2. Amount in KES.
3. What is this for? An order or invoice number, shown on their prompt.
4. Your name as they know you, optional.
5. Review, then Ask for payment. They approve on their phone; the money arrives in your paybill.

| Method | Path | Who |
|---|---|---|
| POST | `/api/collect/express` | express.checkout |

### Bonga points

Safaricom calls this: Lipa na Bonga · Where: Manage → Advanced → Bonga points · Who: Owner or Operator · Route: /bonga · Permission: bonga.redeem

1. How many points? Studio shows what they are worth at Safaricom’s rate today.
2. Their phone number.
3. What is this for? An order or invoice number; the payment is matched to it.
4. Review, then Send the prompt. The payer enters their M-Pesa PIN to pay with points.

- Safaricom pays the shilling value into your paybill the same way a payment arrives, so Money in must be on.

| Method | Path | Who |
|---|---|---|
| POST | `/api/collect/bonga/calculate` | bonga.redeem; body { points } |
| POST | `/api/collect/bonga/redeem` | bonga.redeem |

## Pay out

Money leaving your accounts. Every send asks for your password.

### Keep a list of people you pay

Where: Pay out → Contacts · Who: Anyone signed in can look; the owner, or a role given the permission, keeps the list · Route: /contacts · Permission: contacts.manage

1. Open Contacts in the menu. Three tabs: Phone, Till and Paybill.
2. Add a contact: a name, and the number you pay. A phone number is saved in the 2547… form however you type it, so 0712 345 678 and 254712345678 are the same person.
3. A paybill contact can also keep the account reference the paybill asks for. A note is optional on any of them.
4. Edit changes a contact. Delete retires it: the list stops showing it, History keeps the name it was paid under, and the same name can be used again.
5. Pay on a phone contact opens Send money with the number already filled in, and the payment keeps that contact on its record. Paying a till or a paybill is not built yet.
6. On the Send page, picking a name fills the number in; typing a different number drops the contact, and the money goes to the number you typed.
7. Bulk send has the same list: tick the people to pay, give each an amount, and Add them to the list writes the phone, amount and name lines for you.

- Only a phone contact can be paid today, so the Phone tab is the one with a Pay button.

| Method | Path | Who |
|---|---|---|
| GET | `/api/contacts` | signed in; kind and q narrow the list |
| POST | `/api/contacts` | contacts.manage; body { kind, name, phone?, shortcode?, accountReference?, note? } |
| PUT | `/api/contacts/:id` | contacts.manage; the same body, a full replace |
| DELETE | `/api/contacts/:id` | contacts.manage; retires the contact, History keeps the name |

### Send money to a phone

Safaricom calls this: Initiate Transaction › Business Payment to Customer · Where: Pay out → Send money → To a phone · Who: Owner or Operator · Route: /send/phone · Permission: send.phone

1. Open Send money and press To a phone. (The other kinds, to a business wallet, a paybill, a till, float moves, top-ups and KRA, say Coming soon.)
2. Phone number.
3. Amount in KES, whole shillings.
4. What kind of payment is this? One of your own categories (Settings › Payment categories); each is one of Safaricom’s three kinds, Business payment, Salary or Promotion.
5. Note, optional.
6. Review: the name Safaricom holds for that number when your paybill or till is allowed to ask (first name in full, the rest hidden), Utility balance now and after, the fee note, and the per-send cap if one is set. When Safaricom has not switched the check on for your number, the page says so: check the number. When Safaricom does not know the number, a red notice says so before you send.
7. Send, then your password. The page says Sent, then Paid or Not paid; the receipt goes to History.

- The same amount to the same number twice in a row is questioned first: "You sent this already at … Send again?"
- When Settings › Approvals is on and the amount is at or above the limit, the send waits for a second person instead of going out. Nothing leaves your account until it is released.
- Needs a working portal user (Settings). Without one Home says you cannot send yet.
- The name check (Safaricom calls it B2C Hakikisha) needs Safaricom’s approval for your paybill or till. Email API support to ask for it; until then the review says Safaricom cannot check the name.

- [Email Safaricom’s API support](mailto:apisupport@safaricom.co.ke) — then: a new email opens

| Method | Path | Who |
|---|---|---|
| GET | `/api/send/categories` | signed in |
| POST | `/api/send/name-check` | send.phone; body { phone }; answers { available: true, name } or { available: false, reason: "not_found" | "not_enabled" | "unavailable", said } |
| POST | `/api/send/phone` | send.phone, password; body { phone, amountCents, category, remarks?, contactId? } |

### Bulk send

Safaricom calls this: Bulk Task › Bulk Payment · Where: Manage → Advanced → Bulk send · Who: Owner or Operator · Route: /bulk · Permission: bulk.send

1. Paste the list into The list, one line per person: phone, amount, name, note (the first two are needed), or Upload a file (a spreadsheet saved as CSV). Download a template gives the layout.
2. Check the list. Every line is checked before anything moves; lines that need fixing are named. Nothing is sent until all pass.
3. Send them all, then your password. Each row goes out in turn as an ordinary send, so the duplicate check, the cap and the approval hold all apply; a failed row never stops the rest.
4. The batch page shows every row live. Try the failed rows again resends only rows Studio stopped before Safaricom. Download results gives a file for your records.
5. Batches lists every earlier batch.

| Method | Path | Who |
|---|---|---|
| POST | `/api/send/bulk/check` | bulk.send |
| POST | `/api/send/bulk` | bulk.send, password |
| GET | `/api/send/bulk` | bulk.send |
| GET | `/api/send/bulk/:id` | bulk.send |
| POST | `/api/send/bulk/:id/retry` | bulk.send, password |

### Waiting

Safaricom calls this: Review Transaction · Where: Pay out → Waiting · Who: Anyone logged in; an Approver or the owner releases or refuses · Route: /approvals · Permission: send.approve

1. Everything that has not finished is on one page, in three groups: waiting for a second person, sent and not yet answered by Safaricom, and no answer yet.
2. Each row shows how long it has waited, so the oldest is easy to spot.
3. Waiting for a second person: turn it on in Settings › Approvals to hold sends of an amount or more (0 turns it off); it applies to everyone, the owner included. Give somebody the Approver role in People, or nothing can be released. Release asks for your password and sends it. Refuse asks why, and the maker sees the reason.
4. Nobody can release or refuse their own send. A held send is refused on its own after 24 hours.
5. Sent, waiting for Safaricom: the request is with Safaricom and no answer has come back. Most answers arrive within two minutes; Studio asks again on its own, or press Check with Safaricom.
6. No answer yet: five checks went by with no answer. Check the Safaricom portal, then open the row and Mark as checked, which takes it off this page.
7. The menu shows Waiting with a count of the rows that need a person: held sends and no-answer sends. A send Safaricom is still working on is not counted.

| Method | Path | Who |
|---|---|---|
| GET | `/api/waiting` | lookup.view; the three sections and the badge |
| GET | `/api/waiting/count` | signed in; { badge } |
| GET | `/api/approvals` | send.approve |
| GET | `/api/approvals/count` | signed in; { count, enabled } |
| POST | `/api/approvals/:id/release` | send.approve, password |
| POST | `/api/approvals/:id/refuse` | send.approve; body { reason } |
| POST | `/api/requests/:id/check` | the permission of that kind of send |
| PUT | `/api/settings/approval-threshold` | owner, password; body { cents } |

### Reverse a payment

Safaricom calls this: Reversal · Where: Manage → Advanced → Reverse a payment · Who: Owner or Operator · Route: /reverse · Permission: reverse.request

1. Type the M-Pesa receipt (10 letters and numbers) and press Find that payment. Only a payment that landed here can be reversed.
2. Check the amount and the receipt: a reversal cannot be undone.
3. Reverse, then your password. Safaricom takes the money back from the payer; the page says Reversed or Not reversed, and the reversal shows in History.

- Safaricom can only take back money the payer still has. If it is spent, the reversal is refused.

| Method | Path | Who |
|---|---|---|
| GET | `/api/send/reversal/:receipt` | reverse.request |
| POST | `/api/send/reversal` | reverse.request, password |

## Settings

How Studio behaves. Every value is shown as it is; press Change or Replace to edit it, and saving asks for the owner’s password.

### What is on Settings

Safaricom calls this: My Preference · Where: Manage → Settings · Who: Owner changes things; anyone logged in can look · Route: /settings · Permission: owner

1. Appearance: System, Light or Dark.
2. Public address: the web address Safaricom sends payment news to. Test it after any change.
3. Payment categories: your own names for a send (Personal use, Rent, …); each goes to Safaricom as Business payment, Salary or Promotion. Add, Edit, Delete; keep at least one.
4. Approvals: Second person, Off or "Hold sends of KES … or more". Change, type the amount, save with your password.
5. Invoices: whether invoicing is set up and whether reminders are on. Set it up from the Invoices page.
6. Safaricom’s charges: the published bands behind the charge on each send. Correct them when Safaricom changes them.
7. Advanced, folded shut: the B2C version for the mode in use (leave it on Automatic), Safaricom’s callback addresses (change only if Safaricom publishes new ones), and the callback secret (Show asks for your password; treat it like a password).

| Method | Path | Who |
|---|---|---|
| GET | `/api/settings` | owner |
| PUT | `/api/settings/public-url` | owner, password |
| POST | `/api/settings/public-url/test` | owner |
| PUT | `/api/settings/send-categories` | owner, password |
| PUT | `/api/settings/approval-threshold` | owner, password; body { cents } |
| PUT | `/api/settings/environments/:env/b2c-api` | owner, password |
| PUT | `/api/settings/allowlist` | owner, password |
| POST | `/api/settings/install-secret/reveal` | owner, password |

### Correct what Safaricom charges

Where: Manage → Settings · Who: Owner · Route: /settings · Permission: owner

1. Open Settings and find Safaricom’s charges.
2. Three lists: Money in (paybill), Money out to a phone, and Business payments. Each band has a From, a To and the charge, in whole shillings.
3. Type over a figure, press Add a band for a new one or Remove to drop one, then Save with your password.
4. The send review then says “Safaricom’s charge: KES …, taken from Utility” before you pay, and History shows the same figure on each row.

- These are Safaricom’s published PayBill and Disbursement bands. Studio adds nothing of its own, so this is cost, never a fee you earn.
- Changing a band never changes an old row: History keeps the charge that payment was costed at.
- An amount no band covers shows no charge, rather than a guess.

| Method | Path | Who |
|---|---|---|
| GET | `/api/fees` | anyone signed in with lookup.view |
| GET | `/api/fees/charge?kind=&amountCents=` | anyone signed in with lookup.view |
| PUT | `/api/fees/:kind` | owner, password; body { bands: [{ minCents, maxCents, chargeCents }] } |

## Organisation

Your business, the mode you are in, your number and Safaricom details for each mode, who can log in. Opened from your name at the top right.

### What is on Organisation

Where: your name, top right → Organisation · Who: Owner · Route: /account · Permission: owner

1. Business: the name in the menu and on receipts, the nominated number and the notification phone.
2. Mode: Sandbox for practice, or Production for real money. Switching a finished Studio to Production asks you to type your paybill or till number back, then your password. While you are in Sandbox, a Go live card sits under it (next task).
3. Sandbox and Production, one card each, the one in use first and open, the other behind Show. The top line says Ready or what is still needed. Then: your paybill or till number (Change; Check the name with Safaricom), the Daraja app codes (Replace, with the Safaricom clicks), the passkey (Replace), the certificate, and your API operators. Each operator card says Active, Standby, DOWN or Switched off, when its password runs out, how many times it has just failed, and, when it is DOWN, what Safaricom refused; beside it are Reinstate or Test again, New password, and Turn off. Each form shows "Where to get it".
4. Who can log in: Manage people opens the People page.
5. Delete this studio, at the bottom: removes the business, its people, its Safaricom details and its history, and returns Studio to first-run setup. It asks for your password and the business name typed exactly. It cannot be undone.

| Method | Path | Who |
|---|---|---|
| PUT | `/api/settings/org` | owner, password |
| PUT | `/api/settings/mode` | owner, password |
| PUT | `/api/settings/environments/:env/shortcode` | owner, password |
| POST | `/api/settings/environments/:env/shortcode/verify` | owner |
| POST | `/api/settings/environments/:env/daraja` | owner, password |
| POST | `/api/settings/environments/:env/passkey` | owner, password |
| GET | `/api/settings/environments/:env/operators` | owner |
| POST | `/api/settings/environments/:env/operators` | owner, password |
| POST | `/api/settings/operators/:id/probe` | owner |
| POST | `/api/settings/operators/:id/rotate` | owner, password |
| POST | `/api/settings/operators/:id/disable` | owner, password |
| PUT | `/api/auth/display-name` | signed in |
| POST | `/api/org/wipe` | owner, password, name typed |

### See who changed what

Where: your name, top right → Organisation → Who did what · Who: Owner · Route: /who-did-what · Permission: owner

1. Open Who did what from the menu, under Manage. The list starts with the newest change and shows who made it, what they did, what it was done to, and when.
2. The filters narrow the list: pick a person, pick an action, set a date range, or type into the search box. A change with nobody behind it — a job or a message from Safaricom — says Nobody signed in.
3. Show opens one line: the values before and after the change, and the address the change came from.
4. Previous and Next walk further back, one page at a time.

- This is a record, not a control: nothing on it can be changed or removed, and Studio itself never edits or deletes a line.
- Only the owner sees it. Anybody else who opens the address is refused.

| Method | Path | Who |
|---|---|---|
| GET | `/api/audit` | owner; personId, action, from, to, q, limit, cursor |
| GET | `/api/audit/actions` | owner; the actions the filter offers |

### Go live: from pretend money to real money

Safaricom calls this: Go Live · Where: your name, top right → Organisation → Go live · Who: Owner · Route: /go-live · Permission: owner

1. Before Studio can help, Safaricom must have approved your app for real money: Go Live on the Daraja portal (button below). Studio then shows the steps that apply to you, and asks your password once.
2. Your paybill or till number. Studio checks it with Safaricom and shows the name it holds.
3. The Consumer Key and Consumer Secret from your Production app card. Studio tests them at once.
4. Switch to real money: type the number back. From here Studio talks to your real M-Pesa account.
5. Passkey (only if you prompt payers phones): paste it and give your own phone number; Studio sends one KES 1 prompt you can cancel.
6. API operator (only if you send money out): the portal user’s name and password with the certificate, or a Security Credential. Studio keeps it only once Safaricom accepts it.
7. Done. Home now shows your real balances. Every step saves as you go, so you can stop and come back; steps already done just say so.

- [Open Go Live on the Daraja portal](https://developer.safaricom.co.ke/dashboard/golive) — then: Daraja portal → Log In → Go Live → Verification Type: Short Code → Organization ShortCode → Organization Name → M-PESA Username → tick the Terms and Conditions → Next → type the code sent by SMS
- [Open My Apps on the Daraja portal](https://developer.safaricom.co.ke/dashboard/myapps) — then: Daraja portal → Log In → My Apps → your app card → the copy icon next to Consumer Key → then the one next to Consumer Secret
- [Open My Apps on the Daraja portal](https://developer.safaricom.co.ke/dashboard/myapps) — then: Daraja portal → Log In → My Apps → your Production app card → the copy icon next to Passkey
- [Open the M-Pesa business portal](https://org.ke.m-pesa.com) — then: M-Pesa business portal → Log in (paybill or till number, username, password, the code on screen, then the code sent by SMS) → Search → Organization Operator → the … next to Organization Short Code → type your number → Search → Confirm → Search → + Create (only a Business Administrator sees it live) → Username → Access Channel: API → Rule Profile: Web Operator Rule Profile → Roles: ORG B2C API initiator, Balance Query ORG API, Transaction Status query ORG API → the person’s details → Submit

| Method | Path | Who |
|---|---|---|
| PUT | `/api/settings/environments/production/shortcode` | owner, password |
| POST | `/api/settings/environments/production/daraja` | owner, password |
| PUT | `/api/settings/mode` | owner, password; body { environment: "production", confirmShortcode } |
| POST | `/api/settings/environments/production/passkey/prove` | owner, password; body { passkey, phone }; the mode in use must be production |
| POST | `/api/settings/environments/production/operators` | owner, password |

## People

### Who can log in

Safaricom calls this: Organization Operator · Where: your name, top right → Organisation → Who can log in → Manage people · Who: Owner · Route: /people · Permission: owner

1. Press your name at the top right, then Organisation, then Manage people under Who can log in.
2. Add somebody: their name, a username, what they may do, and a temporary password (Suggest another gives a new one). Add them, then your password.
3. Tell them the temporary password yourself; Studio shows it once. They must change it at first login.
4. Roles: Owner does everything. Operator can send money and ask for payment. Viewer can only look. Approver can release or refuse held sends.
5. On each person: change what they may do, New temporary password, Switch off (they cannot log in) and Switch on.

- These are Studio logins. Users of Safaricom’s business portal are separate and are managed there.

| Method | Path | Who |
|---|---|---|
| GET | `/api/people` | signed in |
| POST | `/api/people` | owner, password |
| PUT | `/api/people/:id/role` | owner, password |
| POST | `/api/people/:id/reset-password` | owner, password |
| POST | `/api/people/:id/suspend` | owner, password |
| POST | `/api/people/:id/resume` | owner, password |

## Reading a result

### The status words

1. Preparing: Studio has the request and is about to send it to Safaricom.
2. Waiting: Safaricom has it and has not answered yet. Most answers come within seconds; a phone prompt waits for the payer.
3. Paid: done; the receipt is shown.
4. Failed: Safaricom refused it. The three lines under it say why.
5. Needs a check: Safaricom never answered. Studio checks five times on its own; you can press Check with Safaricom now, or Mark as checked once you know.
6. Waiting for approval: held for a second person. Nothing has left your account.
7. Rejected: a second person refused it, or 24 hours passed.
8. Cancelled: you stopped it before it went out.

### When something is refused

1. Safaricom said: Safaricom’s own words, unchanged.
2. What it means: the same thing in everyday words.
3. What to do now: the next step, for example add a portal user, top up Utility, or try again in a moment.

- "Something went wrong on our side" is Studio, not Safaricom: try again in a moment, and check Settings if it keeps happening.

## What still has to be done on Safaricom’s site

### Portal-only tasks

Where: Not possible via API · Route: /not-possible

1. Withdrawing to the bank, moving float from Utility to Working, creating portal users and their rights, resetting portal passwords, KYC, bank accounts, tills, settlement plans, closing the organisation, Safaricom’s own statement, changing where paybill news is sent after the first time, and the portal’s own audit log all live on Safaricom’s business portal.
2. Not possible via API lists each one with why, where on the portal, and the phone code (*234#) where one exists.

- [Open the M-Pesa business portal](https://org.ke.m-pesa.com) — then: M-Pesa business portal → Log in (paybill or till number, username, password, the code on screen, then the code sent by SMS)

## For AI agents and scripts

Studio is a web app over a JSON API. An agent can read everything a signed-in person can; it never moves money.

### Session and errors

1. Log in with POST /api/auth/login { username, password }. The answer carries csrf; the session is a cookie.
2. Send the csrf value as the x-csrf-token header on every request that is not GET.
3. GET /api/auth/me tells you who you are, your permissions, the organisation, its number and the environment in use (sandbox or production).
4. GET /api/events is a server-sent events stream: request.updated, money_in.updated, invoice.updated, bulk.updated, notification.created. Re-read the page or the record when one arrives.
5. Errors are JSON: { error: { code, message, details? } }. A Safaricom refusal carries details.safaricomSaid, details.meaning and details.whatToDo. Show all three lines, never merged.
6. Every page route above is a browser route; the API paths beside each task are what the page calls. "Where" is the menu trail a person follows; "permission" is the key the route checks.

### Rules

1. An AI agent never moves money. It must not press Send, Ask for payment, Send the prompt, Create the standing order, Send them all, Release, Reverse or Turn on, and must not call POST /api/send/phone, /api/send/bulk, /api/send/reversal, /api/approvals/:id/release, /api/collect/stk, /api/collect/ratiba, /api/collect/express, /api/collect/bonga/redeem, /api/invoices, /api/invoices/bulk or /api/money-in/register. Only a person does those, in the browser, with their password.
2. An agent may read every page and record, look up a receipt (POST /api/lookup), refresh balances (POST /api/balances/refresh), test the public address, and ask Safaricom to check a request (POST /api/requests/:id/check).
3. Never log, store or repeat a phone number, a receipt, a password, a key, a secret, a passkey or a Security Credential.
4. Never type a password, key or secret on a person’s behalf; ask them to do it themselves.
5. When a form is on screen, it is one question per screen: answer, Continue, until Review. Stop at Review unless a person presses the last button.
