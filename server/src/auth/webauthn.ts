import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Cache } from '../db/cache.js';
import type { Db } from '../db/pool.js';
import { HttpError } from '../util/errors.js';

/** Five minutes to finish a ceremony, then the challenge is gone. */
export const CHALLENGE_TTL_SECONDS = 300;
const RP_NAME = 'Daraja Studio';

/**
 * The four library calls, behind one small interface. Tests hand in a fake here and never need an
 * authenticator: everything above this line — the challenge's life, the counter rule, who may
 * enrol — is Studio's own code and is tested on its own.
 */
export interface WebauthnCredentialShape { id: string; publicKey: Uint8Array<ArrayBuffer>; counter: number; transports?: string[] }

/** The ceremony options as JSON. Studio itself reads only the challenge out of them; the browser
 *  reads the rest, and it is passed through untouched. */
export type CeremonyOptions = { challenge: string };

export interface WebauthnVerifier {
  generateRegistrationOptions(opts: {
    rpName: string; rpID: string; userName: string; userID: Uint8Array<ArrayBuffer>;
    excludeCredentials: { id: string; transports?: string[] }[];
    authenticatorSelection: { authenticatorAttachment: 'platform'; userVerification: 'required'; residentKey: 'preferred' };
  }): Promise<CeremonyOptions>;
  verifyRegistration(opts: { response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRPID: string }): Promise<{ verified: boolean; credential?: WebauthnCredentialShape }>;
  generateAuthenticationOptions(opts: { rpID: string; userVerification: 'required'; allowCredentials: { id: string; transports?: string[] }[] }): Promise<CeremonyOptions>;
  verifyAuthentication(opts: { response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRPID: string; credential: WebauthnCredentialShape }): Promise<{ verified: boolean; newCounter?: number }>;
}

/** The real thing: @simplewebauthn/server, with user verification and the origin checked on both ceremonies. */
export const realVerifier: WebauthnVerifier = {
  generateRegistrationOptions: (opts) => generateRegistrationOptions({ ...opts, attestationType: 'none' }),
  async verifyRegistration(opts) {
    const v = await verifyRegistrationResponse({
      response: opts.response as RegistrationResponseJSON,
      expectedChallenge: opts.expectedChallenge,
      expectedOrigin: opts.expectedOrigin,
      expectedRPID: opts.expectedRPID,
      requireUserVerification: true,
    });
    if (!v.verified || !v.registrationInfo) return { verified: false };
    const c = v.registrationInfo.credential;
    return { verified: true, credential: { id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports } };
  },
  generateAuthenticationOptions: (opts) => generateAuthenticationOptions({ ...opts, userVerification: 'required' }),
  async verifyAuthentication(opts) {
    const v = await verifyAuthenticationResponse({
      response: opts.response as AuthenticationResponseJSON,
      expectedChallenge: opts.expectedChallenge,
      expectedOrigin: opts.expectedOrigin,
      expectedRPID: opts.expectedRPID,
      requireUserVerification: true,
      credential: opts.credential,
    });
    return v.verified ? { verified: true, newCounter: v.authenticationInfo.newCounter } : { verified: false };
  },
};

export interface CredentialRow {
  credential_id: string; public_key: Buffer; counter: string | number; transports: string[] | null;
  device_label: string | null; created_at: Date; last_used_at: Date | null;
}

export interface DeviceView { id: string; label: string; createdAt: Date; lastUsedAt: Date | null }

export interface WebauthnService {
  /** False when this install has no public address to be a relying party for. */
  ready(): boolean;
  has(personId: string): Promise<boolean>;
  list(personId: string): Promise<DeviceView[]>;
  registerOptions(person: { id: string; username: string }, sessionId: string): Promise<CeremonyOptions>;
  registerVerify(person: { id: string }, sessionId: string, response: unknown, userAgent: string): Promise<void>;
  openOptions(person: { id: string }, sessionId: string): Promise<CeremonyOptions>;
  openVerify(person: { id: string }, sessionId: string, response: unknown): Promise<void>;
  remove(personId: string, credentialId: string): Promise<void>;
  removeAll(personId: string): Promise<void>;
}

/** A short, friendly word for the device the browser is running on. Never logged, only shown. */
export function deviceLabel(userAgent: string): string {
  const s = userAgent.toLowerCase();
  if (s.includes('iphone')) return 'iPhone';
  if (s.includes('ipad')) return 'iPad';
  if (s.includes('android')) return 'Android phone';
  if (s.includes('macintosh') || s.includes('mac os x')) return 'Mac';
  if (s.includes('windows')) return 'Windows PC';
  if (s.includes('linux')) return 'Linux PC';
  return 'This device';
}

/** Where the ceremonies happen: the hostname of the public address, and that address as the origin. */
export function relyingParty(publicUrl: string | undefined): { rpID: string; origin: string } | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    return { rpID: url.hostname, origin: url.origin };
  } catch { return null; }
}

const failed = () => new HttpError(401, 'webauthn_failed', 'That fingerprint was not recognised. Use your PIN.');

export function createWebauthnService(deps: { db: Db; cache: Cache; publicUrl?: string; verifier?: WebauthnVerifier }): WebauthnService {
  const verifier = deps.verifier ?? realVerifier;
  const rp = relyingParty(deps.publicUrl);
  const key = (ceremony: 'register' | 'open', sessionId: string) => `webauthn:${ceremony}:${sessionId}`;
  const unavailable = () => new HttpError(503, 'webauthn_unavailable', 'Fingerprint is not available on this address.');

  async function rows(personId: string): Promise<CredentialRow[]> {
    return deps.db.query<CredentialRow>(
      'SELECT credential_id, public_key, counter, transports, device_label, created_at, last_used_at FROM webauthn_credentials WHERE person_id=$1 ORDER BY created_at DESC',
      [personId],
    );
  }

  return {
    ready: () => rp !== null,
    async has(personId) {
      const r = await deps.db.query<{ one: number }>('SELECT 1 AS one FROM webauthn_credentials WHERE person_id=$1 LIMIT 1', [personId]);
      return r.length > 0;
    },
    async list(personId) {
      return (await rows(personId)).map((r) => ({
        id: r.credential_id,
        label: r.device_label ?? 'This device',
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      }));
    },
    async registerOptions(person, sessionId) {
      if (!rp) throw unavailable();
      const existing = await rows(person.id);
      const options = await verifier.generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rp.rpID,
        userName: person.username,
        userID: new TextEncoder().encode(person.id),
        excludeCredentials: existing.map((c) => ({ id: c.credential_id, ...(c.transports ? { transports: c.transports } : {}) })),
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      });
      await deps.cache.set(key('register', sessionId), options.challenge, CHALLENGE_TTL_SECONDS);
      return options;
    },
    async registerVerify(person, sessionId, response, userAgent) {
      if (!rp) throw unavailable();
      // One shot: the challenge is gone the moment it is read, so a replayed answer has nothing to
      // match against, and an expired one is simply not there.
      const challenge = await deps.cache.take<string>(key('register', sessionId));
      if (!challenge) throw new HttpError(400, 'webauthn_challenge', 'That took too long. Try the fingerprint again.');
      const result = await verifier.verifyRegistration({
        response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
      });
      if (!result.verified || !result.credential) throw failed();
      const c = result.credential;
      await deps.db.query(
        `INSERT INTO webauthn_credentials(credential_id, person_id, public_key, counter, transports, device_label)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (credential_id) DO UPDATE SET public_key=EXCLUDED.public_key, counter=EXCLUDED.counter,
                                                   transports=EXCLUDED.transports, device_label=EXCLUDED.device_label`,
        [c.id, person.id, Buffer.from(c.publicKey), c.counter || 0, c.transports ?? null, deviceLabel(userAgent)],
      );
    },
    async openOptions(person, sessionId) {
      if (!rp) throw unavailable();
      const existing = await rows(person.id);
      // No credential means no ceremony, and the lock screen never offered one: refuse as if the
      // request were for something that does not exist.
      if (existing.length === 0) throw failed();
      const options = await verifier.generateAuthenticationOptions({
        rpID: rp.rpID,
        userVerification: 'required',
        allowCredentials: existing.map((c) => ({ id: c.credential_id, ...(c.transports ? { transports: c.transports } : {}) })),
      });
      await deps.cache.set(key('open', sessionId), options.challenge, CHALLENGE_TTL_SECONDS);
      return options;
    },
    async openVerify(person, sessionId, response) {
      if (!rp) throw unavailable();
      const challenge = await deps.cache.take<string>(key('open', sessionId));
      if (!challenge) throw new HttpError(400, 'webauthn_challenge', 'That took too long. Try the fingerprint again.');
      const id = (response as { id?: unknown } | null)?.id;
      // The credential must belong to this person: somebody else's is refused as if it did not exist.
      const row = typeof id === 'string'
        ? (await deps.db.query<CredentialRow>(
            'SELECT credential_id, public_key, counter, transports, device_label, created_at, last_used_at FROM webauthn_credentials WHERE person_id=$1 AND credential_id=$2',
            [person.id, id],
          ))[0]
        : undefined;
      if (!row) throw failed();
      const stored = Number(row.counter);
      const result = await verifier.verifyAuthentication({
        response, expectedChallenge: challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
        credential: { id: row.credential_id, publicKey: new Uint8Array(row.public_key), counter: stored, ...(row.transports ? { transports: row.transports } : {}) },
      });
      if (!result.verified) throw failed();
      // The counter must never go backwards: a cloned authenticator is refused, and the stored row
      // is left exactly as it was.
      const next = result.newCounter ?? stored;
      if (next < stored) throw failed();
      await deps.db.query('UPDATE webauthn_credentials SET counter=$2, last_used_at=now() WHERE person_id=$1 AND credential_id=$3', [person.id, next, row.credential_id]);
    },
    async remove(personId, credentialId) {
      await deps.db.query('DELETE FROM webauthn_credentials WHERE person_id=$1 AND credential_id=$2', [personId, credentialId]);
    },
    async removeAll(personId) {
      await deps.db.query('DELETE FROM webauthn_credentials WHERE person_id=$1', [personId]);
    },
  };
}
