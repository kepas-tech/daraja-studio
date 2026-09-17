import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { hashPassword } from '../src/auth/password.js';
import { CHALLENGE_TTL_SECONDS, type CeremonyOptions, type WebauthnCredentialShape, type WebauthnVerifier } from '../src/auth/webauthn.js';
import { makeApp, resetTables } from './helpers.js';

/**
 * A verifier that answers without an authenticator. Every ceremony is settled by this object, which
 * is the whole point of putting the library behind the service boundary: everything Studio owns —
 * the challenge's life, the counter rule, who may enrol — is tested here on its own.
 */
class FakeVerifier implements WebauthnVerifier {
  registrationOptions: CeremonyOptions = { challenge: 'challenge-register' };
  authenticationOptions: CeremonyOptions = { challenge: 'challenge-open' };
  registration: { verified: boolean; credential?: WebauthnCredentialShape } = {
    verified: true,
    credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
  };
  authentication: { verified: boolean; newCounter?: number } = { verified: true, newCounter: 0 };
  async generateRegistrationOptions() { return this.registrationOptions; }
  async verifyRegistration() { return this.registration; }
  async generateAuthenticationOptions() { return this.authenticationOptions; }
  async verifyAuthentication() { return this.authentication; }
}

const fake = new FakeVerifier();
const { app, deps, close } = makeApp({ webauthn: fake });
afterAll(close);

const PASSWORD = 'correct horse';
const PIN = '246813';

async function seedOwner(username = 'owner') {
  await deps.db.query(
    `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ($1,'Owner',$2,true)`,
    [username, await hashPassword(PASSWORD)],
  );
}
/** Somebody who is not the owner: there is only ever one of those in an organisation. */
async function seedPerson(username: string) {
  await deps.db.query(
    `INSERT INTO people(username, display_name, password_hash, is_owner, role) VALUES ($1,$1,$2,false,'operator')`,
    [username, await hashPassword(PASSWORD)],
  );
}
async function signIn(username = 'owner') {
  const r = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return { cookie: r.headers['set-cookie'][0] as string, csrf: r.body.csrf as string };
}
type Session = Awaited<ReturnType<typeof signIn>>;

const post = (s: Session, path: string, body: unknown = {}) =>
  request(app).post(path).set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body as object);
const get = (s: Session, path: string) => request(app).get(path).set('Cookie', s.cookie);
const setPin = (s: Session) => request(app).put('/api/auth/pin').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({ password: PASSWORD, newPin: PIN });
const lock = (s: Session) => request(app).post('/api/auth/lock').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({});
const credentialBody = (id = 'cred-1') => ({ id, rawId: id, type: 'public-key', response: { clientDataJSON: 'x', attestationObject: 'y' } });

/** Register the fake credential on an open session, the way the browser does it: options, then verify. */
async function enrol(s: Session) {
  const options = await post(s, '/api/auth/webauthn/register/options');
  expect(options.status).toBe(200);
  const verify = await post(s, '/api/auth/webauthn/register/verify', credentialBody());
  expect(verify.status).toBe(204);
  return options.body as CeremonyOptions;
}

describe('fingerprint (WebAuthn)', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
    await seedOwner();
    fake.registration = { verified: true, credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] } };
    fake.authentication = { verified: true, newCounter: 0 };
    fake.registrationOptions = { challenge: 'challenge-register' };
    fake.authenticationOptions = { challenge: 'challenge-open' };
  });

  it('stores the challenge for five minutes and lets it be read exactly once', async () => {
    const s = await signIn();
    const options = await enrol(s);
    expect(options.challenge).toBe('challenge-register');
    const [row] = await deps.db.query<{ expires_at: Date; value: string }>(
      `SELECT expires_at, value FROM cache WHERE key LIKE '%webauthn:register%'`,
    );
    // Spent by the verify above, so the row is already gone: the assertion is that the ceremony
    // consumed it, and that a second answer with the same body has nothing to match.
    expect(row).toBeUndefined();
    const again = await post(s, '/api/auth/webauthn/register/verify', credentialBody());
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('webauthn_challenge');

    // A fresh ceremony leaves a row with five minutes on it.
    await post(s, '/api/auth/webauthn/register/options');
    const [fresh] = await deps.db.query<{ left: number }>(
      `SELECT EXTRACT(EPOCH FROM (expires_at - now()))::int AS left FROM cache WHERE key LIKE '%webauthn:register%'`,
    );
    expect(fresh.left).toBeGreaterThan(CHALLENGE_TTL_SECONDS - 30);
    expect(fresh.left).toBeLessThanOrEqual(CHALLENGE_TTL_SECONDS);

    const [credential] = await deps.db.query<{ device_label: string; counter: string; public_key: Buffer }>(
      'SELECT device_label, counter, public_key FROM webauthn_credentials',
    );
    expect(credential.device_label).toBe('This device');
    expect(Number(credential.counter)).toBe(0);
    expect(credential.public_key.length).toBe(4);
  });

  it('refuses an expired challenge', async () => {
    const s = await signIn();
    await post(s, '/api/auth/webauthn/register/options');
    await deps.db.query(`UPDATE cache SET expires_at = now() - interval '1 minute' WHERE key LIKE '%webauthn:register%'`);
    const verify = await post(s, '/api/auth/webauthn/register/verify', credentialBody());
    expect(verify.status).toBe(400);
    expect(verify.body.error.code).toBe('webauthn_challenge');
    expect(await deps.db.query('SELECT 1 FROM webauthn_credentials')).toEqual([]);
  });

  it('refuses an unknown credential, as if it did not exist', async () => {
    const s = await signIn();
    await enrol(s);
    await post(s, '/api/auth/webauthn/open/options');
    const verify = await post(s, '/api/auth/webauthn/open/verify', credentialBody('somebody-elses'));
    expect(verify.status).toBe(401);
    expect(verify.body.error.code).toBe('webauthn_failed');
    expect((await get(s, '/api/auth/me')).body.pin.locked).toBe(false);
  });

  it('refuses a counter that goes backwards and leaves the credential alone', async () => {
    const s = await signIn();
    await enrol(s);
    await deps.db.query('UPDATE webauthn_credentials SET counter = 5');
    fake.authentication = { verified: true, newCounter: 3 };
    await post(s, '/api/auth/webauthn/open/options');
    const verify = await post(s, '/api/auth/webauthn/open/verify', credentialBody());
    expect(verify.status).toBe(401);
    const [row] = await deps.db.query<{ counter: string; last_used_at: Date | null }>('SELECT counter, last_used_at FROM webauthn_credentials');
    expect(Number(row.counter)).toBe(5);
    expect(row.last_used_at).toBeNull();

    // The same ceremony with a counter that moves forward is accepted, and the row follows it.
    fake.authentication = { verified: true, newCounter: 6 };
    await post(s, '/api/auth/webauthn/open/options');
    expect((await post(s, '/api/auth/webauthn/open/verify', credentialBody())).status).toBe(204);
    const [after] = await deps.db.query<{ counter: string; last_used_at: Date | null }>('SELECT counter, last_used_at FROM webauthn_credentials');
    expect(Number(after.counter)).toBe(6);
    expect(after.last_used_at).not.toBeNull();
  });

  it('refuses another person\'s credential, as if it did not exist', async () => {
    // Two people in the same organisation, each with a credential of their own.
    const first = await signIn();
    await enrol(first);
    await seedPerson('second');
    const second = await signIn('second');
    fake.registration = { verified: true, credential: { id: 'cred-2', publicKey: new Uint8Array([9]), counter: 0 } };
    await enrol(second);

    // The second person runs a ceremony of their own but answers with the first person's credential:
    // the lookup is scoped to the person, so it is as if that credential never existed.
    await post(second, '/api/auth/webauthn/open/options');
    const verify = await post(second, '/api/auth/webauthn/open/verify', credentialBody('cred-1'));
    expect(verify.status).toBe(401);
    expect(verify.body.error.code).toBe('webauthn_failed');
    // Their own credential still works, so the refusal was the ownership rule and nothing else.
    await post(second, '/api/auth/webauthn/open/options');
    expect((await post(second, '/api/auth/webauthn/open/verify', credentialBody('cred-2'))).status).toBe(204);

    // Somebody with no credential at all is never offered a ceremony.
    await seedPerson('third');
    const third = await signIn('third');
    expect((await post(third, '/api/auth/webauthn/open/options')).status).toBe(401);
  });

  it('opens exactly what the PIN opens, on this session only', async () => {
    const s = await signIn();
    await setPin(s);
    await enrol(s);
    // A second device, still locked.
    const other = await signIn();
    await lock(s);
    await lock(other);

    await post(s, '/api/auth/webauthn/open/options');
    expect((await post(s, '/api/auth/webauthn/open/verify', credentialBody())).status).toBe(204);
    expect((await get(s, '/api/auth/me')).body.pin.locked).toBe(false);
    // Nothing else moved: the other session is still locked, and the credential is the only new fact.
    expect((await get(other, '/api/auth/me')).body.pin.locked).toBe(true);
    expect((await get(s, '/api/auth/me')).body.pin.bio).toBe(true);
  });

  it('needs an open session to enrol, and to see or remove the devices', async () => {
    const s = await signIn();
    await setPin(s);
    await lock(s);
    // A locked session may only open itself.
    expect((await post(s, '/api/auth/webauthn/register/options')).status).toBe(423);
    expect((await get(s, '/api/auth/webauthn/credentials')).status).toBe(423);
    expect((await post(s, '/api/auth/webauthn/credentials/remove', { id: 'cred-1', password: PASSWORD })).status).toBe(423);
    // Anonymous callers get nothing at all.
    expect((await request(app).post('/api/auth/webauthn/open/options').send({})).status).toBe(401);
  });

  it('removes one device behind the step-up, and every device with the PIN', async () => {
    const s = await signIn();
    await setPin(s);
    await enrol(s);
    expect((await get(s, '/api/auth/webauthn/credentials')).body.items).toHaveLength(1);

    // The step-up is the password (or the PIN): without it nothing is removed.
    const refused = await post(s, '/api/auth/webauthn/credentials/remove', { id: 'cred-1' });
    expect(refused.status).toBe(403);
    expect((await get(s, '/api/auth/webauthn/credentials')).body.items).toHaveLength(1);

    const wrong = await post(s, '/api/auth/webauthn/credentials/remove', { id: 'cred-1', password: 'nope' });
    expect(wrong.status).toBe(403);
    expect((await get(s, '/api/auth/webauthn/credentials')).body.items).toHaveLength(1);

    expect((await post(s, '/api/auth/webauthn/credentials/remove', { id: 'cred-1', password: PASSWORD })).status).toBe(204);
    expect((await get(s, '/api/auth/webauthn/credentials')).body.items).toHaveLength(0);

    // Enrol again, then take the PIN away: the fingerprint goes with it.
    await enrol(s);
    expect((await get(s, '/api/auth/me')).body.pin.bio).toBe(true);
    expect((await request(app).delete('/api/auth/pin').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({ password: PASSWORD })).status).toBe(204);
    expect(await deps.db.query('SELECT 1 FROM webauthn_credentials')).toEqual([]);
    expect((await get(s, '/api/auth/me')).body.pin.bio).toBe(false);
  });

  it('says nothing about a credential in me before one exists', async () => {
    const s = await signIn();
    const me = await get(s, '/api/auth/me');
    expect(me.body.pin).toEqual({ set: false, locked: false, bio: false });
    // No identifier, no key, no counter anywhere in the answer.
    expect(JSON.stringify(me.body)).not.toContain('cred-1');
  });
});
