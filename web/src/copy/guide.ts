/**
 * The manual, as data. One source feeds the How to use page (`pages/Guide.tsx`), the static
 * `public/guide.md` that AI agents and scripts fetch, and `public/llms.txt`. Written from a
 * walk through every page of the live studio on 2026-09-16, in the order a new owner meets them.
 *
 * Keep this file free of imports and of anything beyond type annotations: `scripts/guide-md.ts`
 * loads it with Node's type stripping, which handles types but not enums or decorators.
 */
export type GuideApi = { method: 'GET' | 'POST' | 'PUT'; path: string; who: string };
export type GuideTask = {
  key: string;
  title: string;
  /** Safaricom's own name for it, shown in grey under the title. */
  safaricom?: string | null;
  /** The page it lives on. */
  path?: string;
  /** Who may do it. */
  who?: string;
  /** Numbered, in the order the screens go. */
  steps: string[];
  /** Things to know, unnumbered. */
  notes?: string[];
  /** The calls behind the page, for agents and scripts. */
  api?: GuideApi[];
};
export type GuideSection = { key: string; title: string; intro?: string; tasks: GuideTask[] };

export const guideTitle = 'How to use Daraja Studio';
export const guideIntro = 'Every page, in the order you meet them, from the first run to the last card. Each task is numbered the way the screens go.';
/** Only guide.md carries this line; the page for people never mentions the machine copy. */
export const guideMachineLine = 'This is the copy for AI agents and scripts. The page people see at /guide has the same tasks without the API calls or the agent rules.';

const PASSWORD = 'Your password is asked for anything that moves money or changes who can.';

export const guide: GuideSection[] = [
  {
    key: 'what',
    title: 'What Daraja Studio is',
    intro: 'A console for one M-Pesa paybill or till, in plain English. One install is one organisation and one number.',
    tasks: [
      {
        key: 'idea',
        title: 'The idea',
        steps: [
          'Studio mirrors the Safaricom organisation portal wherever the Daraja API allows, and lists what the API cannot do.',
          'Every page title carries Safaricom’s own name for the thing in grey underneath, so you can find it in Safaricom’s portal or documents.',
          'Sandbox is Safaricom’s practice area with pretend money. Production is your real M-Pesa account. The menu says which one you are in.',
          'Every form asks one question per screen, with Back and Continue. The last button says Review, then the verb (Send, Ask for payment, Create).',
          PASSWORD,
        ],
      },
    ],
  },
  {
    key: 'ready',
    title: 'Before you start: what to have ready',
    intro: 'Everything comes from Safaricom. Gather it once; the setup asks for it in this order.',
    tasks: [
      {
        key: 'have',
        title: 'From Safaricom',
        steps: [
          'Your paybill or till number, as on your Safaricom letter.',
          'A Daraja app: the consumer key and consumer secret from the Daraja developer portal, under My Apps.',
          'A public https address for this studio (the one you open in your browser). Safaricom posts payment results to it.',
          'If you will send money out: an API operator from the Safaricom portal, plus either its password and the Safaricom certificate (.cer), or a Security Credential generated on the Daraja portal.',
          'If you will prompt a customer’s phone to pay: the STK passkey from the Daraja portal, under Lipa Na M-Pesa Online for this number.',
        ],
        notes: ['Creating operators, giving them roles and resetting their portal passwords happen only in the Safaricom portal. See "Not possible via API".'],
      },
    ],
  },
  {
    key: 'setup',
    title: 'First-run setup',
    intro: 'The first person to open a new install becomes the owner and walks through up to ten steps. Back keeps your answers. Every step saves before moving on, so you can stop and come back.',
    tasks: [
      {
        key: 'wizard',
        title: 'The steps',
        path: '/setup',
        who: 'Owner',
        steps: [
          'Owner: your name, a username and a password of 12 or more characters. The name can be changed on the "Owner account created" screen; the username stays.',
          'Environment: Sandbox or Production. Start with Sandbox if you are still testing; switch later in Account.',
          'What you need: tick Receive money from customers, Send money to people or businesses, or both. A separate tick, "Prompt a customer’s phone to pay", is the one thing that needs a passkey. Your ticks decide which of the later steps appear.',
          'Your organization: business name, nominated number and notification phone (2547…). Shown in the menu and on receipts.',
          'Shortcode: your paybill or till number. Studio checks it with Safaricom and shows the name Safaricom holds for it.',
          'Daraja app: consumer key and secret. Studio tests them at once; "accepted" means Safaricom said yes.',
          'Public address: found from your browser’s address bar and shown read-only. Press Change only if people reach this studio through another domain. Test this address proves Safaricom can reach it.',
          'STK passkey (only if you ticked the phone prompt): paste it and give your own phone number. Studio sends one KES 1 prompt to your phone; you may cancel it. Safaricom accepting the request is the proof.',
          'API operator (only if you send money): the operator username as in the Safaricom portal, then either its password plus the certificate text, or a Security Credential. Studio tests it with a balance query and keeps it only if Safaricom accepts it. A refused one is removed and the name is free to try again.',
          'Done: says "All set", or names the step still missing and takes you there. Finish opens Home.',
        ],
        api: [
          { method: 'GET', path: '/api/setup/status', who: 'anyone, before setup is complete' },
          { method: 'POST', path: '/api/setup/owner', who: 'first person' },
          { method: 'POST', path: '/api/setup/environment', who: 'owner' },
          { method: 'POST', path: '/api/setup/uses', who: 'owner' },
          { method: 'POST', path: '/api/setup/org', who: 'owner' },
          { method: 'POST', path: '/api/setup/shortcode', who: 'owner' },
          { method: 'POST', path: '/api/setup/daraja', who: 'owner' },
          { method: 'POST', path: '/api/setup/public-url', who: 'owner' },
          { method: 'POST', path: '/api/setup/public-url/test', who: 'owner' },
          { method: 'POST', path: '/api/setup/passkey', who: 'owner' },
          { method: 'POST', path: '/api/setup/operator', who: 'owner' },
          { method: 'POST', path: '/api/setup/complete', who: 'owner' },
        ],
      },
    ],
  },
  {
    key: 'login',
    title: 'Logging in and finding your way',
    tasks: [
      {
        key: 'signin',
        title: 'Log in',
        path: '/login',
        who: 'Anyone with an account',
        steps: [
          'Type your username and password and press Log in.',
          'A temporary password (the one the owner gave you) must be replaced first: type it, then your new password of 12 or more characters, twice.',
          'Too many wrong tries locks the account for 15 minutes.',
        ],
        api: [
          { method: 'POST', path: '/api/auth/login', who: 'anyone; answers with a csrf token and sets the session cookie' },
          { method: 'GET', path: '/api/auth/me', who: 'signed in; who you are, your permissions, the organisation and the environment in use' },
          { method: 'POST', path: '/api/auth/change-password', who: 'signed in' },
          { method: 'POST', path: '/api/auth/logout', who: 'signed in' },
        ],
      },
      {
        key: 'menu',
        title: 'The menu',
        steps: [
          'The left menu shows your business name, your paybill or till number and the environment in use.',
          'Home and History come first. Then Get paid (Ask a customer to pay, Money in, QR codes, Invoices), Pay out (Send money, and Waiting for approval while approvals are on), and Manage (Settings, Advanced).',
          'Advanced opens a page of cards for things set up once or used now and then: Standing orders, Express checkout, Bonga points, Bulk send, Reverse a payment.',
          'Below the rule: How to use (this page) and Not possible via API.',
          'The account menu, top right under your name, has Organisation & shortcodes, Change password and Log out.',
        ],
      },
    ],
  },
  {
    key: 'home',
    title: 'Home',
    tasks: [
      {
        key: 'balances',
        title: 'Balances and the day’s shortcuts',
        path: '/',
        who: 'Anyone signed in',
        steps: [
          'The heading is the name Safaricom holds for your number, with the number, the environment and your own business name on the line under it.',
          'Utility account pays phones; Safaricom’s fees come from it. Working account holds customer payments and pays paybills and tills.',
          'Refresh asks Safaricom for today’s balance. "As of" says when it was last read; "Charges paid" is the fees so far. A balance more than a day old is flagged.',
          'Three tiles open the most used pages: Send money, Ask a customer to pay, History.',
          'Recent requests shows the last five; View all opens History.',
          'If something is still missing, Home says so at the top: no API operator (you cannot send yet), public address not tested (Safaricom cannot reach you), STK passkey not set (Ask a customer to pay is off).',
        ],
        api: [
          { method: 'GET', path: '/api/balances/latest', who: 'signed in' },
          { method: 'POST', path: '/api/balances/refresh', who: 'balances.view' },
          { method: 'GET', path: '/api/requests?limit=5', who: 'lookup.view' },
        ],
      },
    ],
  },
  {
    key: 'history',
    title: 'History',
    tasks: [
      {
        key: 'find',
        title: 'Find a payment',
        safaricom: 'Account Statement',
        path: '/history',
        who: 'Anyone signed in',
        steps: [
          'Type a phone number, a name or an M-Pesa receipt in the search box.',
          'Narrow by date (from, to), by direction (In and out, Money in, Money out) and by status (Paid, Waiting, Failed, Needs a check, Preparing, Cancelled).',
          'Seven rows a page; Previous and Next at the bottom.',
          'Press a row to open the request page: amount, who, receipt, when, and the timeline (Created, Sent, Result) with where the result came from.',
          'A receipt that was not sent from here shows "This receipt was not sent from here" and a button, Ask Safaricom about this receipt. The answer lands on the same page within a few minutes.',
        ],
        api: [
          { method: 'GET', path: '/api/requests', who: 'lookup.view; filters as query strings' },
          { method: 'GET', path: '/api/requests/:id', who: 'lookup.view' },
          { method: 'POST', path: '/api/lookup', who: 'lookup.view; body { receipt }' },
        ],
      },
      {
        key: 'request',
        title: 'On a request page',
        path: '/requests/:id',
        steps: [
          'Needs a check means Safaricom never answered. Press Check with Safaricom now; Studio also checks on its own five times.',
          'Mark as checked records what you found by other means (for example, "Paid, seen in the portal").',
          'Send again reopens Send money with the same details (nothing is sent until you go through Review again). Reverse this payment opens Reverse with the receipt filled in, for a paid customer payment.',
        ],
        api: [
          { method: 'POST', path: '/api/requests/:id/check', who: 'signed in' },
          { method: 'POST', path: '/api/requests/:id/checked', who: 'lookup.view, password; body { note }' },
        ],
      },
    ],
  },
  {
    key: 'get-paid',
    title: 'Get paid',
    intro: 'Money coming in. Nothing here takes money from your accounts.',
    tasks: [
      {
        key: 'stk',
        title: 'Ask a customer to pay',
        safaricom: 'STK Push',
        path: '/ask-to-pay',
        who: 'Owner, Operator (stk.request)',
        steps: [
          'Customer’s phone number.',
          'Amount in KES, whole shillings.',
          'What is this for? An invoice or order number, shown to the customer and on your statement.',
          'Short description, optional, up to 13 characters, shown on the prompt.',
          'Review, then Ask for payment. The customer has about a minute to enter their M-Pesa PIN.',
          'The page waits and then says Paid or Not paid; the receipt goes to History. Ask someone else starts over.',
        ],
        notes: ['Asking the same number for the same amount twice in a row is questioned first: "You asked for this already at … Ask again?"', 'Needs the STK passkey (Settings). Without it the page is off and Home says so.'],
        api: [{ method: 'POST', path: '/api/collect/stk', who: 'stk.request; body { phone, amountCents, reference, description? }' }],
      },
      {
        key: 'money-in',
        title: 'Money in',
        safaricom: 'C2B',
        path: '/money-in',
        who: 'Owner turns it on; anyone signed in reads it',
        steps: [
          'Turn on once. Studio tells Safaricom where to post customer payments; the page re-reads on its own and then says "On since …" or shows Safaricom’s refusal in three lines.',
          'If Safaricom says the addresses were already on record, that counts as on. Should a payment then never show, an older address may be on record; Safaricom API support can reset it.',
          'Every customer payment to your number then shows here and in History the moment Safaricom reports it.',
          'Check for missed payments asks Safaricom for anything whose report never arrived. Studio does the same every hour on its own.',
        ],
        notes: ['Every payment is accepted. Safaricom only asks Studio to approve payments if its support team has switched that on for your number.', 'Test the public address in Settings first; Safaricom must be able to reach this studio.'],
        api: [
          { method: 'GET', path: '/api/money-in/status', who: 'money_in.view' },
          { method: 'GET', path: '/api/money-in/recent', who: 'money_in.view' },
          { method: 'POST', path: '/api/money-in/register', who: 'owner, password; answers 202 and works in the background' },
          { method: 'POST', path: '/api/money-in/check', who: 'money_in.view' },
        ],
      },
      {
        key: 'qr',
        title: 'QR codes',
        safaricom: 'Dynamic QR',
        path: '/qr',
        who: 'Owner, Operator (qr.generate)',
        steps: [
          'How customers pay: Pay Bill or Buy Goods (till).',
          'Payment reference: an order or account reference, up to 32 characters.',
          'Who sets the amount: a fixed amount, or the customer enters it.',
          'Amount in KES (when fixed). Create QR code shows the code to print or show on a screen.',
        ],
        notes: ['A scan does not confirm payment. Check your M-Pesa confirmation, or Money in.'],
        api: [{ method: 'POST', path: '/api/qr', who: 'qr.generate' }],
      },
      {
        key: 'invoices',
        title: 'Invoices',
        safaricom: 'Bill Manager',
        path: '/invoices',
        who: 'Owner sets it up; Owner, Operator (invoices.manage) send and cancel',
        steps: [
          'Set up once per environment (owner): business email, official contact phone, whether Safaricom should send payment reminders, then your password.',
          'New invoice: customer name, customer phone, what the invoice is for, account reference (up to 20 characters; payments are matched by it), billed period, due date, line items (optional, one per line: name, amount), amount. Send the invoice: the customer gets an SMS with a pay prompt.',
          'Many at once: one line per invoice (name, phone, invoice name, account, period, due date as YYYY-MM-DD, amount). Studio checks every line, then Send them all.',
          'Show Open, Overdue, Paid, Cancelled or All; search by name, reference or account.',
          'Open an invoice to see its payments. Cancel this invoice stops it; select several to Cancel them together.',
          'Record a payment made another way (cash, bank): when, how much, a reference, who paid. Safaricom is told, so reminders stop.',
        ],
        notes: ['Payments through M-Pesa land against the invoice the moment Safaricom reports them, and in History as "Invoice paid".'],
        api: [
          { method: 'GET', path: '/api/invoices/settings', who: 'invoices.manage' },
          { method: 'POST', path: '/api/invoices/opt-in', who: 'owner, password' },
          { method: 'GET', path: '/api/invoices', who: 'invoices.manage' },
          { method: 'GET', path: '/api/invoices/:id', who: 'invoices.manage' },
          { method: 'POST', path: '/api/invoices', who: 'invoices.manage' },
          { method: 'POST', path: '/api/invoices/bulk/check', who: 'invoices.manage' },
          { method: 'POST', path: '/api/invoices/bulk', who: 'invoices.manage' },
          { method: 'POST', path: '/api/invoices/:id/cancel', who: 'invoices.manage' },
          { method: 'POST', path: '/api/invoices/cancel', who: 'invoices.manage; body { ids }' },
          { method: 'POST', path: '/api/invoices/:id/payment', who: 'invoices.manage' },
        ],
      },
      {
        key: 'standing-orders',
        title: 'Standing orders',
        safaricom: 'M-Pesa Ratiba',
        path: '/standing-orders',
        who: 'Owner, Operator (standing_orders.manage)',
        steps: [
          'Press New standing order.',
          'A name for this order (shown to the customer; one name per customer).',
          'Customer’s phone number.',
          'Amount each time, in KES.',
          'How often: once, every day, week, month, two months, three months, six months or year.',
          'First collection date, then last collection date.',
          'Account reference (what the payments are for, up to 12 characters), then a short note (optional, up to 13 characters).',
          'Review, then Create the standing order. The customer gets a prompt to agree; the page updates on its own.',
        ],
        notes: ['Once agreed, nothing about the order can be changed. To change it, create a new one and ask the customer to stop the old one on their phone.', 'Each collection shows in History as money in.'],
        api: [{ method: 'POST', path: '/api/collect/ratiba', who: 'standing_orders.manage' }],
      },
      {
        key: 'express',
        title: 'Express checkout',
        safaricom: 'B2B Express Checkout',
        path: '/express',
        who: 'Owner, Operator (express.checkout)',
        steps: [
          'Their till or paybill number: the business that is paying you.',
          'Amount in KES.',
          'What is this for? An order or invoice number, shown on their prompt.',
          'Your name as they know you, optional.',
          'Review, then Ask for payment. They approve on their phone; the money arrives in your paybill.',
        ],
        api: [{ method: 'POST', path: '/api/collect/express', who: 'express.checkout' }],
      },
      {
        key: 'bonga',
        title: 'Bonga points',
        safaricom: 'Lipa na Bonga',
        path: '/bonga',
        who: 'Owner, Operator (bonga.redeem)',
        steps: [
          'How many points? Studio shows what they are worth at Safaricom’s current rate.',
          'Customer’s phone number.',
          'What is this for? An order or invoice number; the payment is matched to it.',
          'Review, then Send the prompt. The customer enters their M-Pesa PIN to pay with points.',
        ],
        notes: ['Safaricom pays the shilling value into your paybill the same way a customer payment arrives, so Money in must be on.'],
        api: [
          { method: 'POST', path: '/api/collect/bonga/calculate', who: 'bonga.redeem; body { points }' },
          { method: 'POST', path: '/api/collect/bonga/redeem', who: 'bonga.redeem' },
        ],
      },
    ],
  },
  {
    key: 'pay-out',
    title: 'Pay out',
    intro: 'Money leaving your accounts. Every send asks for your password.',
    tasks: [
      {
        key: 'send-phone',
        title: 'Send money to a phone',
        safaricom: 'Initiate Transaction › Business Payment to Customer',
        path: '/send/phone',
        who: 'Owner, Operator (send.phone)',
        steps: [
          'Open Send money and press To a phone. (The other kinds, to a business wallet, a paybill, a till, float moves, top-ups and KRA, say Coming soon.)',
          'Phone number.',
          'Amount in KES, whole shillings.',
          'What kind of payment is this? One of your own categories (Settings › Payment categories); each maps to Safaricom’s Business payment, Salary or Promotion.',
          'Note, optional.',
          'Review: Utility balance now and after, the fee note, and the per-send cap if one is set. Safaricom cannot check the name before sending, so check the number.',
          'Send, then your password. The page says Sent, then Paid or Not paid; the receipt goes to History.',
        ],
        notes: [
          'The same amount to the same number twice in a row is questioned first: "You sent this already at … Send again?"',
          'When Settings › Approvals is on and the amount is at or above the threshold, the send is held for a second person instead of going out. Nothing leaves your account until it is released.',
          'Needs a working API operator (Settings). Without one Home says you cannot send yet.',
        ],
        api: [
          { method: 'GET', path: '/api/send/categories', who: 'signed in' },
          { method: 'POST', path: '/api/send/phone', who: 'send.phone, password; body { phone, amountCents, category, remarks? }' },
        ],
      },
      {
        key: 'bulk',
        title: 'Bulk send',
        safaricom: 'Bulk Task › Bulk Payment',
        path: '/bulk',
        who: 'Owner, Operator (bulk.send)',
        steps: [
          'Paste the list into The list, one line per person: phone, amount, name, note (the first two are needed), or Upload a file (CSV). Download a template gives the layout.',
          'Check the list. Every line is checked before anything moves; lines that need fixing are named. Nothing is sent until all pass.',
          'Send them all, then your password. Each row goes out in turn as an ordinary send, so the duplicate guard, the cap and the approval hold all apply; a failed row never stops the rest.',
          'The batch page shows every row live. Try the failed rows again resends only rows Studio refused before Safaricom. Download results gives a CSV.',
          'Batches lists every earlier batch.',
        ],
        api: [
          { method: 'POST', path: '/api/send/bulk/check', who: 'bulk.send' },
          { method: 'POST', path: '/api/send/bulk', who: 'bulk.send, password' },
          { method: 'GET', path: '/api/send/bulk', who: 'bulk.send' },
          { method: 'GET', path: '/api/send/bulk/:id', who: 'bulk.send' },
          { method: 'POST', path: '/api/send/bulk/:id/retry', who: 'bulk.send, password' },
        ],
      },
      {
        key: 'approvals',
        title: 'Waiting for approval',
        safaricom: 'Review Transaction',
        path: '/approvals',
        who: 'Approver (send.approve) releases or refuses; anyone signed in sees the count',
        steps: [
          'Turn it on in Settings › Approvals: hold sends of this amount or more (0 turns it off). It applies to everyone, the owner included.',
          'Give somebody the Approver role in People, or nothing can be released.',
          'The menu shows Waiting for approval, with a count, while approvals are on or a send still waits.',
          'Each held send shows the amount, who it is to, the category and note, who made it and when. Release asks for your password and sends it. Refuse asks why; the maker sees the reason.',
          'Nobody can release or refuse their own send. A held send is refused on its own after 24 hours.',
        ],
        api: [
          { method: 'GET', path: '/api/approvals', who: 'send.approve' },
          { method: 'GET', path: '/api/approvals/count', who: 'signed in; { count, enabled }' },
          { method: 'POST', path: '/api/approvals/:id/release', who: 'send.approve, password' },
          { method: 'POST', path: '/api/approvals/:id/refuse', who: 'send.approve; body { reason }' },
          { method: 'PUT', path: '/api/settings/approval-threshold', who: 'owner, password; body { cents }' },
        ],
      },
      {
        key: 'reverse',
        title: 'Reverse a payment',
        safaricom: 'Reversal',
        path: '/reverse',
        who: 'Owner, Operator (reverse.request)',
        steps: [
          'Type the M-Pesa receipt (10 letters and numbers) and press Find that payment. Only a payment that settled here can be reversed.',
          'Check the amount and the receipt: a reversal cannot be undone.',
          'Reverse, then your password. Safaricom takes the money back from the customer; the page says Reversed or Not reversed, and the reversal shows in History.',
        ],
        notes: ['Safaricom can only take back money the customer still has. If it is spent, the reversal is refused.'],
        api: [
          { method: 'GET', path: '/api/send/reversal/:receipt', who: 'reverse.request' },
          { method: 'POST', path: '/api/send/reversal', who: 'reverse.request, password' },
        ],
      },
    ],
  },
  {
    key: 'settings',
    title: 'Settings',
    intro: 'Every value is shown read-only. Press Change or Replace to edit it; saving asks for the owner’s password.',
    tasks: [
      {
        key: 'organisation',
        title: 'Organisation',
        safaricom: 'My Preference',
        path: '/settings',
        who: 'Owner edits; anyone signed in reads',
        steps: [
          'Business name and contacts: the name in the menu and on receipts, the nominated number and the notification phone.',
          'Public address: the https address Safaricom posts to. Test it after any change.',
          'Safaricom verification: for Sandbox and Production, whether the number, the Daraja key and secret, and a working API operator are in place.',
          'Who can log in: Manage people opens the People page.',
          'Safaricom callback addresses: the Safaricom IP addresses Studio accepts payment reports from. Change only if Safaricom publishes new ones.',
          'Callback secret: part of the address Safaricom posts to. Show the callback secret asks for your password; treat it like a password.',
          'Appearance: System, Light or Dark.',
        ],
        api: [
          { method: 'GET', path: '/api/settings', who: 'owner' },
          { method: 'PUT', path: '/api/settings/org', who: 'owner, password' },
          { method: 'PUT', path: '/api/settings/public-url', who: 'owner, password' },
          { method: 'POST', path: '/api/settings/public-url/test', who: 'owner' },
          { method: 'PUT', path: '/api/settings/allowlist', who: 'owner, password' },
          { method: 'POST', path: '/api/settings/install-secret/reveal', who: 'owner, password' },
        ],
      },
      {
        key: 'environment',
        title: 'Sandbox settings and Production settings',
        who: 'Owner',
        steps: [
          'Studio shows the settings of the environment you are in. Switch environments in Account.',
          'Daraja app: consumer key (last four shown) and secret; Replace tests the new pair before saving it.',
          'B2C API version: Automatic (recommended), v1 or v3.',
          'STK passkey: Replace; the new one is tested with a KES 1 prompt to your phone.',
          'Certificate: the Safaricom .cer text, needed only when adding an operator by password.',
          'API operators: Add operator (by password and certificate, or by Security Credential), Test again (a balance query), New password or New credential, Turn off. The password expiry date Safaricom set is shown.',
        ],
        api: [
          { method: 'POST', path: '/api/settings/environments/:env/daraja', who: 'owner, password' },
          { method: 'PUT', path: '/api/settings/environments/:env/b2c-api', who: 'owner, password' },
          { method: 'POST', path: '/api/settings/environments/:env/passkey', who: 'owner, password' },
          { method: 'GET', path: '/api/settings/environments/:env/operators', who: 'owner' },
          { method: 'POST', path: '/api/settings/environments/:env/operators', who: 'owner, password' },
          { method: 'POST', path: '/api/settings/operators/:id/probe', who: 'owner' },
          { method: 'POST', path: '/api/settings/operators/:id/rotate', who: 'owner, password' },
          { method: 'POST', path: '/api/settings/operators/:id/disable', who: 'owner, password' },
        ],
      },
      {
        key: 'categories',
        title: 'Payment categories, Approvals, Invoices',
        who: 'Owner',
        steps: [
          'Payment categories: your own names for a send (Personal use, Rent, …); each goes to Safaricom as Business payment, Salary or Promotion. Add, Edit, Delete; keep at least one.',
          'Approvals: Second person, Off or "Hold sends of KES … or more". Change, type the amount, save with your password.',
          'Invoices: whether invoicing is set up and whether reminders are on. Set it up from the Invoices page.',
        ],
        api: [{ method: 'PUT', path: '/api/settings/send-categories', who: 'owner, password' }],
      },
    ],
  },
  {
    key: 'people',
    title: 'People',
    tasks: [
      {
        key: 'roles',
        title: 'Who can log in',
        safaricom: 'Organization Operator',
        path: '/people',
        who: 'Owner',
        steps: [
          'Open Settings › Who can log in › Manage people, or go to /people.',
          'Add somebody: their name, a username, what they may do, and a temporary password (Suggest another gives a new one). Add them, then your password.',
          'Tell them the temporary password yourself; Studio shows it once. They must change it at first login.',
          'Roles: Owner does everything. Operator can send money and ask customers to pay. Viewer can only look. Approver can release or refuse held sends.',
          'On each person: change what they may do, New temporary password, Switch off (they cannot log in) and Switch on.',
        ],
        notes: ['These are Studio logins. Safaricom portal operators are separate and are managed in the Safaricom portal.'],
        api: [
          { method: 'GET', path: '/api/people', who: 'signed in' },
          { method: 'POST', path: '/api/people', who: 'owner, password' },
          { method: 'PUT', path: '/api/people/:id/role', who: 'owner, password' },
          { method: 'POST', path: '/api/people/:id/reset-password', who: 'owner, password' },
          { method: 'POST', path: '/api/people/:id/suspend', who: 'owner, password' },
          { method: 'POST', path: '/api/people/:id/resume', who: 'owner, password' },
        ],
      },
    ],
  },
  {
    key: 'account',
    title: 'Account',
    tasks: [
      {
        key: 'mode',
        title: 'Organisation & shortcodes',
        path: '/account',
        who: 'Owner',
        steps: [
          'Open the account menu (top right) and press Organisation & shortcodes.',
          'Mode: Sandbox for testing, or Production. Switching a finished studio to Production asks you to type the paybill or till number back, then your password.',
          'Shortcodes: the paybill or till number for each environment, with Change. Check the name with Safaricom fetches the name Safaricom holds and whether it is a paybill or a till.',
          'Change password, from the same menu: your current password, then the new one twice.',
          'Delete this studio, at the bottom: removes the organisation, its people, credentials and history and returns the install to first-run setup. It asks for your password and the organisation name typed exactly. It cannot be undone.',
        ],
        api: [
          { method: 'PUT', path: '/api/settings/mode', who: 'owner, password' },
          { method: 'PUT', path: '/api/settings/environments/:env/shortcode', who: 'owner, password' },
          { method: 'POST', path: '/api/settings/environments/:env/shortcode/verify', who: 'owner' },
          { method: 'PUT', path: '/api/auth/display-name', who: 'signed in' },
          { method: 'POST', path: '/api/org/wipe', who: 'owner, password, name typed' },
        ],
      },
    ],
  },
  {
    key: 'results',
    title: 'Reading a result',
    tasks: [
      {
        key: 'status',
        title: 'The status words',
        steps: [
          'Preparing: Studio has the request and is about to send it to Safaricom.',
          'Waiting: Safaricom has it and has not answered yet. Most answers come within seconds; a phone prompt waits for the customer.',
          'Paid: done; the receipt is shown.',
          'Failed: Safaricom refused it. The three lines under it say why.',
          'Needs a check: Safaricom never answered. Studio checks five times on its own; you can press Check with Safaricom now, or Mark as checked once you know.',
          'Waiting for approval: held for a second person. Nothing has left your account.',
          'Rejected: a second person refused it, or 24 hours passed.',
          'Cancelled: you stopped it before it went out.',
        ],
      },
      {
        key: 'errors',
        title: 'When something is refused',
        steps: [
          'Safaricom said: Safaricom’s own words, unchanged.',
          'What it means: the plain-English meaning from the Daraja catalogue.',
          'What to do now: the next step, for example add an operator, top up Utility, or try again in a moment.',
        ],
        notes: ['"Something went wrong on our side" is Studio, not Safaricom: try again in a moment, and check Settings if it keeps happening.'],
      },
    ],
  },
  {
    key: 'not-possible',
    title: 'What the API cannot do',
    tasks: [
      {
        key: 'portal',
        title: 'Portal-only tasks',
        path: '/not-possible',
        steps: [
          'Withdrawing to the bank, moving float from Utility to Working, creating operators and roles, resetting portal passwords, KYC, bank accounts, tills, settlement plans, closing the organisation, Safaricom’s own statement, changing registered paybill URLs and the portal audit log all live in the Safaricom portal.',
          'Not possible via API lists each one with why, where in the portal, and the USSD code where one exists.',
        ],
      },
    ],
  },
];

/** Where an AI agent stands. Verbatim from the project’s live-money rules; only in guide.md, never on the page. */
export const agentSection = {
  title: 'For AI agents and scripts',
  intro: 'Studio is a web app over a JSON API. An agent can read everything a signed-in person can; it never moves money.',
  session: [
    'Log in with POST /api/auth/login { username, password }. The answer carries csrf; the session is a cookie.',
    'Send the csrf value as the x-csrf-token header on every request that is not GET.',
    'GET /api/auth/me tells you who you are, your permissions, the organisation, its number and the environment in use (sandbox or production).',
    'GET /api/events is a server-sent events stream: request.updated, money_in.updated, invoice.updated, bulk.updated. Re-read the page or the record when one arrives.',
    'Errors are JSON: { error: { code, message, details? } }. A Safaricom refusal carries details.safaricomSaid, details.meaning and details.whatToDo. Show all three lines, never merged.',
    'Every page route above is a browser route; the API paths beside each task are what the page calls.',
  ],
  rules: [
    'An AI agent never moves money. It must not press Send, Ask for payment, Send the prompt, Create the standing order, Send them all, Release, Reverse or Turn on, and must not call POST /api/send/phone, /api/send/bulk, /api/send/reversal, /api/approvals/:id/release, /api/collect/stk, /api/collect/ratiba, /api/collect/express, /api/collect/bonga/redeem, /api/invoices, /api/invoices/bulk or /api/money-in/register. Only a person does those, in the browser, with their password.',
    'An agent may read every page and record, look up a receipt (POST /api/lookup), refresh balances (POST /api/balances/refresh), test the public address, and ask Safaricom to check a request (POST /api/requests/:id/check).',
    'Never log, store or repeat a phone number, a receipt, a password, a key, a secret, a passkey or a Security Credential.',
    'Never type a password, key or secret on a person’s behalf; ask them to do it themselves.',
    'When a form is on screen, it is one question per screen: answer, Continue, until Review. Stop at Review unless a person presses the last button.',
  ],
};
