/**
 * Step two of the tiers-and-modules design: the screen for somebody who has no paybill of their own
 * sends them to the sign-up site.
 *
 * One setting holds that address. Absent, it is the default below; set to blank, the button is not
 * drawn at all and nothing else about the screen changes.
 */
export const SIGNUP_URL_KEY = 'signup.url';
export const DEFAULT_SIGNUP_URL = 'https://kepas.darajastudio.com';

/** The address to send somebody to, or null when the setting has been blanked. */
export function resolveSignupUrl(raw: string | null): string | null {
  if (raw === null) return DEFAULT_SIGNUP_URL;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}
