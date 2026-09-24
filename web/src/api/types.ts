export type Env = 'sandbox' | 'production';
/** Spec 4.1's state machine, exactly as `orgs.status` spells it. */
export type OrgStatus = 'pending' | 'creds_ok' | 'operator_probing' | 'verified' | 'failed' | 'suspended' | 'closed';
export interface Person {
  id: string; username: string; display_name: string; is_owner: boolean; must_change_password: boolean;
  /** This install's login address, when one was given. */
  email?: string | null;
  role?: string;
}
/** `GET /api/auth/me`'s `org`. `slug` is deliberately absent — it is a host-admin handle. */
export interface OrgSummary {
  id: string; name: string; status: OrgStatus; environment: Env; isHost: boolean;
  suspendReason: 'unpaid' | 'host' | null;
  /** From `GET /api/auth/me`. Optional so a page rendered without a session still type-checks. */
  createdAt?: string | null;
  /** The environment in use: its shortcode and the name Safaricom holds for it, when checked. */
  shortcode?: string | null; safaricomName?: string | null; shortcodeKind?: 'paybill' | 'till' | null; /** The working API operator for that environment. */ operatorName?: string | null;
  verifiedAt?: string | null;
}
/** `GET /api/setup/status`. */
export interface SetupStatus {
  needsOwner: boolean; completed: boolean; step: string | null;
  /** The install's own name — the host organisation's — and null where it has not named itself.
   *  Present for anybody, signed in or not: it is what the login screen puts beside the address. */
  studioName?: string | null;
  /** What the business said it needs, in its own words. `null` until it has been asked. */
  uses: { payOut: boolean; collect: boolean; stk: boolean } | null;
  /** Whether Safaricom has ever accepted a push here — the only proof a passkey can have. */
  passkeyProven: boolean;
  /**
   * Step two of the tiers-and-modules design: the answer to "do you have your own paybill or till?",
   * asked on the production path only, and null before it has been asked.
   */
  paybill: 'own' | 'none' | null;
  /** Where the screen for "no" sends people. Null when the setting has been blanked. */
  signupUrl: string | null;
  /** Answers earlier steps stored, for a signed-in caller only; secrets are never included. */
  saved?: SetupSaved;
}
export interface SetupSaved {
  mode: 'sandbox' | 'production';
  org: { name: string | null; nominatedNumber: string | null; notificationPhone: string | null };
  shortcode: string | null;
  darajaVerified: boolean;
  publicUrl: string | null; publicVerified: boolean;
}
export interface Me {
  person: Person; csrf: string; permissions: string[];
  org?: OrgSummary;
  /**
   * Brief 2, item 3. `set` is whether a PIN exists, `locked` whether this session is waiting for
   * it. Optional because a page rendered against an older server sends neither, and that absence
   * has to read as "no PIN" rather than as a lock nobody can open.
   */
  pin?: { set: boolean; locked: boolean; /** This person has a fingerprint enrolled (item 5b). */ bio?: boolean };
  /**
   * Step one of the tiers-and-modules design: what this studio has switched off, so the menu never
   * offers a page whose routes would refuse. Optional, so an answer from an older server reads as
   * "nothing is off" rather than as a studio with everything hidden.
   */
  modules?: {
    off: string[]; menuOff: string[];
    /**
     * The tier the switched-on parts actually equal — 'simple', 'business' or 'platform' — or null
     * when a part was switched by hand and the set equals no tier. The top bar's mode tag reads it.
     */
    tier?: string | null;
  };
  /** The only host-admin signal the web reads. `person.is_host_admin` is never consulted. */
}
/**
 * What a confirmation carries: the owner's own password, or the PIN once one is set (brief 2,
 * item 3). A step-up route reads exactly one of these, and neither is ever logged.
 */
export type Confirm = { password: string } | { pin: string };
/** `GET /api/auth/webauthn/credentials` (brief 2, item 5b): one enrolled device. The public key, the
 *  counter and the raw credential id never come back — only what the owner needs to recognise and
 *  remove the device. */
export interface FingerprintDevice { id: string; label: string; createdAt: string; lastUsedAt: string | null }
export interface SecretState { saved: boolean; last4: string | null }
export type B2cApiSetting = 'auto' | 'v1' | 'v3';
export type AssignableRole = 'operator' | 'viewer' | 'approver' | 'custom';
/** `GET /api/people` (spec 5.3). `isHostAdmin` is always false: there is no host console here. */
export interface PersonView {
  id: string; username: string; displayName: string; email: string | null;
  role: 'owner' | AssignableRole; status: 'active' | 'suspended';
  isOwner: boolean; isHostAdmin: boolean; mustChangePassword: boolean;
  createdAt: string; lastLoginAt: string | null;
}
export interface OperatorView {
  id: string; name: string; environment: Env; status: 'pending' | 'verified' | 'failed' | 'disabled'; priority: number;
  rotatedAt: string; lastProbeAt: string | null; lastError: string | null; expiresAt: string;
  /** Feature 8: credential failures inside the last ten minutes, and when the operator went DOWN. */
  consecutiveFailures: number; lastFailureAt: string | null; downSince: string | null;
}
/** `GET /api/signup/status` — the whole of what the wizard resumes from (spec 4.2). */
export interface EnvSlotView {
  shortcode: string | null; safaricomName?: string | null; shortcodeKind?: 'paybill' | 'till' | null;
  consumerKey: SecretState; consumerSecret: SecretState; credsVerifiedAt: string | null;
  passkey: SecretState; passkeyProven?: boolean; cert: SecretState;
  operators: OperatorView[];
  ready: { creds: boolean; operator: boolean };
  b2cApi: { setting: B2cApiSetting; detected: 'v1' | 'v3' | null; detectedAt: string | null };
}
export type CommandId = 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment';
export interface SendCategory { id: string; name: string; commandId: CommandId }
export interface SettingsView {
  mode: Env;
  environments: Record<Env, EnvSlotView>;
  org: { name: string; nominatedNumber: string; notificationPhone: string };
  stkEnabled: boolean; publicUrl: string | null; publicVerifiedAt: string | null; httpsSeen: boolean;
  allowlist: string[]; setupCompletedAt: string | null;
  sendCategories: SendCategory[];
  /** M4: 0 = off. */
  approvalThresholdCents: number;
  uses?: { payOut: boolean; collect: boolean; stk: boolean };
}
export type RequestStatus = 'pending' | 'sent' | 'completed' | 'failed' | 'unknown' | 'cancelled' | 'rejected' | 'awaiting_approval';
export interface RequestView {
  id: string; type: string; subtype: string | null; status: RequestStatus | string; amountCents: number | null; currency: 'KES';
  recipient: { kind: string | null; value: string | null; name: string | null }; remarks: string | null; receipt: string | null;
  /**
   * Round 3, phase A: which way this row's money moved — null on a row that moves none, like a
   * lookup — and the person on the other side of it. `requests.recipient_name` is one column
   * holding two different people, so the read layer names the person here, by direction, and no page
   * has to ask what type it is reading. Both are optional because a page rendered against an older
   * server sends neither, and that absence has to read as "work it out from the row's type".
   */
  direction?: 'in' | 'out' | null;
  party?: { name: string | null; number: string | null; savedName: string | null };
  category: string | null;
  /** The saved contact's own name, when this payment came from one. Shown as `party.savedName`,
   * beside the name on the row rather than instead of it. */
  contactName: string | null;
  /** What the payer typed on their phone (c2b) or the reference the request carried. */
  accountReference: string | null;
  /** Brief 2, item 1: the business and account this row belongs to, when the number named one. */
  businessName: string | null; accountName: string | null;
  /** The full account number the payer's digits add up to, when the row is labelled. */
  accountNumber?: string | null;
  /** Brief 2, item 1b: the account these digits named has been deleted; who held them. */
  deletedAccountName?: string | null;
  deletedAccountAt?: string | null;
  /** The live account's number was somebody else's until this date, within the last year. */
  previousHolderName?: string | null;
  previousHolderUntil?: string | null;
  /** The account's id, so Money in can offer History filtered to that account. Optional until the server sends it. */
  accountId?: string | null;
  createdAt: string; sentAt: string | null; resultAt: string | null; resultSource: 'callback' | 'poll' | 'ack' | 'feed' | null;
  safaricomSaid: string | null; meaning: string | null; whatToDo: string | null; retriable: boolean; pollAttempts: number;
  checked: { by: { id: string; displayName: string } | null; at: string; note: string } | null;
  createdBy: { id: string; displayName: string } | null;
  approvedBy?: { id: string; displayName: string } | null;
  bulkPlanId?: string | null;
  /** Feature 11: what Safaricom's band said this row costs, in cents. Null or absent on a row
   * written before the feature, and on an amount no band covers — never a zero standing for unknown. */
  chargeCents?: number | null;
}
/** Round 3, phase E: an API key as the list shows it. The secret is never part of this shape. */
export interface ApiKeyView {
  id: string; name: string; prefix: string;
  role: 'operator' | 'viewer' | 'approver' | 'forwarder' | 'collector';
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null; rotatedFrom: string | null;
  createdBy: { id: string; displayName: string } | null;
  /**
   * Step six, part five: the address this key holds itself, or null when its notices go to the
   * organisation's address instead.
   */
  webhook: WebhookView | null;
}
/** Round 3, phase E: the webhook address, and the last four characters of its signing secret. */
export interface WebhookView { url: string | null; secretHint: string | null; updatedAt: string | null }
/** Round 3, phase E: one webhook delivery, as the deliveries page reads it. */
export interface DeliveryView {
  id: string; event: string; url: string; requestId: string | null;
  /** The key whose payments this notice carries, when the address it was written for is a key's. */
  keyName: string | null;
  attempts: number; lastStatus: number | null; lastResponse: string | null;
  lastTryAt: string | null; nextRetryAt: string | null; deliveredAt: string | null; createdAt: string;
  state: 'pending' | 'delivered' | 'failed';
}
/** The answer a save or a rotation gives: the secret is here, and only here. */
export interface WebhookSaved { webhook: WebhookView; secret: string | null }
/**
 * The one answer that carries the secret: create and rotate, and nothing else. A key made with an
 * address of its own carries that address's signing secret here too, shown once like the key.
 */
export interface ApiKeyCreated { key: ApiKeyView; secret: string; webhook?: WebhookSaved | null }
/** Round 3, phase D-5: the case file on a payment, as `/api/requests/:id/case` reads it. */
export interface CaseNoteView { id: string; note: string; at: string; by: { id: string; displayName: string } | null }
export interface CaseView {
  id: string; requestId: string; title: string; status: 'open' | 'closed';
  openedAt: string; openedBy: { id: string; displayName: string } | null;
  closedAt: string | null; closedBy: { id: string; displayName: string } | null;
  outcome: string | null; notes: CaseNoteView[];
}
export interface BulkRow { line: number; phone: string; amountCents: number; name: string | null; note: string | null }
export interface BulkCheck { rows: BulkRow[]; errors: { line: number; message: string }[]; count: number; totalCents: number }
export interface BulkResult { requestId?: string; status: string; error?: string; retriable?: boolean }
export interface BulkPlanView {
  id: string; category: string | null; rowCount: number; totalCents: number; status: 'sending' | 'done' | 'partly_done';
  createdAt: string; finishedAt: string | null; createdBy: { id: string; displayName: string } | null;
  rows: (BulkRow & { index: number; result: BulkResult | null; receipt: string | null; liveStatus: string | null })[];
}
export type InvoiceStatus = 'sent' | 'partly_paid' | 'paid' | 'cancelled' | 'overdue';
export interface InvoiceView {
  id: string; reference: string; customerName: string; customerPhone: string; invoiceName: string; accountReference: string; billedPeriod: string; dueDate: string;
  amountCents: number; paidCents: number; items: { name: string; amountCents: number }[]; status: InvoiceStatus; stored: 'sent' | 'partly_paid' | 'paid' | 'cancelled';
  createdBy: { id: string; displayName: string } | null; sentAt: string; paidAt: string | null; cancelledAt: string | null;
  payments: { id: string; amountCents: number; receipt: string | null; at: string; source: 'callback' | 'manual' }[];
}
export interface InvoicesSettingsView { mode: 'sandbox' | 'production'; optedIn: boolean; optedInAt: string | null; email: string | null; phone: string | null; reminders: boolean; publicVerified: boolean; registering?: boolean; lastError?: string | null }
export interface MoneyInView {
  mode: 'sandbox' | 'production'; c2bRegisteredAt: string | null; pullRegisteredAt: string | null; pullCheckedAt: string | null;
  nominatedNumber: string | null; publicVerified: boolean;
  registering: boolean; lastError: string | null; alreadyRegistered: boolean;
  /** Round 5: where this paybill's confirmations arrive today; null until the owner says. */
  arrival: 'studio' | 'forwarder' | null;
  /** The last payment fed in by another system, if any. */
  lastFedAt: string | null;
  /** Live API keys that may feed money in (the forwarder role). */
  feedKeys: number;
}
export type NameCheck =
  | { available: true; name: string; paidBefore: boolean }
  | { available: false; reason: 'not_found' | 'not_enabled' | 'unavailable'; said: string | null; paidBefore: boolean };
/** What Safaricom says a paybill or till is registered as (`POST /api/send/business-check`). */
export type BusinessCheck =
  | { available: true; name: string; paidBefore: boolean }
  | { available: false; reason: 'not_found' | 'unavailable'; paidBefore: boolean };
export interface BalanceView { workingCents: number | null; utilityCents: number | null; chargesPaidCents: number | null; queriedAt: string; /** Feature 9: money-out that has not finished, in cents. */ waitingCents: number }
/** Round 3, phase D-3: one check Studio made with Safaricom, as `GET /api/requests/checks` reads it. */
export interface CheckView {
  id: string; kind: 'sweep' | 'manual' | 'lookup';
  target: { requestId: string | null; receipt: string | null; name: string | null; number: string | null };
  status: string; said: string | null; meaning: string | null;
  askedAt: string; resultAt: string | null;
  askedBy: { id: string; displayName: string } | null;
}
/** `GET /api/contacts` (design 2026-09-16). Only what the page shows; the row's own id is the handle. */
export interface ContactView {
  id: string; kind: 'phone' | 'till' | 'paybill';
  name: string; phone: string | null; shortcode: string | null;
  accountReference: string | null; note: string | null; createdAt: string;
}
/**
 * Round 3, phase B: what kind of business this is, as data. The words the owner can edit (the two
 * nouns, the statement name, the categories) and the four modes wired to something Studio does.
 */
export interface TypeTemplate {
  accountNoun: string;
  subAccountNoun: string | null;
  regular: 'no' | 'weekly' | 'monthly' | 'each_term';
  standingAmount: 'none' | 'fixed' | 'pledge';
  categories: string[];
  invoices: 'on' | 'per_visit' | 'each_term' | 'off';
  reminders: boolean;
  homeLead: 'behind' | 'takings' | 'giving' | 'outstanding' | 'nothing';
  statementNoun: string;
}
export interface BusinessTypeView { key: string; name: string; template: TypeTemplate }
/** `GET /api/businesses` (brief 2, item 1). Routing by the first three digits. */
export interface BusinessView {
  id: string; code: string; name: string; active: boolean; accountCount: number; createdAt: string;
  /** The open number width for this business's customers, for the plain line the page shows. */
  numbers: { width: number; capacity: number; used: number };
  /** Round 3, phase B: the kind of business, and the words that come with it. */
  type: BusinessTypeView;
}
/**
 * `GET /api/businesses/:id/accounts`. Studio mints every digit: `number` is this level's own digits
 * (its width is written into them), `fullNumber` is what the payer types, and `children` are the
 * live accounts under a customer — always empty for an account that is itself under one.
 */
export interface AccountView {
  id: string; businessId: string; parentId: string | null; number: string; fullNumber: string;
  name: string; phone: string | null; note: string | null; createdAt: string;
  /** Round 3, phase C: what this account is expected to pay each period, when its kind has one. */
  standingCents?: number | null;
  lastRemindedAt?: string | null;
  /** Live sub-accounts under this account; always empty for a sub-account. */
  children: AccountView[];
  /** The number belonged to somebody else until `until`, within the last twelve months. */
  previousHolder: { name: string; until: string } | null;
}
/** Round 3, phase C: one line of an account's running statement. */
export interface StatementRow {
  at: string;
  kind: 'in' | 'out' | 'invoice';
  label: string;
  amountCents: number;
  status: string;
  receipt: string | null;
  reference: string | null;
  accountName: string | null;
  requestId: string | null;
  invoiceId: string | null;
}
/** `GET /api/accounts/:id/statement`: the running statement and the one line on top of it. */
export interface StatementView {
  account: { id: string; name: string; fullNumber: string; phone: string | null; note: string | null; businessId: string; businessName: string; businessCode: string; parentId: string | null };
  type: BusinessTypeView;
  standingCents: number | null;
  schedule: { regular: TypeTemplate['regular']; standingAmount: TypeTemplate['standingAmount']; periodsDue: number; expectedCents: number | null };
  paidInCents: number; paidOutCents: number;
  invoicedCents: number; unpaidInvoiceCents: number; unpaidInvoiceCount: number;
  owedCents: number; behindPeriods: number;
  lastRemindedAt: string | null;
  rows: StatementRow[];
}
/** One account in "Who is behind". */
export interface ArrearsRow {
  accountId: string; name: string; fullNumber: string;
  standingCents: number | null; periodsDue: number; expectedCents: number | null; paidInCents: number;
  owedCents: number; behindPeriods: number; lastRemindedAt: string | null;
  oldestInvoice: { id: string; reference: string; billedPeriod: string; dueDate: string; amountCents: number; paidCents: number } | null;
}
/** `GET /api/businesses/:id/arrears`. `hasArrears` is false for a kind that expects nothing regular. */
export interface ArrearsView {
  businessId: string; businessName: string; businessCode: string;
  type: BusinessTypeView;
  hasArrears: boolean;
  rows: ArrearsRow[];
  behindCount: number;
  owedCents: number;
}
/** One past holder of a number, for "Past holders of this number". */
export interface HistoryEntry { name: string; phone: string | null; level: 'business' | 'account' | 'sub_account'; createdAt: string; deletedAt: string; deletedBy: string | null }
/** `GET /api/businesses/summary`: one row per business for the day, in cents. History, never cash.
 * Round 3, phase B adds the kind of business, its words, and how many accounts it holds. */
export interface BusinessSummaryRow { businessId: string; code: string; name: string; type: BusinessTypeView; accountCount: number; inCents: number; outCents: number }
/** `GET /api/reports` (feature 6). One line per Nairobi day in the window, days with nothing included. */
export interface ReportDay { day: string; inCents: number; inCount: number; outCents: number; outCount: number; completed: number; failed: number; unknown: number }
/** One reason Safaricom gave for a failure, with how many payments it explains and their total. */
export interface ReportFailure { reason: string; count: number; amountCents: number }
export interface ReportTotals { inCents: number; inCount: number; outCents: number; outCount: number; completed: number; failed: number; unknown: number }
/** `GET /api/reports`. `byBusiness` is empty when one business was picked, or when there is only one. */
export interface ReportsView {
  window: { days: number; from: string; to: string };
  days: ReportDay[];
  totals: ReportTotals;
  failures: ReportFailure[];
  byBusiness: BusinessSummaryRow[];
}
/**
 * `GET /api/health/problems` (brief 2, item 2). One entry per state that means something is wrong;
 * `detail` carries the specifics and is present only for the owner.
 */
export type ProblemKind = 'operator_down' | 'no_callback' | 'balance_refused';
export interface Problem { kind: ProblemKind; detail: { name: string | null; minutes: number | null } | null }
/** `GET /api/reports/summary`: the last 24 hours, for the strip on Home. */
export interface HomeSummary {
  inCents: number; inCount: number; outCents: number; outCount: number; pending: number; failed: number;
  /** Round 3, phase B: what Home leads with follows the kind of business. */
  monthInCents: number; unpaidInvoiceCents: number; unpaidInvoiceCount: number;
}
/**
 * `GET /api/money-in/unmatched`: a c2b row that needs a decision, and why. The optional fields are
 * what the one-click fix needs to name itself (which business, and for no_sub, which customer's
 * number was typed); the page falls back to the business name when an older server sends none.
 */
export type UnmatchedReason = 'no_business' | 'no_account' | 'no_sub' | 'too_many';
export type UnmatchedView = RequestView & {
  reason: UnmatchedReason;
  businessId?: string | null;
  /** The business the first three digits name, when the server sends it as its own object. */
  business?: { id: string; code: string; name: string } | null;
  /** For no_sub: the account whose number was named. */
  accountName?: string | null;
};
export type FeeKind = 'c2b' | 'b2c' | 'b2b';
/** GET /api/fees (feature 11). One published Safaricom tariff band, in cents. */
export interface FeeBandView { id: string; kind: FeeKind; minCents: number; maxCents: number; chargeCents: number; updatedAt: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
/** One section of the Waiting page: the newest rows shown, and the true total behind them. */
export interface WaitingSection { items: RequestView[]; count: number }
/**
 * `GET /api/waiting` (feature 5). The held rows are empty unless the caller may release or refuse —
 * `canDecide` says which, so the page never draws a button the release route would refuse.
 */
export interface WaitingView {
  approvals: { items: RequestView[]; canDecide: boolean };
  sent: WaitingSection;
  noAnswer: WaitingSection;
  badge: number;
}
/** How loud a line in the inbox is. Four levels, the same four the server writes (design 2026-09-16, feature 4). */
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';
/** `GET /api/notifications`. `count` is how many times the same event happened before it was read. */
export interface NotificationView {
  id: string; severity: NotificationSeverity; category: string; type: string;
  title: string; body: string; data: { requestId?: string } & Record<string, unknown>;
  count: number; readAt: string | null; createdAt: string; updatedAt: string;
}
export interface NotificationPage { items: NotificationView[]; unread: number; nextCursor: string | null }
/**
 * Step one of the tiers-and-modules design: `GET /api/modules`. One part of Studio, as the owner's
 * page reads it. The names, the sentences and what turning one off hides come from the server's own
 * registry, so the list exists once and cannot drift from the route guard.
 */
export interface ModuleView {
  key: string; name: string; sentence: string;
  on: boolean;
  /** False for a part that is declared and not built: it is listed, and there is nothing to switch. */
  built: boolean; switchable: boolean;
  /** The owner departed from their tier on this part. */
  changed: boolean;
  permissions: { key: string; label: string }[];
  menu: string[];
  hides: string;
  needs: { key: string; name: string; on: boolean }[];
  /** Parts that are on and stand on this one, so it cannot be switched off while they are. */
  heldBy: { key: string; name: string }[];
}
export interface TierView { key: string; name: string; sentence: string; on: string[]; planned: string[] }
export interface ModuleState {
  tier: string;
  /** The owner chose this tier. False means the starting tier for a studio that never chose. */
  chosen: boolean;
  /** The tier the current set equals, when it equals one. Null after a change made by hand. */
  matches: string | null;
  departures: number;
  tiers: TierView[];
  modules: ModuleView[];
}
/** What a tier change would do, before it is made. */
export interface TierPreview {
  from: string; tier: string;
  changes: { key: string; name: string; from: boolean; to: boolean }[];
  on: string[]; off: string[];
}
/**
 * `GET /api/audit` (feature 10). One row of the studio's own record. `before` and `after` are the
 * stored JSON, shown to the owner exactly as they were written; `person` is null for a row nobody
 * signed (a job, a callback).
 */
export interface AuditRow {
  id: string; at: string; action: string;
  person: { id: string; displayName: string } | null;
  target: string | null; before: unknown; after: unknown; ip: string | null;
}

/** Step three of nine: sweep-through. One payment a sweep carried. */
export interface SweepPayment {
  id: string; receipt: string | null; amountCents: number; at: string; accountNumber: string | null; type: string;
}
/** What is owed to one business, and the payments that make the figure up. */
export interface SweepOwed {
  paidInCents: number; sweptCents: number; feesTakenCents: number; owedCents: number; payments: SweepPayment[];
}
export type SweepSchedule = 'arrival' | 'daily' | 'weekly';
/** One sweep: a window's money, what was kept, what went, and why it did not. */
export interface SweepRow {
  id: string; window: string; schedule: SweepSchedule;
  state: 'prepared' | 'sending' | 'sent' | 'failed' | 'held';
  grossCents: number; feeCents: number; netCents: number;
  destinationPhone: string | null; reasonCode: string | null; reason: string | null; gapCents: number | null;
  requestId: string | null; requestStatus: string | null; receipt: string | null;
  sentAt: string | null; createdAt: string; payments: SweepPayment[];
}
export interface SweepFee { percentBp: number; flatCents: number; floorCents: number | null; ceilingCents: number | null }
/** Why nothing has left, in the owner's words. Null when there is nothing waiting. */
export interface SweepWaiting { code: string; text: string; gapCents: number | null }
export interface BusinessSweep {
  businessId: string; businessName: string; businessCode: string; active: boolean;
  destinationPhone: string | null; schedule: SweepSchedule; hour: number; weekday: number;
  fee: SweepFee; stopped: boolean; consentedAt: string | null;
  timetable: string; owed: SweepOwed; minCents: number; waiting: SweepWaiting | null; sweeps: SweepRow[];
}
export interface SweepList { items: BusinessSweep[]; minCents: number }

/** Scheduled payments (`/api/schedules`). */
export type Every = 'daily' | 'weekly' | 'fortnightly' | 'monthly';
export type WeekendRule = 'on_day' | 'before' | 'skip';
export interface ScheduleLineView { id: string; contactId: string; name: string; kind: 'phone' | 'till' | 'paybill'; destination: string | null; accountReference: string | null; amountCents: number; note: string | null; gone: boolean }
export interface PayRunSummary { id: string; dueOn: string; payOn: string; state: string; totalCents: number; lineCount: number; reason: string | null; gapCents: number | null; createdAt: string; finishedAt: string | null }
export interface ScheduleView {
  id: string; name: string; state: 'active' | 'paused' | 'stopped' | 'finished'; every: Every; weekday: number; dayOfMonth: number; hour: number; weekendRule: WeekendRule;
  phoneCommand: 'SalaryPayment' | 'BusinessPayment'; startOn: string; endOn: string | null; words: string;
  totalCents: number; lines: ScheduleLineView[]; nextPayOn: string | null; upcoming: string[];
  consentedBy: string | null; consentedAt: string; createdAt: string; lastRun: PayRunSummary | null;
}
export interface PayRunLineView { id: string; name: string; kind: string; destination: string; accountReference: string | null; amountCents: number; note: string | null; state: string; failure: string | null; requestId: string | null; receipt: string | null }
export interface PayRunView extends PayRunSummary { scheduleId: string; scheduleName: string; lines: PayRunLineView[] }
export interface ScheduleSummary { active: number; paused: number; next: { id: string; name: string; totalCents: number; people: number; payOn: string } | null }
