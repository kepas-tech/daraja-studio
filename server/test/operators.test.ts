import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { createOperatorService } from '../src/operators/service.js';
import { createEventHub } from '../src/events/hub.js';
import { testDeps, resetTables } from './helpers.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import type { EventHub } from '../src/events/hub.js';
import { decryptForOrg } from '../src/crypto/secrets.js';
import { generateKeyPairSync, publicEncrypt, privateDecrypt, constants } from 'node:crypto';

const deps = testDeps();
const events = createEventHub(deps.config.databaseUrl, deps.db);
afterAll(() => deps.db.end());

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

// A well-formed 256-byte (RSA-2048) SecurityCredential, as if pasted from the Safaricom
// portal's "Generate Security Credential" tool.
const pastedCredential = publicEncrypt(
  { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
  Buffer.from('Secret#123'),
).toString('base64');

// generateSecurityCredential RSA-encrypts with PKCS1 v1.5 padding, which is randomized —
// two credentials generated from the same password never match byte-for-byte. Decrypt with
// the matching private key instead of comparing ciphertext.
function passwordIn(securityCredentialB64: string): string {
  return privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(securityCredentialB64, 'base64')).toString('utf8');
}

function fakeFactory(query: () => Promise<unknown>): DarajaFactory {
  return {
    get: async () => ({ balance: { query } }) as never,
    getForOperator: async () => ({ balance: { query } }) as never,
    invalidate: () => {},
    stkEnabled: async () => false,
  };
}

function ackFor(oc: string): () => Promise<unknown> {
  return vi.fn(async () => ({ originatorConversationId: oc, conversationId: `AG-${oc}`, responseCode: '0', responseDescription: 'Accept the service request successfully.' }));
}

describe('operators', () => {
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('public.url', 'https://studio.example');
  });

  it('add → pending → probe sends balance query and records request + timeout job', async () => {
    const query = ackFor('OC-9');
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(query), events });
    const { id } = await svc.add('sandbox', { name: 'KEPAS', password: 'Secret#123', certPem }, { personId: null as never, ip: '1.1.1.1' });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ resultUrl: 'https://studio.example/cb/sekret/balance' }));
    const op = (await deps.db.query<{ status: string; credential_enc: string }>('SELECT status, credential_enc FROM operators WHERE id=$1', [id]))[0];
    expect(op.status).toBe('pending');
    expect(Buffer.from(await decryptForOrg(deps.keyring, op.credential_enc), 'base64').length).toBe(256);
    expect(passwordIn(await decryptForOrg(deps.keyring, op.credential_enc))).toBe('Secret#123');
    const req = (await deps.db.query<{ subtype: string; status: string }>(`SELECT subtype, status FROM requests WHERE originator_conversation_id='OC-9'`))[0];
    expect(req.subtype).toBe('operator_probe');
    expect(req.status).toBe('sent');
    expect((await deps.db.query(`SELECT 1 FROM jobs WHERE kind='operator_probe_timeout'`)).length).toBe(1);
    expect(await deps.settings.get('env.sandbox.certPem')).toContain('BEGIN PUBLIC KEY');
  });

  it('rejects parentheses in the password', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(async () => ({})), events });
    await expect(svc.add('sandbox', { name: 'X', password: 'bad(1)', certPem }, { personId: null as never, ip: '' })).rejects.toMatchObject({ status: 400, code: 'bad_password' });
  });

  it('sync SDK failure marks operator failed', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(async () => { throw new Error('Invalid SecurityCredential'); }), events });
    const { id } = await svc.add('sandbox', { name: 'BAD', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    const op = (await deps.db.query<{ status: string; last_error: string }>('SELECT status, last_error FROM operators WHERE id=$1', [id]))[0];
    expect(op.status).toBe('failed');
    expect(op.last_error).toMatch(/SecurityCredential/);
  });

  it('timeout handler fails a probe with no answer', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-T')), events });
    const { id } = await svc.add('sandbox', { name: 'SLOW', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    const before = (await deps.db.query<{ last_probe_at: Date }>('SELECT last_probe_at FROM operators WHERE id=$1', [id]))[0];
    const [req] = await deps.db.query<{ id: string }>(`SELECT id FROM requests WHERE originator_conversation_id='OC-T'`);
    await svc.timeoutHandler({ requestId: req.id }, { id: 'j', kind: 'operator_probe_timeout', payload: {}, attempts: 0, max_attempts: 1 });
    const op = (await deps.db.query<{ status: string; last_error: string; last_probe_at: Date }>('SELECT status, last_error, last_probe_at FROM operators WHERE id=$1', [id]))[0];
    expect(op.status).toBe('failed');
    expect(op.last_error).toMatch(/No answer/);
    // last_probe_at reflects the last *probe*, not the timeout that gave up on it.
    expect(op.last_probe_at.getTime()).toBe(before.last_probe_at.getTime());
    expect((await svc.list('sandbox'))[0].expiresAt).toBeTruthy();
  });

  it('timeout handler is a no-op once the probe has already resolved (no demotion of a verified operator)', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-DONE')), events });
    const { id } = await svc.add('sandbox', { name: 'DONE', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    const [req] = await deps.db.query<{ id: string }>(`SELECT id FROM requests WHERE originator_conversation_id='OC-DONE'`);
    // Simulate the real balance callback having already landed and completed the probe.
    await deps.db.query(`UPDATE requests SET status='completed' WHERE id=$1`, [req.id]);
    await deps.db.query(`UPDATE operators SET status='verified' WHERE id=$1`, [id]);

    await svc.timeoutHandler({ requestId: req.id }, { id: 'j', kind: 'operator_probe_timeout', payload: {}, attempts: 0, max_attempts: 1 });

    const op = (await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [id]))[0];
    expect(op.status).toBe('verified');
    const after = (await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [req.id]))[0];
    expect(after.status).toBe('completed');
  });

  // --- Decision 2: a Security Credential pasted from the Daraja 3.0 portal, in lieu of a password ---

  it('add-by-credential succeeds and probes', async () => {
    const query = ackFor('OC-C');
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(query), events });
    const { id } = await svc.add('sandbox', { name: 'PASTED', credential: pastedCredential }, { personId: null as never, ip: '1.1.1.1' });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ resultUrl: 'https://studio.example/cb/sekret/balance' }));
    const op = (await deps.db.query<{ status: string; credential_enc: string }>('SELECT status, credential_enc FROM operators WHERE id=$1', [id]))[0];
    expect(op.status).toBe('pending');
    expect(await decryptForOrg(deps.keyring, op.credential_enc)).toBe(pastedCredential);
    const req = (await deps.db.query<{ subtype: string; status: string }>(`SELECT subtype, status FROM requests WHERE originator_conversation_id='OC-C'`))[0];
    expect(req.subtype).toBe('operator_probe');
    expect(req.status).toBe('sent');
  });

  it('rejects both password and credential, or neither', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(async () => ({})), events });
    await expect(svc.add('sandbox', { name: 'BOTH', password: 'Secret#123', credential: pastedCredential }, { personId: null as never, ip: '' }))
      .rejects.toMatchObject({ status: 400, code: 'bad_input' });
    await expect(svc.add('sandbox', { name: 'NEITHER' }, { personId: null as never, ip: '' }))
      .rejects.toMatchObject({ status: 400, code: 'bad_input' });
  });

  it('rejects a credential that does not decode to 256 bytes', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(async () => ({})), events });
    const tooShort = Buffer.alloc(10, 1).toString('base64');
    await expect(svc.add('sandbox', { name: 'SHORT', credential: tooShort }, { personId: null as never, ip: '' }))
      .rejects.toMatchObject({ status: 400, code: 'bad_credential' });
  });

  it('strips whitespace from a pasted credential before storing it', async () => {
    const wrapped = (pastedCredential.match(/.{1,64}/g) ?? []).join('\n');
    expect(wrapped).not.toBe(pastedCredential);
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-WRAP')), events });
    const { id } = await svc.add('sandbox', { name: 'WRAP', credential: wrapped }, { personId: null as never, ip: '' });
    const op = (await deps.db.query<{ credential_enc: string }>('SELECT credential_enc FROM operators WHERE id=$1', [id]))[0];
    expect(await decryptForOrg(deps.keyring, op.credential_enc)).toBe(pastedCredential);
  });

  it('a pasted credential can still carry a certPem, saved for future password rotations', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-CC')), events });
    await svc.add('sandbox', { name: 'CREDCERT', credential: pastedCredential, certPem }, { personId: null as never, ip: '' });
    expect(await deps.settings.get('env.sandbox.certPem')).toBe(certPem);
  });

  it('rejects an unreadable certificate without persisting it or creating an operator', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(async () => ({})), events });
    await expect(svc.add('sandbox', { name: 'BADCERT', password: 'Secret#123', certPem: 'not a real certificate' }, { personId: null as never, ip: '' }))
      .rejects.toMatchObject({ status: 400, code: 'bad_cert' });
    expect(await deps.settings.get('env.sandbox.certPem')).toBeNull();
    expect((await deps.db.query(`SELECT 1 FROM operators WHERE name='BADCERT'`)).length).toBe(0);
  });

  it('a publish failure during probe is surfaced, not treated as a probe failure', async () => {
    const query = ackFor('OC-PUB');
    const badEvents: EventHub = {
      start: async () => {},
      stop: async () => {},
      publish: async () => { throw new Error('publish down'); },
      subscribe: () => () => {},
    };
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(query), events: badEvents });
    await expect(svc.add('sandbox', { name: 'PUB', password: 'Secret#123', certPem }, { personId: null as never, ip: '' })).rejects.toThrow(/publish down/);
    const op = (await deps.db.query<{ status: string }>(`SELECT status FROM operators WHERE name='PUB'`))[0];
    expect(op.status).toBe('pending');
  });

  it('add refuses to create an operator when the public address is not set, leaving no row behind', async () => {
    await deps.settings.delete('public.url');
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(async () => ({})), events });
    await expect(svc.add('sandbox', { name: 'ORPHAN', password: 'Secret#123', certPem }, { personId: null as never, ip: '' }))
      .rejects.toMatchObject({ status: 409, code: 'public_url_missing' });
    expect((await deps.db.query(`SELECT 1 FROM operators WHERE name='ORPHAN'`)).length).toBe(0);
  });

  it('rejects a duplicate operator name', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-D1')), events });
    await svc.add('sandbox', { name: 'DUPE', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    await expect(svc.add('sandbox', { name: 'DUPE', password: 'Secret#456', certPem }, { personId: null as never, ip: '' }))
      .rejects.toMatchObject({ status: 409, code: 'operator_exists' });
  });

  it('probe re-arms a failed operator ("Test again") back to pending and re-sends', async () => {
    const failingSvc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(async () => { throw new Error('down'); }), events });
    const { id } = await failingSvc.add('sandbox', { name: 'REPROBE', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    expect((await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [id]))[0].status).toBe('failed');

    const query = ackFor('OC-RP');
    const workingSvc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(query), events });
    await workingSvc.probe(id);

    expect((await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [id]))[0].status).toBe('pending');
    const req = (await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC-RP'`))[0];
    expect(req.status).toBe('sent');
  });

  it('rotate by password stores a new credential and re-probes', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-ROT1')), events });
    const { id } = await svc.add('sandbox', { name: 'ROT', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    const before = (await deps.db.query<{ credential_enc: string; rotated_at: Date }>('SELECT credential_enc, rotated_at FROM operators WHERE id=$1', [id]))[0];

    const query2 = ackFor('OC-ROT2');
    const svc2 = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(query2), events });
    await svc2.rotate(id, { password: 'NewSecret#456' }, { personId: null as never, ip: '' });

    const after = (await deps.db.query<{ credential_enc: string; rotated_at: Date; status: string; last_error: string | null }>('SELECT credential_enc, rotated_at, status, last_error FROM operators WHERE id=$1', [id]))[0];
    expect(after.credential_enc).not.toBe(before.credential_enc);
    expect(passwordIn(await decryptForOrg(deps.keyring, after.credential_enc))).toBe('NewSecret#456');
    expect(after.status).toBe('pending');
    expect(after.last_error).toBeNull();
    expect(after.rotated_at.getTime()).toBeGreaterThan(before.rotated_at.getTime());
    expect(query2).toHaveBeenCalledTimes(1);
  });

  it('rotate by pasted credential stores it and re-probes', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-ROT3')), events });
    const { id } = await svc.add('sandbox', { name: 'ROTC', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });

    const query2 = ackFor('OC-ROT4');
    const svc2 = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(query2), events });
    await svc2.rotate(id, { credential: pastedCredential }, { personId: null as never, ip: '' });

    const after = (await deps.db.query<{ credential_enc: string; status: string }>('SELECT credential_enc, status FROM operators WHERE id=$1', [id]))[0];
    expect(await decryptForOrg(deps.keyring, after.credential_enc)).toBe(pastedCredential);
    expect(after.status).toBe('pending');
    expect(query2).toHaveBeenCalledTimes(1);
  });

  it('rotate on a nonexistent operator 404s before writing an audit row (minor)', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(async () => ({})), events });
    // Use the credential path so the 404 isn't masked by cert_missing (no certPem has ever
    // been stored in this test).
    await expect(svc.rotate(fakeId, { credential: pastedCredential }, { personId: null as never, ip: '' }))
      .rejects.toMatchObject({ status: 404, code: 'operator_not_found' });
    // audit_log isn't truncated between tests in this file (see helpers.resetTables), so scope
    // to this specific (fake) target rather than asserting the table is empty.
    expect((await deps.db.query(`SELECT 1 FROM audit_log WHERE action='operator.rotated' AND target=$1`, [fakeId])).length).toBe(0);
  });

  it('rotate on an operator whose environment is not the active mode 409s wrong_environment before any write', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-ROTWE')), events });
    const { id } = await svc.add('sandbox', { name: 'ROTWE', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    const before = (await deps.db.query<{ credential_enc: string; status: string; rotated_at: Date }>('SELECT credential_enc, status, rotated_at FROM operators WHERE id=$1', [id]))[0];

    await deps.settings.set('daraja.environment', 'production');
    await expect(svc.rotate(id, { password: 'NewSecret#456' }, { personId: null as never, ip: '' }))
      .rejects.toMatchObject({ status: 409, code: 'wrong_environment' });

    const after = (await deps.db.query<{ credential_enc: string; status: string; rotated_at: Date }>('SELECT credential_enc, status, rotated_at FROM operators WHERE id=$1', [id]))[0];
    expect(after.credential_enc).toBe(before.credential_enc);
    expect(after.status).toBe(before.status);
    expect(after.rotated_at.getTime()).toBe(before.rotated_at.getTime());
    expect((await deps.db.query(`SELECT 1 FROM audit_log WHERE action='operator.rotated' AND target=$1`, [id])).length).toBe(0);
  });

  it('disable turns the operator off, invalidates the factory, publishes, and closes its pending probe timeout', async () => {
    const query = ackFor('OC-DIS');
    const invalidate = vi.fn();
    const publish = vi.fn(async () => {});
    const factory: DarajaFactory = { get: async () => ({ balance: { query } }) as never, invalidate, stkEnabled: async () => false };
    const evts: EventHub = { start: async () => {}, stop: async () => {}, publish, subscribe: () => () => {} };
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: factory, events: evts });
    const { id } = await svc.add('sandbox', { name: 'DIS', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    invalidate.mockClear();
    publish.mockClear();

    await svc.disable(id, { personId: null as never, ip: '9.9.9.9' });

    const op = (await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [id]))[0];
    expect(op.status).toBe('disabled');
    expect(invalidate).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('operator.updated', expect.objectContaining({ operatorId: id, status: 'disabled' }));
    const job = (await deps.db.query<{ done_at: Date | null }>(`SELECT done_at FROM jobs WHERE kind='operator_probe_timeout'`))[0];
    expect(job.done_at).not.toBeNull();
  });

  it('two probes in a row cancel the first request and close its timeout job', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-P1')), events });
    const { id } = await svc.add('sandbox', { name: 'TWOPROBE', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    const first = (await deps.db.query<{ id: string; status: string }>(`SELECT id, status FROM requests WHERE originator_conversation_id='OC-P1'`))[0];
    expect(first.status).toBe('sent');
    await deps.db.query(`UPDATE requests SET status='unknown' WHERE id=$1`, [first.id]);

    const svc2 = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-P2')), events });
    await svc2.probe(id);

    const firstAfter = (await deps.db.query<{ status: string }>('SELECT status FROM requests WHERE id=$1', [first.id]))[0];
    expect(firstAfter.status).toBe('cancelled');
    const firstJob = (await deps.db.query<{ done_at: Date | null }>(
      `SELECT done_at FROM jobs WHERE kind='operator_probe_timeout' AND payload->>'requestId'=$1`, [first.id]))[0];
    expect(firstJob.done_at).not.toBeNull();

    const second = (await deps.db.query<{ status: string }>(`SELECT status FROM requests WHERE originator_conversation_id='OC-P2'`))[0];
    expect(second.status).toBe('sent');
  });

  it('drops an SDK acknowledgement from the credential generation rotated while it was in flight', async () => {
    const initial = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-BASE')), events });
    const { id } = await initial.add('sandbox', { name: 'INFLIGHT-ROTATE', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });

    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let resolveStale!: (value: unknown) => void;
    const staleReply = new Promise<unknown>((resolve) => { resolveStale = resolve; });
    const staleSvc = createOperatorService({
      ...deps, secretKey: deps.config.secretKey,
      daraja: fakeFactory(async () => { started(); return staleReply; }), events,
    });
    const inFlight = staleSvc.probe(id);
    await startedPromise;

    const rotating = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-ROTATED')), events });
    await rotating.rotate(id, { password: 'NewSecret#456' }, { personId: null as never, ip: '' });
    resolveStale({ originatorConversationId: 'OC-STALE', conversationId: 'AG-STALE' });
    await inFlight;

    expect(await deps.db.query(`SELECT 1 FROM requests WHERE originator_conversation_id='OC-STALE'`)).toEqual([]);
    expect(await deps.db.query(`SELECT 1 FROM requests WHERE originator_conversation_id='OC-ROTATED'`)).toHaveLength(1);
  });

  it('an old invocation paused before cancellation leaves the rotated probe and its job live', async () => {
    const initial = createOperatorService({ ...deps, daraja: fakeFactory(ackFor('OC-BEFORE')), events });
    const { id } = await initial.add('sandbox', { name: 'PAUSED-ROTATE', credential: pastedCredential }, { personId: null, ip: '' });
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    let resume!: () => void;
    const released = new Promise<void>((resolve) => { resume = resolve; });
    const query = ackFor('OC-OLD-INVOCATION');
    const stale = createOperatorService({
      ...deps, events, daraja: fakeFactory(query),
      settings: { ...deps.settings, get: async (key) => {
        if (key === 'public.url') { reached(); await released; }
        return deps.settings.get(key);
      } },
    });
    const inFlight = stale.probe(id);
    await paused;
    try {
      const rotating = createOperatorService({ ...deps, daraja: fakeFactory(ackFor('OC-REPLACEMENT')), events });
      await rotating.rotate(id, { credential: pastedCredential }, { personId: null, ip: '' });
    } finally { resume(); }
    await inFlight;
    expect(query).not.toHaveBeenCalled();
    expect(await deps.db.query(`SELECT status FROM requests WHERE originator_conversation_id='OC-REPLACEMENT'`))
      .toEqual([{ status: 'sent' }]);
    expect(await deps.db.query(`SELECT j.done_at FROM jobs j JOIN requests r ON r.id::text=j.payload->>'requestId'
      WHERE r.originator_conversation_id='OC-REPLACEMENT'`)).toEqual([{ done_at: null }]);
  });

  it('keeps a disabled operator disabled when an in-flight SDK request rejects', async () => {
    const initial = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-BASE-FAIL')), events });
    const { id } = await initial.add('sandbox', { name: 'INFLIGHT-DISABLE', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });

    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let rejectStale!: (reason: unknown) => void;
    const staleReply = new Promise<never>((_resolve, reject) => { rejectStale = reject; });
    const staleSvc = createOperatorService({
      ...deps, secretKey: deps.config.secretKey,
      daraja: fakeFactory(async () => { started(); return staleReply; }), events,
    });
    const inFlight = staleSvc.probe(id);
    await startedPromise;
    await staleSvc.disable(id, { personId: null as never, ip: '' });
    rejectStale(new Error('late SDK rejection'));
    await inFlight;

    expect((await deps.db.query<{ status: string }>('SELECT status FROM operators WHERE id=$1', [id]))[0].status).toBe('disabled');
  });

  // --- Per-environment operators ---

  it('list(env) only returns that environment\'s operators', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-SB')), events });
    await svc.add('sandbox', { name: 'SANDBOXER', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    await svc.add('production', { name: 'PRODDER', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });

    const sandboxList = await svc.list('sandbox');
    expect(sandboxList.map((o) => o.name)).toEqual(['SANDBOXER']);
    expect(sandboxList[0].environment).toBe('sandbox');
    const prodList = await svc.list('production');
    expect(prodList.map((o) => o.name)).toEqual(['PRODDER']);
    expect(prodList[0].environment).toBe('production');
  });

  it('probe on an operator whose environment is not the active mode 409s wrong_environment', async () => {
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-WE')), events });
    const { id } = await svc.add('sandbox', { name: 'WASACTIVE', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    // Switch the active mode away from the operator's own environment, then re-probe it.
    await deps.settings.set('daraja.environment', 'production');
    await expect(svc.probe(id)).rejects.toMatchObject({ status: 409, code: 'wrong_environment' });
  });

  // add() to an environment other than the currently active mode must not fail —
  // it just can't be tested yet (the onboarding auto-probe needs a client for the active mode).
  it('add() to a non-active environment skips the onboarding auto-probe and leaves the operator pending', async () => {
    // Active mode defaults to sandbox; the query fn would fail the assertion below if probe ran.
    const query = ackFor('OC-SKIP');
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(query), events });
    const { id } = await svc.add('production', { name: 'PRESTAGED', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    expect(query).not.toHaveBeenCalled();
    const op = (await deps.db.query<{ status: string; last_probe_at: Date | null }>('SELECT status, last_probe_at FROM operators WHERE id=$1', [id]))[0];
    expect(op.status).toBe('pending');
    expect(op.last_probe_at).toBeNull();
    expect((await deps.db.query(`SELECT 1 FROM requests WHERE operator_id=$1`, [id]))).toHaveLength(0);

    // Switching to that operator's environment and probing it explicitly still works.
    await deps.settings.set('daraja.environment', 'production');
    await svc.probe(id);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('add persists the certificate into the given environment\'s own slot, not the other one', async () => {
    await deps.settings.set('daraja.environment', 'production');
    const svc = createOperatorService({ ...deps, secretKey: deps.config.secretKey, daraja: fakeFactory(ackFor('OC-CERTENV')), events });
    await svc.add('production', { name: 'CERTPROD', password: 'Secret#123', certPem }, { personId: null as never, ip: '' });
    expect(await deps.settings.get('env.production.certPem')).toContain('BEGIN PUBLIC KEY');
    expect(await deps.settings.get('env.sandbox.certPem')).toBeNull();
  });
});
