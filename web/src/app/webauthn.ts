import { api } from '../api/client';

/**
 * Brief 2, item 5b: the browser half of the fingerprint, ported from kepas-pay's webauthn.js. The
 * server owns the ceremonies and the challenge; this module only shapes the JSON into what
 * navigator.credentials expects and shapes the answer back. No extra dependency: the browser API is
 * enough.
 *
 * Every failure here is quiet. A browser without a platform authenticator, a person who dismisses
 * the prompt, a credential enrolled on another device: all of them end as "false", and the lock
 * screen falls back to the PIN, which is always there.
 */

/** base64url (what the server sends and takes) to the ArrayBuffer the WebAuthn API wants. */
function toBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function fromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface CredentialDescriptorJSON { id: string; type?: PublicKeyCredentialType; transports?: AuthenticatorTransport[] }
interface CreationOptionsJSON {
  challenge: string; rp: { id?: string; name: string }; user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[]; timeout?: number; attestation?: AttestationConveyancePreference;
  excludeCredentials?: CredentialDescriptorJSON[]; authenticatorSelection?: AuthenticatorSelectionCriteria;
}
interface RequestOptionsJSON {
  challenge: string; rpId?: string; timeout?: number; userVerification?: UserVerificationRequirement;
  allowCredentials?: CredentialDescriptorJSON[];
}

/** Whether this browser can do WebAuthn at all. */
export function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && !!navigator.credentials;
}

/** Whether this device has a platform authenticator: the fingerprint or face reader itself. */
export function platformAvailable(): Promise<boolean> {
  if (!supported() || typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return Promise.resolve(false);
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
}

function descriptor(c: CredentialDescriptorJSON): PublicKeyCredentialDescriptor {
  return { type: 'public-key', id: toBuffer(c.id), ...(c.transports ? { transports: c.transports } : {}) };
}

/** The answer @simplewebauthn/server reads, as plain JSON over the wire. */
function serialize(credential: PublicKeyCredential) {
  const response = credential.response;
  const out: Record<string, unknown> = {
    id: credential.id,
    rawId: fromBuffer(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: { clientDataJSON: fromBuffer(response.clientDataJSON) } as Record<string, unknown>,
  };
  // Duck-typed rather than `instanceof`: the two response classes are not defined in every
  // environment the tests run in, and what matters is only which fields the answer carries.
  const body = out.response as Record<string, unknown>;
  const attestation = response as Partial<AuthenticatorAttestationResponse>;
  const assertion = response as Partial<AuthenticatorAssertionResponse>;
  if (attestation.attestationObject) body.attestationObject = fromBuffer(attestation.attestationObject);
  if (assertion.authenticatorData) {
    body.authenticatorData = fromBuffer(assertion.authenticatorData);
    if (assertion.signature) body.signature = fromBuffer(assertion.signature);
    if (assertion.userHandle) body.userHandle = fromBuffer(assertion.userHandle);
  }
  if (credential.authenticatorAttachment) out.authenticatorAttachment = credential.authenticatorAttachment;
  return out;
}

/**
 * Enrol this device. Needs an open session: the server refuses the ceremony while locked, because
 * enrolling proves the person is already inside.
 */
export async function registerFingerprint(): Promise<boolean> {
  try {
    const options = await api.post<CreationOptionsJSON>('/api/auth/webauthn/register/options');
    const publicKey: PublicKeyCredentialCreationOptions = {
      ...options,
      challenge: toBuffer(options.challenge),
      user: { ...options.user, id: toBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map(descriptor),
    };
    const created = await navigator.credentials.create({ publicKey });
    if (!created) return false;
    await api.post('/api/auth/webauthn/register/verify', serialize(created as PublicKeyCredential));
    return true;
  } catch { return false; }
}

/**
 * Open the locked session with the fingerprint. The server verifies the signature and sets exactly
 * the same session flag the PIN sets.
 */
export async function openWithFingerprint(): Promise<boolean> {
  try {
    const options = await api.post<RequestOptionsJSON>('/api/auth/webauthn/open/options');
    const publicKey: PublicKeyCredentialRequestOptions = {
      ...options,
      challenge: toBuffer(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map(descriptor),
    };
    const assertion = await navigator.credentials.get({ publicKey });
    if (!assertion) return false;
    await api.post('/api/auth/webauthn/open/verify', serialize(assertion as PublicKeyCredential));
    return true;
  } catch { return false; }
}
