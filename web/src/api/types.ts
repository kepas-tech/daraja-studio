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
export interface Page<T> { items: T[]; nextCursor: string | null }
