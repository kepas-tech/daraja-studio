/**
 * The manual, as data. One source feeds the How to use page (`pages/Guide.tsx`) and the plain-text
 * copy at `public/guide.md`. Written from a walk through every page of the live studio and
 * Safaricom's own help pages on 2026-09-16, in the order a new owner meets them.
 *
 * Two readers, one text. People read the page: everyday words, no jargon; where they must fetch
 * something from Safaricom, a link and the exact clicks. The page never shows `path`, `permission`
 * or `api`; those exist for the Markdown copy only.
 *
 * Keep this file free of anything beyond type annotations and one JSON import:
 * `scripts/guide-md.mjs` loads it with Node's type stripping.
 */
import links from './safaricomLinks.json' with { type: 'json' };

export type GuideApi = { method: 'GET' | 'POST' | 'PUT'; path: string; who: string };
/** A place on a Safaricom site: the button opens it, the trail says what to click once there. */
export type GuideLink = { label: string; href: string; trail: string[] };
export type GuideTask = {
  key: string;
  title: string;
  /** Safaricom's own name for it, shown in grey under the title. */
  safaricom?: string | null;
  /** Where it is in Studio, as the menu reads: ['Get paid', 'Ask a customer to pay']. Shown to people. */
  where?: string[];
  /** Who can do it, in everyday words. Shown to people. */
  who?: string;
  /** Numbered, in the order the screens go. */
  steps: string[];
  /** Things to know, unnumbered. */
  notes?: string[];
  /** Safaricom pages to open, with the clicks. */
  links?: GuideLink[];
  /** The browser route. Markdown copy only. */
  path?: string;
  /** The permission key that guards it. Markdown copy only. */
  permission?: string;
  /** The calls behind the page. Markdown copy only. */
  api?: GuideApi[];
};
export type GuideSection = { key: string; title: string; intro?: string; tasks: GuideTask[] };

export const guideTitle = 'How to use Daraja Studio';
export const guideIntro = 'Every page, in the order you meet them. Each task is numbered the way the screens go, and wherever you need something from Safaricom there is a link and the exact clicks.';
/** Only guide.md carries this line; the page for people never mentions the machine copy. */
export const guideMachineLine = 'This is the copy for AI agents and scripts. The page people see at /guide has the same tasks in everyday words, without the routes, permission keys, API calls or the agent rules.';


const DARAJA = ['Daraja portal', 'Log In'];
const ORG = ['M-Pesa business portal', 'Log in as the Business Administrator (paybill or till number, username, password, the code on screen, then the code sent by SMS)'];

/**
 * Every place Studio sends a person to on Safaricom's sites, with the clicks once there. Read
 * off the live portals on 2026-09-16. Shared by the guide and by the setup and Settings screens,
 * so a hint on a form and the manual can never disagree.
 */
export const how = {
  createApp: { label: 'Open My Apps on the Daraja portal', href: links.darajaMyApps, trail: [...DARAJA, 'My Apps', 'Create Sandbox App', 'Application Name', 'tick the products', 'Create App'] },
  keys: { label: 'Open My Apps on the Daraja portal', href: links.darajaMyApps, trail: [...DARAJA, 'My Apps', 'your app card', 'the copy icon next to Consumer Key', 'then the one next to Consumer Secret'] },
  passkeyProduction: { label: 'Open My Apps on the Daraja portal', href: links.darajaMyApps, trail: [...DARAJA, 'My Apps', 'your Production app card', 'the copy icon next to Passkey'] },
  passkeySandbox: { label: 'Open the M-Pesa Express simulator', href: links.darajaExpressSimulate, trail: [...DARAJA, 'APIs', 'M-Pesa Express(Prompt)', 'Simulate', 'Open Simulator', 'Select or search one of your apps', 'your sandbox app', 'the Passkey box'] },
  credential: { label: 'Open Test Credentials on the Daraja portal', href: links.darajaTestCredentials, trail: [...DARAJA, 'Test Credentials', 'Initiator Password', 'Sandbox or Production', 'Generate Password', 'copy the long text'] },
  certificateSandbox: { label: 'Download the Sandbox certificate', href: links.certificateSandbox, trail: ['a file called SandboxCertificate.cer downloads'] },
  certificateProduction: { label: 'Download the Production certificate', href: links.certificateProduction, trail: ['a file called ProductionCertificate.cer downloads'] },
  goLive: { label: 'Open Go Live on the Daraja portal', href: links.darajaGoLive, trail: [...DARAJA, 'Go Live', 'Verification Type: Short Code', 'Organization ShortCode', 'Organization Name', 'M-PESA Username', 'tick the Terms and Conditions', 'Next', 'type the code sent by SMS'] },
  urlManagement: { label: 'Open URL Management on the Daraja portal', href: links.darajaUrlManagement, trail: [...DARAJA, 'Self Service', 'URL Management', 'View URLs', 'paybill or till number', 'M-PESA admin username', 'the code sent by SMS'] },
  orgPortal: { label: 'Open the M-Pesa business portal', href: links.orgPortal, trail: ORG },
  operatorCreate: { label: 'Open the M-Pesa business portal', href: links.orgPortal, trail: [...ORG, 'Operators', 'Add', 'Username', 'Access channel: API', 'Web profile: default rule profile', 'Roles: ORG B2C API Initiator, Balance Query ORG API, Transaction Status query ORG API', 'the person’s details', 'Submit'] },
  operatorPassword: { label: 'Open the M-Pesa business portal', href: links.orgPortal, trail: ['M-Pesa business portal', 'Log in as a Business Manager (a user with the Set Restricted ORG API PASSWORD role)', 'My Functions', 'Operator Management', 'search the username', 'Operations', 'Set Password'] },
  number: { label: 'Open the M-Pesa business portal', href: links.orgPortal, trail: [...ORG, 'My Organization'] },
  businessEmail: { label: 'Email Safaricom’s business team', href: links.businessEmail, trail: ['a new email opens'] },
  apiSupport: { label: 'Email Safaricom’s API support', href: links.apiSupportEmail, trail: ['a new email opens'] },
} satisfies Record<string, GuideLink>;

export const guide: GuideSection[] = [
  {
    key: 'what',
    title: 'What Daraja Studio is',
    intro: 'Your M-Pesa paybill or till, on one screen, in everyday words. One Studio is one business and one number.',
    tasks: [
      {
        key: 'idea',
        title: 'The idea',
        steps: [
          'Studio does the things you would otherwise do on Safaricom’s business website, and tells you plainly which things still have to be done there.',
          'Under every page title, in grey, is the name Safaricom uses for the same thing, so you can find it on Safaricom’s site or ask their support about it.',
          'Sandbox is Safaricom’s practice area with pretend money. Production is your real M-Pesa account. The menu always says which one you are in.',
          'Every form asks one question per screen, with Back and Continue. The last button says Review, then the action (Send, Ask for payment, Create).',
          'Studio asks for your password before anything that moves money or changes who can log in.',
        ],
      },
    ],
  },
  {
    key: 'ready',
    title: 'Before you start: what to have ready',
    intro: 'Everything on this list comes from Safaricom. The next section shows where each one is and what to click.',
    tasks: [
      {
        key: 'have',
        title: 'The list',
        steps: [
          'Your paybill or till number.',
          'A Daraja app on Safaricom’s developer site, with its two codes: the "Consumer Key" and the "Consumer Secret".',
          'The web address people use to open this Studio. Safaricom sends payment news to it, so it must open from anywhere, not only inside your office.',
          'If you will send money out: a Safaricom portal user made for Studio (Safaricom calls it an operator), with its username, and either its password plus Safaricom’s certificate file, or a "Security Credential" made on the Daraja site.',
          'If you will prompt a customer’s phone to pay: the "Passkey" for your number.',
        ],
        notes: ['Sandbox needs none of the real ones: Safaricom gives practice codes on the Daraja site, and Studio works with those until you switch to Production.'],
      },
    ],
  },
  {
    key: 'safaricom',
    title: 'Getting things from Safaricom',
    intro: 'Two Safaricom websites matter. The Daraja portal is where your app, its two codes and the passkey live. The M-Pesa business portal is where your business, its users and your number live. Each task below has a button to the right page and the clicks once you are there, read off the live sites.',
    tasks: [
      {
        key: 'daraja-account',
        title: 'A Daraja account and an app',
        who: 'Owner',
        steps: [
          'Open the Daraja portal and press Log In, or Sign Up the first time (email and a password; Safaricom sends a confirmation).',
          'Once in, the left menu shows My Apps, Test Credentials, Go Live and APIs. Open My Apps.',
          'Press Create Sandbox App. Give it an Application Name (letters, numbers, spaces and the _ sign only; your business name is fine).',
          'Tick the products: "M-Pesa Sandbox" (covers receiving, sending and the rest), and "Lipa Na M-Pesa Sandbox" if you will prompt customers’ phones. Press Create App.',
          'Your app now shows as a card on My Apps with its Consumer Key, Consumer Secret, Passkey, Short Code and Products. A new app is Sandbox; real money needs Go Live, below.',
        ],
        links: [how.createApp],
      },
      {
        key: 'keys',
        title: 'The Consumer Key and Consumer Secret',
        who: 'Owner',
        steps: [
          'On My Apps, find your app’s card. Sandbox and Production apps are separate cards; use the one for the mode you are setting up.',
          'Press the small copy icon next to Consumer Key. Paste it into Studio’s "Consumer key" box.',
          'Press the copy icon next to Consumer Secret. Paste it into Studio’s "Consumer secret" box. Studio checks the pair with Safaricom at once and says "accepted".',
        ],
        notes: ['The eye icon on the card shows or hides the values; the copy icon works either way.'],
        links: [how.keys],
      },
      {
        key: 'go-live',
        title: 'Go Live: moving your app to real money',
        who: 'Owner, with the M-Pesa business portal administrator’s username and phone',
        steps: [
          'On the Daraja portal open Go Live. Verification Type stays "Short Code".',
          'Organization ShortCode: your paybill, till store number, head office number or B2C number. Organization Name: your business name, shortened, without symbols.',
          'M-PESA Username: the username of the Business Administrator or Business Manager on the M-Pesa business portal. It is case sensitive.',
          'Tick "I accept Safaricom’s Terms and Conditions" and press Next. A one-time code goes by SMS to the phone on that portal user’s profile (it must be a Safaricom line). Type it.',
          'Safaricom answers within 24 working hours (Monday to Friday, 8am to 5pm). Your sandbox app is then moved to Production with a new Consumer Key and Secret, and the Passkey appears on the card.',
        ],
        notes: ['To send money to phones in Production your number must be one that can both receive and pay out. If the B2C product is missing at Go Live, ask Safaricom’s business team for a B2C or "one account" number.'],
        links: [how.goLive, how.businessEmail],
      },
      {
        key: 'passkey',
        title: 'The Passkey (only for prompting a customer’s phone)',
        who: 'Owner',
        steps: [
          'Production: on My Apps, your Production app card has a Passkey row. Press the copy icon next to it. Safaricom also emails it to the app owner after Go Live.',
          'Sandbox: open APIs, then M-Pesa Express(Prompt), then Simulate, then Open Simulator on the right. Pick your sandbox app under "Select or search one of your apps"; the test data fills in, including a Passkey box. Copy it.',
          'Paste it into Studio’s "STK passkey" screen with your own phone number. Studio sends one KES 1 prompt to your phone as the proof; cancel it on the phone, nothing is taken.',
        ],
        notes: ['Safaricom’s own words: you only need a passkey if your app has the Lipa na M-Pesa or M-Pesa Express product.'],
        links: [how.passkeyProduction, how.passkeySandbox],
      },
      {
        key: 'number',
        title: 'Your paybill or till number',
        who: 'Owner',
        steps: [
          'It is on the letter or email Safaricom sent when the number was opened, and on your Production app card on the Daraja portal as Short Code after Go Live.',
          'On the M-Pesa business portal it is under My Organization.',
          'Type it into Studio’s "Shortcode" screen. Studio asks Safaricom for the name held against it and shows the name, so you can see you typed the right number.',
        ],
        links: [how.number],
      },
      {
        key: 'org-portal',
        title: 'The M-Pesa business portal and its administrator',
        who: 'Owner',
        steps: [
          'The M-Pesa business portal is where Safaricom keeps your business, its users and its money. You need a Business Administrator login there before Go Live and before any portal user for Studio.',
          'If your business has none yet: Safaricom’s business team sets one up. Your number must first settle to a bank through a Head Office; the same team sends the forms. Then they create the Business Administrator username.',
          'First login: open the portal, type the paybill or till number, the administrator username and the first-time password from Safaricom’s email, then the code shown on screen, then the code sent by SMS. Set your own password and two security questions.',
          'After that, logging in is the number, username, password, the code on screen and the SMS code.',
        ],
        links: [how.orgPortal, how.businessEmail],
      },
      {
        key: 'operator',
        title: 'A portal user for Studio (Safaricom calls it an API operator)',
        who: 'Owner, as the Business Administrator',
        steps: [
          'Log in to the M-Pesa business portal as the Business Administrator and open Operators, then Add.',
          'Username: a name for Studio, for example your business name. Access channel: API. Web profile: default rule profile.',
          'Roles: tick ORG B2C API Initiator (sending money to phones), Balance Query ORG API (the balance on Home, and the test Studio runs) and Transaction Status query ORG API (checking a payment). Add Org Reversals Initiator if you will reverse payments.',
          'Fill in the person responsible and Submit. The user shows as pending until it has a password.',
          'The password is set by a portal user who has the Set Restricted ORG API PASSWORD role (a Business Manager): My Functions, then Operator Management, search the username, Operations, Set Password. Use letters, numbers and only # & % $ as symbols; never @ or a full stop, and no brackets.',
          'Type the username and that password into Studio’s "API operator" screen, with the certificate (next task). Studio asks Safaricom for your balance with them and keeps the user only if Safaricom accepts it.',
        ],
        notes: ['Studio never keeps the password itself, only a scrambled version made with Safaricom’s certificate.', 'Too many wrong tries lock the user ("security credential is locked"); the Business Administrator unlocks it on the portal.'],
        links: [how.operatorCreate, how.operatorPassword],
      },
      {
        key: 'certificate',
        title: 'Safaricom’s certificate file',
        who: 'Owner',
        steps: [
          'Press the button for the mode you are setting up: Sandbox or Production. A small file ending in .cer downloads.',
          'Open it with a plain text program: Notepad on Windows, TextEdit on a Mac (right-click the file, Open With). It is a block of letters between a BEGIN line and an END line.',
          'Select all of it, copy, and paste into Studio’s "Certificate" box (on the "API operator" screen during setup, or under Settings later).',
        ],
        links: [how.certificateSandbox, how.certificateProduction],
      },
      {
        key: 'security-credential',
        title: 'A "Security Credential" (instead of the password and certificate)',
        who: 'Owner',
        steps: [
          'This is the same scrambled password Studio would make for you, made on Safaricom’s site instead. Use it if you would rather not type the portal user’s password into Studio.',
          'On the Daraja portal open Test Credentials. Under "Generate Security Credential Value", type the portal user’s password as Initiator Password, choose Sandbox or Production, and press Generate Password.',
          'Copy the long text it shows. In Studio’s "API operator" screen choose "I already generated a Security Credential on the Daraja portal" and paste it.',
        ],
        links: [how.credential],
      },
      {
        key: 'url-management',
        title: 'Where Safaricom sends news of customer payments',
        who: 'Owner',
        steps: [
          'Studio registers its own address with Safaricom when you press Turn on under Money in. In Production, Safaricom accepts that once per number.',
          'If Safaricom says the addresses are already on record and payments still do not show, an older address is on record. Open URL Management on the Daraja portal, press View URLs, prove it is you (paybill or till number, the M-PESA admin username, the SMS code), then delete the old ones and press Turn on again in Studio.',
        ],
        links: [how.urlManagement, how.apiSupport],
      },
    ],
  },
  {
    key: 'setup',
    title: 'First-run setup',
    intro: 'The first person to open a new Studio becomes the owner and walks through up to ten steps. Back keeps your answers, and every step saves before moving on, so you can stop and come back later.',
    tasks: [
      {
        key: 'wizard',
        title: 'The steps',
        who: 'Owner',
        path: '/setup',
        steps: [
          'Owner: your name, a username and a password of 12 or more characters. You can change the name on the "Owner account created" screen; the username stays.',
          'Environment: Sandbox or Production. Start with Sandbox if you are still trying things out; you can switch later under Account.',
          'What you need: tick "Receive money from customers", "Send money to people or businesses", or both. A separate tick, "Prompt a customer’s phone to pay", is the one thing that needs the passkey. Your ticks decide which of the later steps appear.',
          'Your organization: business name, nominated number and notification phone (starting 2547). Shown in the menu and on receipts.',
          'Shortcode: your paybill or till number. Studio checks it with Safaricom and shows the name Safaricom holds for it.',
          'Daraja app: paste the "Consumer Key" and "Consumer Secret" (see Getting things from Safaricom). Studio tests them at once; "accepted" means Safaricom said yes.',
          'Public address: Studio reads the address from your browser and shows it. Press Change only if people open Studio through a different address. Press "Test this address" so Safaricom can prove it reaches you.',
          'STK passkey (only if you ticked the phone prompt): paste the passkey and give your own phone number. Studio sends one KES 1 prompt to your phone; cancel it, nothing is taken.',
          'API operator (only if you send money): the portal user’s username, then either its password plus the certificate text, or a "Security Credential". Studio tests it with a balance check and keeps it only if Safaricom accepts it. A refused one is removed and the name is free to try again.',
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
        who: 'Anyone with a login',
        path: '/login',
        steps: [
          'Type your username and password and press Log in.',
          'If the owner gave you a temporary password, Studio asks you to choose your own first: type the temporary one, then your new password of 12 or more characters, twice.',
          'Too many wrong tries locks the login for 15 minutes.',
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
          'The left menu shows your business name, your paybill or till number and whether you are in Sandbox or Production.',
          'Home and History come first. Then Get paid (Ask a customer to pay, Money in, QR codes, Invoices), Pay out (Send money, and Waiting for approval while approvals are on), and Manage (Settings, Advanced).',
          'Advanced opens a page of cards for things you set up once or use now and then: Standing orders, Express checkout, Bonga points, Bulk send, Reverse a payment.',
          'Below the line: How to use (this page) and Not possible via API.',
          'Your name at the top right opens the account menu: Organisation & shortcodes, Change password, Log out.',
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
        title: 'Your balances and the day’s shortcuts',
        where: ['Home'],
        who: 'Anyone logged in',
        path: '/',
        steps: [
          'The heading is the name Safaricom holds for your number. Under it: the number, Sandbox or Production, and your own business name.',
          'Utility account is the money you pay out to phones; Safaricom’s fees come from it too. Working account is where customer payments land; it also pays other paybills and tills.',
          'Refresh asks Safaricom for today’s balance. "As of" says when it was last read; "Charges paid" is the fees so far. A balance more than a day old is flagged.',
          'Three tiles open the pages used most: Send money, Ask a customer to pay, History.',
          'Recent requests shows the last five; View all opens History.',
          'If something is still missing, Home says so at the top: no portal user (you cannot send yet), address not tested (Safaricom cannot reach you), passkey not set (Ask a customer to pay is off).',
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
        where: ['History'],
        who: 'Anyone logged in',
        path: '/history',
        permission: 'lookup.view',
        steps: [
          'Type a phone number, a name or an M-Pesa receipt in the search box.',
          'Narrow it down by date (from, to), by direction (In and out, Money in, Money out) and by status (Paid, Waiting, Failed, Needs a check, Preparing, Cancelled).',
          'Seven rows a page; Previous and Next at the bottom.',
          'Press a row to open the payment’s own page: amount, who, receipt, when, and the timeline (Created, Sent, Result) with where the result came from.',
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
        title: 'On a payment’s page',
        where: ['History', 'a row'],
        path: '/requests/:id',
        steps: [
          'Needs a check means Safaricom never answered. Press Check with Safaricom now; Studio also checks on its own five times.',
          'Mark as checked records what you found out another way (for example, "Paid, seen on Safaricom’s site").',
          'Send again reopens Send money with the same details; nothing goes out until you go through Review again. Reverse this payment opens Reverse with the receipt filled in, for a customer payment that was paid.',
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
    intro: 'Money coming in. Nothing here takes money out of your accounts.',
    tasks: [
      {
        key: 'stk',
        title: 'Ask a customer to pay',
        safaricom: 'STK Push',
        where: ['Get paid', 'Ask a customer to pay'],
        who: 'Owner or Operator',
        path: '/ask-to-pay',
        permission: 'stk.request',
        steps: [
          'Customer’s phone number.',
          'Amount in KES, whole shillings.',
          'What is this for? An invoice or order number; the customer sees it, and so does your statement.',
          'Short description, optional, up to 13 characters, shown on the customer’s phone.',
          'Review, then Ask for payment. The customer has about a minute to enter their M-Pesa PIN.',
          'The page waits and then says Paid or Not paid; the receipt goes to History. Ask someone else starts over.',
        ],
        notes: ['Asking the same number for the same amount twice in a row is questioned first: "You asked for this already at … Ask again?"', 'Needs the passkey (Settings). Without it the page is off and Home says so.'],
        api: [{ method: 'POST', path: '/api/collect/stk', who: 'stk.request; body { phone, amountCents, reference, description? }' }],
      },
      {
        key: 'money-in',
        title: 'Money in',
        safaricom: 'C2B',
        where: ['Get paid', 'Money in'],
        who: 'Owner turns it on; anyone logged in can look',
        path: '/money-in',
        permission: 'money_in.view',
        steps: [
          'Turn on once. Studio tells Safaricom where to send news of customer payments; the page updates on its own and then says "On since …" or shows Safaricom’s refusal in three lines.',
          'If Safaricom says the addresses were already on record, that counts as on. Should a payment then never show, an older address may be on record at Safaricom; their API support can reset it.',
          'From then on every customer payment to your number shows here and in History the moment Safaricom reports it.',
          'Check for missed payments asks Safaricom for anything whose news never arrived. Studio does the same every hour on its own.',
        ],
        notes: ['Every payment is accepted. Safaricom only asks Studio to approve payments if its support team has switched that on for your number.', 'Test the address in Settings first; Safaricom must be able to reach Studio.'],
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
        where: ['Get paid', 'QR codes'],
        who: 'Owner or Operator',
        path: '/qr',
        permission: 'qr.generate',
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
        where: ['Get paid', 'Invoices'],
        who: 'Owner sets it up; Owner or Operator sends and cancels',
        path: '/invoices',
        permission: 'invoices.manage',
        steps: [
          'Set up once for Sandbox and once for Production (owner): business email, official contact phone, whether Safaricom should send payment reminders, then your password.',
          'New invoice: customer name, customer phone, what the invoice is for, account reference (up to 20 characters; payments are matched by it), billed period, due date, line items (optional, one per line: name, amount), amount. Send the invoice: the customer gets an SMS with a pay prompt.',
          'Many at once: one line per invoice (name, phone, invoice name, account, period, due date as year-month-day, amount). Studio checks every line, then Send them all.',
          'Show Open, Overdue, Paid, Cancelled or All; search by name, reference or account.',
          'Open an invoice to see its payments. Cancel this invoice stops it; tick several to cancel them together.',
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
        where: ['Manage', 'Advanced', 'Standing orders'],
        who: 'Owner or Operator',
        path: '/standing-orders',
        permission: 'standing_orders.manage',
        steps: [
          'Press New standing order.',
          'A name for this order (the customer sees it; one name per customer).',
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
        where: ['Manage', 'Advanced', 'Express checkout'],
        who: 'Owner or Operator',
        path: '/express',
        permission: 'express.checkout',
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
        where: ['Manage', 'Advanced', 'Bonga points'],
        who: 'Owner or Operator',
        path: '/bonga',
        permission: 'bonga.redeem',
        steps: [
          'How many points? Studio shows what they are worth at Safaricom’s rate today.',
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
        where: ['Pay out', 'Send money', 'To a phone'],
        who: 'Owner or Operator',
        path: '/send/phone',
        permission: 'send.phone',
        steps: [
          'Open Send money and press To a phone. (The other kinds, to a business wallet, a paybill, a till, float moves, top-ups and KRA, say Coming soon.)',
          'Phone number.',
          'Amount in KES, whole shillings.',
          'What kind of payment is this? One of your own categories (Settings › Payment categories); each is one of Safaricom’s three kinds, Business payment, Salary or Promotion.',
          'Note, optional.',
          'Review: Utility balance now and after, the fee note, and the per-send cap if one is set. Safaricom cannot check the name before sending, so check the number.',
          'Send, then your password. The page says Sent, then Paid or Not paid; the receipt goes to History.',
        ],
        notes: [
          'The same amount to the same number twice in a row is questioned first: "You sent this already at … Send again?"',
          'When Settings › Approvals is on and the amount is at or above the limit, the send waits for a second person instead of going out. Nothing leaves your account until it is released.',
          'Needs a working portal user (Settings). Without one Home says you cannot send yet.',
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
        where: ['Manage', 'Advanced', 'Bulk send'],
        who: 'Owner or Operator',
        path: '/bulk',
        permission: 'bulk.send',
        steps: [
          'Paste the list into The list, one line per person: phone, amount, name, note (the first two are needed), or Upload a file (a spreadsheet saved as CSV). Download a template gives the layout.',
          'Check the list. Every line is checked before anything moves; lines that need fixing are named. Nothing is sent until all pass.',
          'Send them all, then your password. Each row goes out in turn as an ordinary send, so the duplicate check, the cap and the approval hold all apply; a failed row never stops the rest.',
          'The batch page shows every row live. Try the failed rows again resends only rows Studio stopped before Safaricom. Download results gives a file for your records.',
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
        where: ['Pay out', 'Waiting for approval'],
        who: 'An Approver releases or refuses; anyone logged in sees the count',
        path: '/approvals',
        permission: 'send.approve',
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
        where: ['Manage', 'Advanced', 'Reverse a payment'],
        who: 'Owner or Operator',
        path: '/reverse',
        permission: 'reverse.request',
        steps: [
          'Type the M-Pesa receipt (10 letters and numbers) and press Find that payment. Only a payment that landed here can be reversed.',
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
    intro: 'Every value is shown as it is. Press Change or Replace to edit it; saving asks for the owner’s password.',
    tasks: [
      {
        key: 'organisation',
        title: 'Organisation',
        safaricom: 'My Preference',
        where: ['Manage', 'Settings'],
        who: 'Owner changes things; anyone logged in can look',
        path: '/settings',
        permission: 'owner',
        steps: [
          'Business name and contacts: the name in the menu and on receipts, the nominated number and the notification phone.',
          'Public address: the web address Safaricom sends payment news to. Test it after any change.',
          'Safaricom verification: for Sandbox and for Production, whether the number, the app codes and a working portal user are in place.',
          'Who can log in: Manage people opens the People page.',
          'Safaricom callback addresses: the Safaricom addresses Studio accepts payment news from. Change only if Safaricom publishes new ones.',
          'Callback secret: part of the address Safaricom sends to. Show the callback secret asks for your password; treat it like a password.',
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
        where: ['Manage', 'Settings'],
        who: 'Owner',
        permission: 'owner',
        steps: [
          'Studio shows the settings of the mode you are in. Switch modes under Account.',
          'Daraja app: the "Consumer Key" (last four shown) and "Consumer Secret"; Replace tests the new pair before saving it. See Getting things from Safaricom.',
          'B2C API version: leave it on Automatic (recommended).',
          'STK passkey: Replace; the new one is tested with a KES 1 prompt to your phone.',
          'Certificate: Safaricom’s certificate text, needed only when adding a portal user by password.',
          'API operators: your portal users. Add operator (by password and certificate, or by "Security Credential"), Test again (a balance check), New password or New credential, Turn off. The date Safaricom set for the password to expire is shown.',
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
        where: ['Manage', 'Settings'],
        who: 'Owner',
        permission: 'owner',
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
        where: ['Manage', 'Settings', 'Who can log in', 'Manage people'],
        who: 'Owner',
        path: '/people',
        permission: 'owner',
        steps: [
          'Open Settings, then Who can log in, then Manage people.',
          'Add somebody: their name, a username, what they may do, and a temporary password (Suggest another gives a new one). Add them, then your password.',
          'Tell them the temporary password yourself; Studio shows it once. They must change it at first login.',
          'Roles: Owner does everything. Operator can send money and ask customers to pay. Viewer can only look. Approver can release or refuse held sends.',
          'On each person: change what they may do, New temporary password, Switch off (they cannot log in) and Switch on.',
        ],
        notes: ['These are Studio logins. Users of Safaricom’s business portal are separate and are managed there.'],
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
        where: ['your name, top right', 'Organisation & shortcodes'],
        who: 'Owner',
        path: '/account',
        permission: 'owner',
        steps: [
          'Press your name at the top right, then Organisation & shortcodes.',
          'Mode: Sandbox for practice, or Production for real money. Switching a finished Studio to Production asks you to type your paybill or till number back, then your password.',
          'Shortcodes: the paybill or till number for each mode, with Change. Check the name with Safaricom fetches the name Safaricom holds and whether it is a paybill or a till.',
          'Change password, from the same menu: your current password, then the new one twice.',
          'Delete this studio, at the bottom: removes the business, its people, its Safaricom details and its history, and returns Studio to first-run setup. It asks for your password and the business name typed exactly. It cannot be undone.',
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
          'What it means: the same thing in everyday words.',
          'What to do now: the next step, for example add a portal user, top up Utility, or try again in a moment.',
        ],
        notes: ['"Something went wrong on our side" is Studio, not Safaricom: try again in a moment, and check Settings if it keeps happening.'],
      },
    ],
  },
  {
    key: 'not-possible',
    title: 'What still has to be done on Safaricom’s site',
    tasks: [
      {
        key: 'portal',
        title: 'Portal-only tasks',
        where: ['Not possible via API'],
        path: '/not-possible',
        steps: [
          'Withdrawing to the bank, moving float from Utility to Working, creating portal users and their rights, resetting portal passwords, KYC, bank accounts, tills, settlement plans, closing the organisation, Safaricom’s own statement, changing where paybill news is sent after the first time, and the portal’s own audit log all live on Safaricom’s business portal.',
          'Not possible via API lists each one with why, where on the portal, and the phone code (*234#) where one exists.',
        ],
        links: [how.orgPortal],
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
    'Every page route above is a browser route; the API paths beside each task are what the page calls. "Where" is the menu trail a person follows; "permission" is the key the route checks.',
  ],
  rules: [
    'An AI agent never moves money. It must not press Send, Ask for payment, Send the prompt, Create the standing order, Send them all, Release, Reverse or Turn on, and must not call POST /api/send/phone, /api/send/bulk, /api/send/reversal, /api/approvals/:id/release, /api/collect/stk, /api/collect/ratiba, /api/collect/express, /api/collect/bonga/redeem, /api/invoices, /api/invoices/bulk or /api/money-in/register. Only a person does those, in the browser, with their password.',
    'An agent may read every page and record, look up a receipt (POST /api/lookup), refresh balances (POST /api/balances/refresh), test the public address, and ask Safaricom to check a request (POST /api/requests/:id/check).',
    'Never log, store or repeat a phone number, a receipt, a password, a key, a secret, a passkey or a Security Credential.',
    'Never type a password, key or secret on a person’s behalf; ask them to do it themselves.',
    'When a form is on screen, it is one question per screen: answer, Continue, until Review. Stop at Review unless a person presses the last button.',
  ],
};
