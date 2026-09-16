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
  shortcode?: string | null; safaricomName?: string | null;
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
}
/** `GET /api/signup/status` — the whole of what the wizard resumes from (spec 4.2). */
export interface EnvSlotView {
  shortcode: string | null;
  consumerKey: SecretState; consumerSecret: SecretState; credsVerifiedAt: string | null;
  passkey: SecretState; cert: SecretState;
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
}
export type RequestStatus = 'pending' | 'sent' | 'completed' | 'failed' | 'unknown' | 'cancelled' | 'rejected' | 'awaiting_approval';
export interface RequestView {
  id: string; type: string; subtype: string | null; status: RequestStatus | string; amountCents: number | null; currency: 'KES';
  recipient: { kind: string | null; value: string | null; name: string | null }; remarks: string | null; receipt: string | null;
  category: string | null;
  createdAt: string; sentAt: string | null; resultAt: string | null; resultSource: 'callback' | 'poll' | 'ack' | null;
  safaricomSaid: string | null; meaning: string | null; whatToDo: string | null; retriable: boolean; pollAttempts: number;
  checked: { by: { id: string; displayName: string } | null; at: string; note: string } | null;
  createdBy: { id: string; displayName: string } | null;
  approvedBy?: { id: string; displayName: string } | null;
  bulkPlanId?: string | null;
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
export interface InvoicesSettingsView { mode: 'sandbox' | 'production'; optedIn: boolean; optedInAt: string | null; email: string | null; phone: string | null; reminders: boolean; publicVerified: boolean }
export interface MoneyInView {
  mode: 'sandbox' | 'production'; c2bRegisteredAt: string | null; pullRegisteredAt: string | null; pullCheckedAt: string | null;
  nominatedNumber: string | null; publicVerified: boolean;
}
export interface BalanceView { workingCents: number | null; utilityCents: number | null; chargesPaidCents: number | null; queriedAt: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
