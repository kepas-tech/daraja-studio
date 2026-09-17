import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { hashPassword } from '../src/auth/password.js';
import { MAX_FAILURES } from '../src/auth/lockout.js';
import { PIN_IDLE_MINUTES } from '../src/auth/pin.js';
import { makeApp, resetTables } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(close);

const PIN = '246813';
const PASSWORD = 'correct horse';

async function seedOwner() {
  await deps.db.query(
    `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('owner','Owner',$1,true)`,
    [await hashPassword(PASSWORD)],
  );
}

/** A logged-in owner. A login starts unlocked: the password was just typed. */
async function signIn() {
  const r = await request(app).post('/api/auth/login').send({ username: 'owner', password: PASSWORD });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return { cookie: r.headers['set-cookie'][0] as string, csrf: r.body.csrf as string };
}
type Session = Awaited<ReturnType<typeof signIn>>;

const me = (s: Session) => request(app).get('/api/auth/me').set('Cookie', s.cookie);
const setPin = (s: Session, body: unknown) => request(app).put('/api/auth/pin').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body);
const removePin = (s: Session, body: unknown) => request(app).delete('/api/auth/pin').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body);
const openSession = (s: Session, body: unknown) => request(app).post('/api/auth/open').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body);
const lock = (s: Session) => request(app).post('/api/auth/lock').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({});
/** A real step-up action: setting the Safaricom callback address list. */
const allowlist = (s: Session, body: unknown) => request(app).put('/api/settings/allowlist').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send(body);

const set = (s: Session) => setPin(s, { password: PASSWORD, newPin: PIN });

describe('PIN lock', () => {
  beforeEach(async () => { await resetTables(deps.db); await seedOwner(); });

  it('sets a PIN with the password, stores only an argon2 hash, and never writes the PIN down', async () => {
    const s = await signIn();
    expect((await set(s)).status).toBe(204);

    expect((await me(s)).body.pin).toEqual({ set: true, locked: false });
    const [row] = await deps.db.query<{ pin_hash: string; pin_set_at: Date | null }>('SELECT pin_hash, pin_set_at FROM people');
    expect(row.pin_hash).toMatch(/^\$argon2id\$/);
    expect(row.pin_hash).not.toContain(PIN);
    expect(row.pin_set_at).not.toBeNull();

    // The PIN itself is nowhere in the answer to /me either.
    expect(JSON.stringify((await me(s)).body)).not.toContain(PIN);
    const auditRows = await deps.db.query<{ action: string; blob: string }>(
      `SELECT action, concat_ws(' ', target, before_json::text, after_json::text, ip) AS blob FROM audit_log`,
    );
    expect(auditRows.some((r) => r.action === 'auth.pin_set')).toBe(true);
    expect(auditRows.filter((r) => r.blob.includes(PIN))).toEqual([]);
  });

  it('refuses a PIN that is not six digits, and one set without the password', async () => {
    const s = await signIn();
    expect((await setPin(s, { password: PASSWORD, newPin: '12345' })).status).toBe(400);
    expect((await setPin(s, { password: PASSWORD, newPin: '1234567' })).status).toBe(400);
    expect((await setPin(s, { password: PASSWORD, newPin: '12a456' })).status).toBe(400);
    expect((await setPin(s, { password: 'wrong', newPin: PIN })).status).toBe(403);
    expect((await setPin(s, { newPin: PIN, pin: PIN })).status).toBe(403);
    const [row] = await deps.db.query<{ pin_hash: string | null }>('SELECT pin_hash FROM people');
    expect(row.pin_hash).toBeNull();
    expect((await me(s)).body.pin).toEqual({ set: false, locked: false });
  });

  it('locks the session and refuses a money action until the PIN is entered', async () => {
    const s = await signIn();
    await set(s);
    expect((await lock(s)).status).toBe(204);
    expect((await me(s)).body.pin).toEqual({ set: true, locked: true });

    // The password does not open a locked session through an ordinary action...
    const refused = await allowlist(s, { allowlist: ['1.2.3.4'], password: PASSWORD });
    expect(refused.status).toBe(423);
    expect(refused.body.error.code).toBe('session_locked');
    // ...and the PIN does not either: the lock is entered first, not stepped over.
    expect((await allowlist(s, { allowlist: ['1.2.3.4'], pin: PIN })).status).toBe(423);

    expect((await openSession(s, { pin: PIN })).status).toBe(204);
    expect((await me(s)).body.pin.locked).toBe(false);
    // Unlocked, the PIN is the step-up on the action itself, as the brief asks.
    expect((await allowlist(s, { allowlist: ['1.2.3.4'], pin: PIN })).status).toBe(204);
  });

  it('opens a locked session with the password as well, for a forgotten PIN', async () => {
    const s = await signIn();
    await set(s);
    await lock(s);
    expect((await openSession(s, { password: PASSWORD })).status).toBe(204);
    expect((await me(s)).body.pin.locked).toBe(false);
  });

  it('locks the PIN after five wrong tries, and leaves the password as the way back in', async () => {
    const s = await signIn();
    await set(s);
    await lock(s);
    for (let i = 0; i < MAX_FAILURES; i++) {
      const r = await openSession(s, { pin: '000000' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('pin_wrong');
    }
    const sixth = await openSession(s, { pin: PIN });
    expect(sixth.status).toBe(423);
    expect(sixth.body.error.code).toBe('pin_locked');
    // Still locked, and the password still works.
    expect((await me(s)).body.pin.locked).toBe(true);
    expect((await openSession(s, { password: PASSWORD })).status).toBe(204);
  });

  it('counts wrong PINs tried on a money action on the same counter', async () => {
    const s = await signIn();
    await set(s);
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await allowlist(s, { allowlist: ['1.2.3.4'], pin: '999999' })).status).toBe(403);
    }
    const sixth = await allowlist(s, { allowlist: ['1.2.3.4'], pin: PIN });
    expect(sixth.status).toBe(423);
    expect(sixth.body.error.code).toBe('pin_locked');
  });

  it('locks again on its own after the idle window', async () => {
    const s = await signIn();
    await set(s);
    expect((await me(s)).body.pin.locked).toBe(false);
    await deps.db.query(`UPDATE sessions SET pin_entered_at = now() - ($1 || ' minutes')::interval`, [String(PIN_IDLE_MINUTES + 1)]);
    expect((await me(s)).body.pin.locked).toBe(true);
    expect((await allowlist(s, { allowlist: ['1.2.3.4'], pin: PIN })).status).toBe(423);
    // One openSession covers the next PIN_IDLE_MINUTES, not forever.
    expect((await openSession(s, { pin: PIN })).status).toBe(204);
    expect((await allowlist(s, { allowlist: ['1.2.3.4'], pin: PIN })).status).toBe(204);
  });

  it('gates the actions that never asked for a password, and leaves reads alone', async () => {
    const s = await signIn();
    await set(s);
    await lock(s);
    // Asking a payer's phone for money waits for the PIN; an invalid body is never reached.
    const stk = await request(app).post('/api/collect/stk').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({});
    expect(stk.status).toBe(423);
    expect(stk.body.error.code).toBe('session_locked');
    // Reads are not gated: the lock is about what a hand that is not yours could do.
    expect((await request(app).get('/api/settings').set('Cookie', s.cookie)).status).toBe(200);
    await openSession(s, { pin: PIN });
    expect((await request(app).post('/api/collect/stk').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({})).status).not.toBe(423);
  });

  it('changes nothing when no PIN is set', async () => {
    const s = await signIn();
    expect((await me(s)).body.pin).toEqual({ set: false, locked: false });
    expect((await allowlist(s, { allowlist: ['1.2.3.4'], password: PASSWORD })).status).toBe(204);
    // A body carrying a PIN is not a password: it is refused like any other wrong confirmation.
    expect((await allowlist(s, { allowlist: ['1.2.3.4'], pin: PIN })).status).toBe(403);
  });

  it('removes the PIN with the password, and stops gating the session', async () => {
    const s = await signIn();
    await set(s);
    await lock(s);
    // Even this waits for the openSession: while a session is locked, opening is the only action it has.
    expect((await removePin(s, { password: PASSWORD })).status).toBe(423);
    await openSession(s, { password: PASSWORD });
    expect((await removePin(s, { password: PASSWORD })).status).toBe(204);
    expect((await me(s)).body.pin).toEqual({ set: false, locked: false });
    const [row] = await deps.db.query<{ pin_hash: string | null; pin_set_at: Date | null }>('SELECT pin_hash, pin_set_at FROM people');
    expect(row.pin_hash).toBeNull();
    expect(row.pin_set_at).toBeNull();
    expect((await allowlist(s, { allowlist: ['1.2.3.4'], password: PASSWORD })).status).toBe(204);
    const actions = (await deps.db.query<{ action: string }>('SELECT action FROM audit_log')).map((r) => r.action);
    expect(actions).toContain('auth.pin_removed');
  });

  it('counts wrong passwords on the openSession route on the password counter', async () => {
    const s = await signIn();
    await set(s);
    await lock(s);
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await openSession(s, { password: 'nope' })).status).toBe(403);
    }
    const sixth = await openSession(s, { password: PASSWORD });
    expect(sixth.status).toBe(423);
    expect(sixth.body.error.code).toBe('locked');
  });
});
