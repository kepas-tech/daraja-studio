import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { withSystem } from '../src/db/pool.js';
import { sha256 } from '../src/crypto/secrets.js';
import { makeApp, resetTables, deleteOrg, TEST_ORG_ID } from './helpers.js';

/**
 * Standing an organisation up together with its first owner, in one transaction.
 *
 * This is the way anything that is not the studio's own setup does it: one call, the pair or
 * neither, the owner written through the same code path the setup wizard uses, and a username
 * somebody already has refused plainly before anything exists.
 */
const { app, deps, close } = makeApp();
afterAll(async () => { await deps.events.stop(); await close(); });
beforeEach(() => resetTables(deps.db));

const PASSWORD = 'a-good-password-1';
const input = (over: Partial<{ name: string; username: string }> = {}) => ({
  name: over.name ?? 'Kodisap Limited',
  owner: { username: over.username ?? 'kodisap', displayName: 'Jane Wanjiru', password: PASSWORD },
  signupIp: '127.0.0.1',
});

/** How many organisations this install has, the operator's own view. */
const orgCount = async () => Number((await withSystem(() => deps.db.query<{ n: string }>('SELECT count(*)::text AS n FROM orgs')))[0]!.n);
const orgsNamed = async (name: string) => Number((await withSystem(() => deps.db.query<{ n: string }>(
  'SELECT count(*)::text AS n FROM orgs WHERE name = $1', [name])))[0]!.n);
const peopleNamed = async (username: string) => withSystem(() => deps.db.query<{ id: string; org_id: string; is_owner: boolean; is_host_admin: boolean; must_change_password: boolean }>(
  'SELECT id, org_id, is_owner, is_host_admin, must_change_password FROM people WHERE lower(username) = lower($1)', [username]));

describe('provisioning an organisation and its first owner', () => {
  it('makes both, and the owner belongs to the organisation it made', async () => {
    const before = await orgCount();
    const made = await deps.orgs.provision(input());
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    expect(made.org).toMatchObject({ name: 'Kodisap Limited', status: 'pending', isHost: false });
    expect(made.person).toMatchObject({ username: 'kodisap', display_name: 'Jane Wanjiru', is_owner: true, must_change_password: true });
    expect(await orgCount()).toBe(before + 1);

    const [person] = await peopleNamed('kodisap');
    // is_owner, but never a host admin: the host admin flag is the host organisation's owner alone
    // (spec 6.1), and this is a tenant's owner in a tenant's organisation.
    expect(person).toMatchObject({ org_id: made.org.id, is_owner: true, is_host_admin: false, must_change_password: true });
    // The callback secret is real, and what is on the row is its hash rather than the secret.
    const [row] = await withSystem(() => deps.db.query<{ callback_secret_hash: string; callback_secret_enc: string }>(
      'SELECT callback_secret_hash, callback_secret_enc FROM orgs WHERE id = $1', [made.org.id]));
    expect(row!.callback_secret_hash).toBe(sha256(made.secret));
    expect(row!.callback_secret_enc).not.toContain(made.secret);

    await deleteOrg(made.org.id);
  });

  it('refuses a username somebody already has, and leaves nothing behind', async () => {
    const first = await deps.orgs.provision(input({ name: 'First Tenant', username: 'somebody' }));
    expect(first.ok).toBe(true);
    const before = await orgCount();

    // Any spelling of it: usernames are compared without case, across the whole install.
    for (const username of ['somebody', 'SOMEBODY']) {
      const refused = await deps.orgs.provision(input({ name: 'Second Tenant', username }));
      expect(refused).toMatchObject({ ok: false, problem: 'username_taken' });
      if (!refused.ok) expect(refused.message).toMatch(/already uses that name/);
    }
    // No organisation was made for the refused attempts, and nobody else was written.
    expect(await orgCount()).toBe(before);
    expect(await orgsNamed('Second Tenant')).toBe(0);
    expect(await peopleNamed('somebody')).toHaveLength(1);

    if (first.ok) await deleteOrg(first.org.id);
  });

  it('writes the pair or neither when two callers want the same username at once', async () => {
    // Both pass the friendly check, because neither can see the other's uncommitted row: the
    // unique index is what decides, and the loser's whole transaction — its organisation included —
    // goes with it.
    const before = await orgCount();
    const [one, two] = await Promise.all([
      deps.orgs.provision(input({ name: 'Race One', username: 'the-same' })),
      deps.orgs.provision(input({ name: 'Race Two', username: 'the-same' })),
    ]);
    const outcomes = [one, two];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.problem === 'username_taken')).toHaveLength(1);

    expect(await orgCount()).toBe(before + 1);
    expect(await peopleNamed('the-same')).toHaveLength(1);
    // Exactly one of the two organisations exists, and it is the one whose owner won.
    const winner = outcomes.find((o) => o.ok);
    expect(await orgsNamed(winner!.ok ? winner!.org.name : '')).toBe(1);
    expect(await orgsNamed(winner!.ok && winner!.org.name === 'Race One' ? 'Race Two' : 'Race One')).toBe(0);
    if (winner?.ok) await deleteOrg(winner.org.id);
  });

  it('refuses a username that is not one, and a password that is too short, without making anything', async () => {
    const before = await orgCount();
    const badName = await deps.orgs.provision({ ...input(), owner: { ...input().owner, username: 'no' } });
    expect(badName).toMatchObject({ ok: false, problem: 'invalid' });
    const badPassword = await deps.orgs.provision({ ...input(), owner: { ...input().owner, password: 'short' } });
    expect(badPassword).toMatchObject({ ok: false, problem: 'invalid' });
    const noOrgName = await deps.orgs.provision({ ...input(), name: '   ' });
    expect(noOrgName).toMatchObject({ ok: false, problem: 'invalid' });
    expect(await orgCount()).toBe(before);
  });

  it('makes a person who can sign in, and lands them in their own organisation', async () => {
    const made = await deps.orgs.provision(input({ name: 'Kodisap Limited', username: 'kodisap' }));
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const login = await request(app).post('/api/auth/login').send({ username: 'kodisap', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.person).toMatchObject({ username: 'kodisap', display_name: 'Jane Wanjiru', must_change_password: true });

    // The session belongs to the organisation just made, which is the whole point of the pair.
    const me = await request(app).get('/api/auth/me').set('Cookie', login.headers['set-cookie'][0] as string);
    expect(me.status).toBe(200);
    expect(me.body.org?.id).toBe(made.org.id);
    // And a wrong password does not.
    const wrong = await request(app).post('/api/auth/login').send({ username: 'kodisap', password: PASSWORD + 'x' });
    expect(wrong.status).toBe(401);

    await deleteOrg(made.org.id);
  });

  it('answers which organisation this install is, and its owner, for a caller with no context', async () => {
    // The test database's organisation is the install's own, so this is the answer a command or a job
    // would get: the host organisation, named, with its owner — and a tenant's organisation made a
    // moment later does not become the answer.
    await resetTables(deps.db);
    await withSystem(() => deps.db.query(
      `INSERT INTO people(org_id, username, display_name, password_hash, is_owner) VALUES ($1, 'the-owner', 'The Owner', 'x', true)`,
      [TEST_ORG_ID]));
    const made = await deps.orgs.provision(input({ name: 'Kodisap Limited', username: 'kodisap' }));
    expect(made.ok).toBe(true);

    const host = await deps.orgs.host();
    expect(host).toMatchObject({ id: TEST_ORG_ID, name: 'Test organisation' });
    const [owner] = await withSystem(() => deps.db.query<{ id: string }>(
      `SELECT id FROM people WHERE org_id = $1 AND is_owner`, [TEST_ORG_ID]));
    expect(host!.ownerId).toBe(owner!.id);

    if (made.ok) await deleteOrg(made.org.id);
  });
});
