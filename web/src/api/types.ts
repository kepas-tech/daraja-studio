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
  verifiedAt?: string | null;
}
/** `GET /api/setup/status`. */
export interface SetupStatus {
  needsOwner: boolean; completed: boolean; step: string | null;
  /** What the business said it needs, in its own words. `null` until it has been asked. */
  uses: { payOut: boolean; collect: boolean } | null;
  /** Whether Safaricom has ever accepted a push here — the only proof a passkey can have. */
  passkeyProven: boolean;
}
export interface Me {
  person: Person; csrf: string; permissions: string[];
  org?: OrgSummary;
  /** The only host-admin signal the web reads. `person.is_host_admin` is never consulted. */
  hostAdmin?: boolean;
}
export interface SecretState { saved: boolean; last4: string | null }
export type B2cApiSetting = 'auto' | 'v1' | 'v3';
export type AssignableRole = 'operator' | 'viewer' | 'custom';
/** `GET /api/people` (spec 5.3). `isHostAdmin` is always false: there is no host console here. */
export interface PersonView {
  id: string; username: string; displayName: string; email: string | null;
  role: 'owner' | AssignableRole; status: 'active' | 'suspended';
  isOwner: boolean; isHostAdmin: boolean; mustChangePassword: boolean;
  createdAt: string; lastLoginAt: string | null;
}
/** `GET /api/host/orgs` and `GET /api/host/orgs/:id` (spec 6.1) — counts and dates only. */
export interface HostOrgRow {
  id: string; slug: string; name: string; status: OrgStatus;
  environment: string | null; verifiedAt: string | null; createdAt: string;
  suspendReason: 'unpaid' | 'host' | null;
  peopleCount: number; sendsThisMonth: number; lastCallbackAt: string | null;
  plan: { id: string; name: string } | null;
  subscriptionStatus: string | null;
  periodEnd: string | null;
}
export interface HostPlan { id: string; name: string; priceCents: number; isPublic: boolean }
/** One billing exception the host may need to reconcile (PB2-F3). Read-only facts only. */
export interface HostPaymentException {
  paymentId: string; checkoutRequestId: string | null;
  invoiceId: string; invoiceNumber: string; invoiceAmountCents: number;
  status: string; expectedCents: number; reportedCents: number | null;
  /** The provider's structured result code only; its free-text description never crosses. */
  receipt: string | null; resultCode: string | null;
  resultAt: string | null; createdAt: string;
  kind: 'overpayment' | 'amount_mismatch' | 'unresolved';
  successes: number;
}
export interface HostOrgDetail extends HostOrgRow {
  invoices: { id: string; number: string; amountCents: number; status: string; dueAt: string; paidAt: string | null;
    payments: { id: string; status: string; receipt: string | null; resultAt: string | null }[] }[];
}
/** `GET /api/host/billing` (spec 6.1, 7.3). */
export interface HostBillingView {
  env: Env | null;
  payeeName: string | null;
  slots: Record<Env, { ready: boolean; credsVerified: boolean; hasPasskey: boolean; hasCredentials: boolean }>;
}
/** `GET /api/host/stats`. Phase 3C adds the billing numbers; there are none in 3B. */
export interface HostStats {
  orgsByStatus: Record<string, number>;
  callbacksLastHour: number;
  unverifiedOverADay: number;
}
export interface OperatorView {
  id: string; name: string; environment: Env; status: 'pending' | 'verified' | 'failed' | 'disabled'; priority: number;
  rotatedAt: string; lastProbeAt: string | null; lastError: string | null; expiresAt: string;
}
/** `GET /api/signup/status` — the whole of what the wizard resumes from (spec 4.2). */
export interface SignupStatusView {
  email?: string | null;
  emailVerificationRequired?: boolean;
  emailDelivered?: boolean;
  status: OrgStatus;
  environment: Env;
  shortcode: string | null;
  safaricomName: string | null;
  shortcodeConfirmed: boolean;
  credsOk: boolean;
  /** What the business said it needs, in its own words. `null` until it has been asked. */
  uses: { payOut: boolean; collect: boolean } | null;
  /** Whether Safaricom has ever accepted a push here — the only proof a passkey can have. */
  passkeyProven: boolean;
  operator: OperatorView | null;
  /** Three lines joined by newlines when Safaricom refused; one line when the probe timed out. */
  failReason: string | null;
  egressIps: string[];
  /** Same skip the shortcode step's own lookup unlocks — read on mount so a reload never loses it. */
  nameCheckSkippable: boolean;
}
export interface EnvSlotView {
  shortcode: string | null;
  consumerKey: SecretState; consumerSecret: SecretState; credsVerifiedAt: string | null;
  passkey: SecretState; cert: SecretState;
  operators: OperatorView[];
  ready: { creds: boolean; operator: boolean };
  b2cApi: { setting: B2cApiSetting; detected: 'v1' | 'v3' | null; detectedAt: string | null };
}
export interface SettingsView {
  mode: Env;
  environments: Record<Env, EnvSlotView>;
  org: { name: string; nominatedNumber: string; notificationPhone: string };
  stkEnabled: boolean; publicUrl: string | null; publicVerifiedAt: string | null; httpsSeen: boolean;
  allowlist: string[]; setupCompletedAt: string | null;
}
export type RequestStatus = 'pending' | 'sent' | 'completed' | 'failed' | 'unknown' | 'cancelled' | 'rejected' | 'awaiting_approval';
export interface RequestView {
  id: string; type: string; subtype: string | null; status: RequestStatus | string; amountCents: number | null; currency: 'KES';
  recipient: { kind: string | null; value: string | null; name: string | null }; remarks: string | null; receipt: string | null;
  createdAt: string; sentAt: string | null; resultAt: string | null; resultSource: 'callback' | 'poll' | 'ack' | null;
  safaricomSaid: string | null; meaning: string | null; whatToDo: string | null; retriable: boolean; pollAttempts: number;
  checked: { by: { id: string; displayName: string } | null; at: string; note: string } | null;
  createdBy: { id: string; displayName: string } | null;
}
export interface BalanceView { workingCents: number | null; utilityCents: number | null; chargesPaidCents: number | null; queriedAt: string }
/** `GET /api/billing` (spec 7.3 step 7) — everything the Plan & billing section shows. */
export interface BillingPlan {
  id: string; name: string; priceCents: number; maxPeople: number; maxSendsPerMonth: number | null;
}
export interface BillingSubscription {
  status: string; periodStart: string; periodEnd: string; planId: string; pendingPlanId: string | null;
}
export interface BillingPayment {
  id: string; status: string; phone: string; receipt: string | null; resultDesc: string | null;
  resultAt: string | null; createdAt: string;
}
export interface BillingInvoice {
  id: string; number: string; periodStart: string; periodEnd: string; amountCents: number;
  status: string; dueAt: string; paidAt: string | null;
  /** The plan this invoice was issued for; paying it grants that plan, which may differ from the
   *  subscription's plan today. */
  planId: string; planName: string;
  payments: BillingPayment[];
}
/**
 * The cap that binds new writes right now and where it comes from (PB2-F1): the current plan, a
 * pending choice, or a standing open invoice. It can be smaller than the current plan's own cap, so
 * the screen must show this rather than the current plan's allowance alone.
 */
export interface EffectiveLimit {
  planId: string; planName: string; source: 'current' | 'pending' | 'invoiced'; limit: number;
}
export interface EffectiveLimits {
  people: EffectiveLimit;
  /** null when every committed plan is unlimited for sends. */
  sends: EffectiveLimit | null;
}
export interface BillingView {
  plan: BillingPlan;
  /** The host's public payee name, or null when unset. Never a credential or slot setting. */
  payeeName: string | null;
  plans: BillingPlan[];
  subscription: BillingSubscription | null;
  usage: { people: number; sendsThisMonth: number };
  invoices: BillingInvoice[];
  /** The binding caps, or null when no plans row exists at all (nothing is enforced). */
  effectiveLimits: EffectiveLimits | null;
  /** How many days before periodEnd the next invoice can be issued (INVOICE_LEAD_DAYS). */
  invoiceLeadDays: number;
}
export interface Page<T> { items: T[]; nextCursor: string | null }
