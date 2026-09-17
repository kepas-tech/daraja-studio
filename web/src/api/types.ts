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
  /** What the business said it needs, in its own words. `null` until it has been asked. */
  uses: { payOut: boolean; collect: boolean; stk: boolean } | null;
  /** Whether Safaricom has ever accepted a push here — the only proof a passkey can have. */
  passkeyProven: boolean;
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
  /** The only host-admin signal the web reads. `person.is_host_admin` is never consulted. */
}
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
  category: string | null;
  /** The saved contact's own name, when this payment came from one. Safaricom's `recipient.name` is untouched beside it. */
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
  createdAt: string; sentAt: string | null; resultAt: string | null; resultSource: 'callback' | 'poll' | 'ack' | null;
  safaricomSaid: string | null; meaning: string | null; whatToDo: string | null; retriable: boolean; pollAttempts: number;
  checked: { by: { id: string; displayName: string } | null; at: string; note: string } | null;
  createdBy: { id: string; displayName: string } | null;
  approvedBy?: { id: string; displayName: string } | null;
  bulkPlanId?: string | null;
  /** Feature 11: what Safaricom's band said this row costs, in cents. Null or absent on a row
   * written before the feature, and on an amount no band covers — never a zero standing for unknown. */
  chargeCents?: number | null;
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
}
export type NameCheck =
  | { available: true; name: string }
  | { available: false; reason: 'not_found' | 'not_enabled' | 'unavailable'; said: string | null };
export interface BalanceView { workingCents: number | null; utilityCents: number | null; chargesPaidCents: number | null; queriedAt: string; /** Feature 9: money-out that has not finished, in cents. */ waitingCents: number }
/** `GET /api/contacts` (design 2026-09-16). Only what the page shows; the row's own id is the handle. */
export interface ContactView {
  id: string; kind: 'phone' | 'till' | 'paybill';
  name: string; phone: string | null; shortcode: string | null;
  accountReference: string | null; note: string | null; createdAt: string;
}
/** `GET /api/businesses` (brief 2, item 1). Routing by the first three digits. */
export interface BusinessView {
  id: string; code: string; name: string; active: boolean; accountCount: number; createdAt: string;
  /** The open number width for this business's customers, for the plain line the page shows. */
  numbers: { width: number; capacity: number; used: number };
}
/**
 * `GET /api/businesses/:id/accounts`. Studio mints every digit: `number` is this level's own digits
 * (its width is written into them), `fullNumber` is what the payer types, and `children` are the
 * live accounts under a customer — always empty for an account that is itself under one.
 */
export interface AccountView {
  id: string; businessId: string; parentId: string | null; number: string; fullNumber: string;
  name: string; phone: string | null; note: string | null; createdAt: string;
  /** Live sub-accounts under this account; always empty for a sub-account. */
  children: AccountView[];
  /** The number belonged to somebody else until `until`, within the last twelve months. */
  previousHolder: { name: string; until: string } | null;
}
/** One past holder of a number, for "Past holders of this number". */
export interface HistoryEntry { name: string; phone: string | null; level: 'business' | 'account' | 'sub_account'; createdAt: string; deletedAt: string; deletedBy: string | null }
/** `GET /api/businesses/summary`: one row per business for the day, in cents. History, never cash. */
export interface BusinessSummaryRow { businessId: string; code: string; name: string; inCents: number; outCents: number }
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
export interface HomeSummary { inCents: number; inCount: number; outCents: number; outCount: number; pending: number; failed: number }
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
 * `GET /api/audit` (feature 10). One row of the studio's own record. `before` and `after` are the
 * stored JSON, shown to the owner exactly as they were written; `person` is null for a row nobody
 * signed (a job, a callback).
 */
export interface AuditRow {
  id: string; at: string; action: string;
  person: { id: string; displayName: string } | null;
  target: string | null; before: unknown; after: unknown; ip: string | null;
}
