/**
 * One person's name, from whatever shape Safaricom sent it in (round 3, phase A).
 *
 * Every name Studio stores goes through here, and the read layer runs a stored name through it again
 * so a row written before this existed reads the same way as a new one. Nothing is lost: the raw
 * value stays in `raw_result_json` (the whole callback body) or in `payload_json`.
 */

/** Safaricom's party names arrive as `"254712345678 - JANE DOE"`: the number, then the name. */
const PHONE_PREFIX = /^\+?[0-9][0-9\s]*\s+-\s+/;

/**
 * The Pull API's placeholder payer name. It is not a person, so it is not a name: KEPAS Pay reads it
 * the same way in both places it shows a payer
 * (`services/notificationClassifier.js`, `src/views/admin/c2b/index.ejs`: "the Pull API's
 * placeholder payer name"), and the live studio's own pulled rows carry exactly this value.
 */
const PULL_PLACEHOLDER = 'MPESA';

/** Whether a value is Safaricom's hashed stand-in for a phone number, never a number to show. */
export function isPhoneToken(v: string | null | undefined): boolean {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * A person's name from one Safaricom value, or null when there is no name in it.
 *
 * The phone Safaricom repeats in front of the name is dropped (the row's own number already holds
 * it), the Pull API's placeholder is read as no name, and a value with no letter in it — a bare
 * number, a token — is not a name either.
 */
export function personName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const name = trimmed.replace(PHONE_PREFIX, '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  if (!/[A-Za-z]/.test(name)) return null;
  if (name.toUpperCase() === PULL_PLACEHOLDER) return null;
  return name;
}

/** The three-part form Safaricom sends on a paybill payment, read as one name. */
export function joinPersonName(...parts: Array<string | null | undefined>): string | null {
  return personName(parts.filter((p) => p != null && String(p).trim() !== '').join(' '));
}
