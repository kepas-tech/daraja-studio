/**
 * The one-time ticket a successful recovery probe leaves behind. It lives in `cache`, whose keys are
 * prefixed with the organisation in scope (`db/cache.ts`), so it can only be read from inside the
 * organisation that earned it. Its own module because both the callback handler that writes it
 * (`callbacks/balance.ts`) and the route that spends it (`auth/recover.ts`) need the same two
 * values, and neither should have to import the other.
 */
export const RECOVERY_TICKET_SECONDS = 900;

/**
 * How long the balance probe itself is allowed to take before `request_timeout` gives up on it
 * (`auth/recover.ts`'s own `enqueue` call). The ticket's 900 s does not start until the callback
 * actually lands, which can be up to this long after `/start` wrote the pointer below — so the
 * pointer has to outlive the ticket by at least this much, or a probe that takes its full timeout
 * to answer leaves a live ticket behind a pointer that already expired.
 */
export const RECOVERY_PROBE_TIMEOUT_SECONDS = 300;

/** The pointer's own TTL: long enough to still be there whenever the ticket it points to is. */
export const RECOVERY_LOOKUP_SECONDS = RECOVERY_TICKET_SECONDS + RECOVERY_PROBE_TIMEOUT_SECONDS;

export function recoveryCacheKey(recoveryId: string): string {
  return `recovery:${recoveryId}`;
}

/**
 * Install-wide (never organisation-scoped) pointer from a recoveryId to the organisation and
 * request it belongs to. `/start` (`auth/recover.ts`) writes it — and `/status`/`/finish` read it —
 * inside `withSystem`, on purpose: `orgContext` wraps every `/api` request in `withOrg` whenever a
 * session cookie is present, even an anonymous route like this one, so without `withSystem` a
 * `/start` from a half-logged-in tab would write this under that session's organisation prefix and
 * a genuinely anonymous `/status`/`/finish` could never read it back (`db/cache.ts`'s `scoped()`
 * keys on whatever organisation happens to be ambient). It carries no secret — only ids — so being
 * readable by anyone who already holds the recoveryId costs nothing; the ticket itself
 * (`recoveryCacheKey`, which does carry the person to recover) stays scoped to the organisation
 * that earned it, looked up only after this pointer has named which one that is.
 */
export function recoveryLookupKey(recoveryId: string): string {
  return `recovery:${recoveryId}:req`;
}
