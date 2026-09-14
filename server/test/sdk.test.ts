import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDeps, resetTables } from './helpers.js';
import { createDarajaFactory } from '../src/sdk/client.js';
import { oauthCheck } from '../src/sdk/oauthCheck.js';
import { callbackUrls } from '../src/sdk/callbackUrls.js';
import { explain } from '../src/sdk/meaning.js';
import { encrypt } from '../src/crypto/secrets.js';

const deps = testDeps();
afterAll(() => deps.db.end());

describe('sdk', () => {
  // Reset (not just seed once in beforeAll) so this file's tests don't depend on running right
  // after each other, or on no other file having left stray rows behind — required for order
  // independence under a shuffled file run (A11).
  beforeEach(async () => {
    await resetTables(deps.db);
    await deps.settings.set('env.sandbox.shortcode', '600999');
    await deps.settings.set('daraja.environment', 'sandbox');
    await deps.settings.set('env.sandbox.consumerKey', 'k');
    await deps.settings.set('env.sandbox.consumerSecret', 's');
    await deps.settings.set('env.sandbox.credsVerifiedAt', new Date().toISOString());
  });

  it('builds a tier-A client without passkey or operator, stk disabled', async () => {
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    const d = await f.get();
    expect(d.config.shortcode).toBe('600999');
    expect(d.config.environment).toBe('sandbox');
    expect(await f.stkEnabled()).toBe(false);
    expect(d.config.initiator).toBeUndefined();
  });

  it('attaches the highest-priority verified operator', async () => {
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('KEPAS',$1,'verified',1), ('APITWO',$2,'verified',2)`,
      [encrypt(deps.config.secretKey, 'cred-kepas'), encrypt(deps.config.secretKey, 'cred-two')]);
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    const d = await f.get();
    expect(d.config.initiator).toBe('KEPAS');
    expect(d.config.securityCredential).toBe('cred-kepas');
  });

  it('rebuilds the client when settings or the operator credential change, without calling invalidate()', async () => {
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('KEPAS',$1,'verified',1)`,
      [encrypt(deps.config.secretKey, 'cred-kepas')]);
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    const d1 = await f.get();
    expect(d1.config.environment).toBe('sandbox');

    await deps.settings.set('env.production.shortcode', '600999');
    await deps.settings.set('env.production.consumerKey', 'k');
    await deps.settings.set('env.production.consumerSecret', 's');
    await deps.settings.set('env.production.credsVerifiedAt', new Date().toISOString());
    await deps.settings.set('daraja.environment', 'production');
    const d2 = await f.get();
    expect(d2.config.environment).toBe('production');
    await deps.settings.set('daraja.environment', 'sandbox');

    await deps.db.query(`UPDATE operators SET credential_enc=$1 WHERE name='KEPAS'`,
      [encrypt(deps.config.secretKey, 'cred-kepas-rotated')]);
    const d3 = await f.get();
    expect(d3.config.securityCredential).toBe('cred-kepas-rotated');

    await deps.settings.set('env.sandbox.consumerSecret', 's2');
    const d4 = await f.get();
    expect(d4.config.consumerSecret).toBe('s2');
  });

  it('rejects a failed operator id, and allows a pending one on the probe path', async () => {
    const [failedOp] = await deps.db.query<{ id: string }>(
      `INSERT INTO operators(name, credential_enc, status, priority) VALUES ('BADOP',$1,'failed',50) RETURNING id`,
      [encrypt(deps.config.secretKey, 'cred-bad')],
    );
    const [pendingOp] = await deps.db.query<{ id: string }>(
      `INSERT INTO operators(name, credential_enc, status, priority) VALUES ('PENDOP',$1,'pending',60) RETURNING id`,
      [encrypt(deps.config.secretKey, 'cred-pending')],
    );
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    await expect(f.get(failedOp.id)).rejects.toMatchObject({ status: 409, code: 'operator_unavailable' });
    const d = await f.get(pendingOp.id);
    expect(d.config.initiator).toBe('PENDOP');
    expect(d.config.securityCredential).toBe('cred-pending');
  });

  // The explicit-operator-id path must not pair the active mode's creds/shortcode
  // with an operator belonging to a different environment.
  it('rejects an explicit operator id whose environment is not the active mode', async () => {
    const [prodOp] = await deps.db.query<{ id: string }>(
      `INSERT INTO operators(name, credential_enc, status, environment) VALUES ('PRODOP',$1,'verified','production') RETURNING id`,
      [encrypt(deps.config.secretKey, 'cred-prod')],
    );
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    // Mode defaults to sandbox (beforeEach) — the operator above is production.
    await expect(f.get(prodOp.id)).rejects.toMatchObject({ status: 409, code: 'wrong_environment' });
  });

  it('getForOperator() ignores a verified production operator while in sandbox mode', async () => {
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, environment) VALUES ('PRODOP',$1,'verified','production')`, [encrypt(deps.config.secretKey, 'cred-prod')]);
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    await expect(f.getForOperator()).rejects.toMatchObject({ status: 409, code: 'no_operator' });
  });

  it('tolerates a blank passkey but rejects an invalid environment', async () => {
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    await deps.settings.set('env.sandbox.passkey', '');
    expect(await f.stkEnabled()).toBe(false);
    await expect(f.get()).resolves.toBeDefined();

    await deps.settings.set('daraja.environment', 'staging');
    await expect(f.get()).rejects.toMatchObject({ status: 409, code: 'not_configured' });
  });

  it('refuses to build a client for a mode whose creds are not yet Safaricom-verified, and per-environment creds never leak into the other slot', async () => {
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    // Sandbox is ready (beforeEach). Switching to production, whose slot is still empty, must
    // fail naming production — the sandbox creds must never be reused there.
    await deps.settings.set('daraja.environment', 'production');
    await expect(f.get()).rejects.toMatchObject({ status: 409, code: 'not_configured' });

    // Production creds saved but not yet verified by Safaricom still refuse.
    await deps.settings.set('env.production.shortcode', '700111');
    await deps.settings.set('env.production.consumerKey', 'pk');
    await deps.settings.set('env.production.consumerSecret', 'ps');
    await expect(f.get()).rejects.toMatchObject({ status: 409, code: 'not_configured' });

    // Once Safaricom has accepted production's own pair, production works — and sandbox (whose
    // own slot never changed) still resolves independently when the mode switches back.
    await deps.settings.set('env.production.credsVerifiedAt', new Date().toISOString());
    const prodClient = await f.get();
    expect(prodClient.config.shortcode).toBe('700111');

    await deps.settings.set('daraja.environment', 'sandbox');
    const sandboxClient = await f.get();
    expect(sandboxClient.config.shortcode).toBe('600999');
  });

  it('oauthCheck reports ok and failure', async () => {
    const okFetch = (async () => new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 })) as typeof fetch;
    const badFetch = (async () => new Response('{"errorMessage":"Invalid Authentication passed"}', { status: 400 })) as typeof fetch;
    expect(await oauthCheck('sandbox', 'k', 's', okFetch)).toEqual({ ok: true, expiresIn: 3599 });
    const bad = await oauthCheck('sandbox', 'k', 's', badFetch);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.status).toBe(400);
      expect(bad.message.length).toBeGreaterThan(0);
    }
  });

  it('oauthCheck treats a non-JSON 200 and a tokenless 200 as failures', async () => {
    const nonJsonFetch = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    const noTokenFetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    expect((await oauthCheck('sandbox', 'k', 's', nonJsonFetch)).ok).toBe(false);
    expect((await oauthCheck('sandbox', 'k', 's', noTokenFetch)).ok).toBe(false);
  });

  it('oauthCheck sends an abort signal so a hung Safaricom call cannot wedge the request', async () => {
    let capturedInit: RequestInit | undefined;
    const capturingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ access_token: 't', expires_in: '3599' }), { status: 200 });
    }) as typeof fetch;
    await oauthCheck('sandbox', 'k', 's', capturingFetch);
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('callbackUrls builds every path', () => {
    const u = callbackUrls('https://x.example', 'abc');
    expect(u.balance).toBe('https://x.example/cb/abc/balance');
    expect(u.c2bConfirm).toBe('https://x.example/cb/abc/c2b/confirm');
    expect(u.selftest).toBe('https://x.example/cb/abc/selftest');
    expect(Object.keys(u).sort()).toEqual(
      ['b2b', 'b2c', 'b2cTimeout', 'balance', 'base', 'billManager', 'c2bConfirm', 'c2bValidate', 'express', 'pull', 'ratiba', 'reversal', 'selftest', 'status', 'stk'].sort(),
    );
    expect(callbackUrls('https://x.example/', 'abc').base).toBe('https://x.example/cb/abc');
  });

  it('explain passes Safaricom text through and never invents', () => {
    const e = explain('b2c', '999999', 'Weird thing');
    expect(e.safaricomSaid).toBe('Weird thing');
    expect(e.catalogued).toBe(false);
    expect(e.meaning).toMatch(/did not explain/);
  });

  it('explain gives scope-specific advice only for justified pairs, and a generic fallback otherwise', () => {
    expect(explain('stk', '1', 'x').whatToDo).toMatch(/top up/i);
    expect(explain('b2c', '1', 'x').whatToDo).toMatch(/float/i);
    expect(explain('bonga', '999999', 'x').whatToDo).toBe('If this keeps happening, contact Safaricom API support with the text above.');
  });

  it('explain reports the catalogued branch correctly', () => {
    const e = explain('stk', '1037', 'x');
    expect(e.catalogued).toBe(true);
    expect(e.retriable).toBe(true);
  });

  it('getForOperator throws no_operator when no verified operator exists, get() does not', async () => {
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    await expect(f.get()).resolves.toBeTruthy();
    await expect(f.getForOperator()).rejects.toMatchObject({ status: 409, code: 'no_operator' });
    await deps.db.query(`INSERT INTO operators(name, credential_enc, status, priority) VALUES ('KEPAS',$1,'pending',1)`, [encrypt(deps.config.secretKey, 'c')]);
    await expect(f.getForOperator()).rejects.toMatchObject({ code: 'no_operator' });
    await deps.db.query(`UPDATE operators SET status='verified'`);
    const d = await f.getForOperator();
    expect(d.config.initiator).toBe('KEPAS');
  });

  it('passes an injected fetchImpl into the Daraja client config', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey, fetchImpl });
    const d = await f.get();
    expect(d.config.fetchImpl).toBe(fetchImpl);
  });

  it('explain has what-to-do text for the initiator-credential codes on b2c', () => {
    const invalid = explain('b2c', 2001, 'The initiator information is invalid.');
    expect(invalid.whatToDo).toMatch(/operator/i);
    const locked = explain('b2c', 8006, 'The security credential is locked.');
    expect(locked.whatToDo).toMatch(/portal/i);
    expect(explain('status', 0, 'The service request is processed successfully.').safaricomSaid).toBe('The service request is processed successfully.');
  });

  // Addendum, observed live in production: a gateway rejection not in the SDK's own catalog —
  // the studio's own meaning fallback (not just WHAT_TO_DO) must cover it.
  it('explain covers the b2c 403.002.1001 gateway rejection (app not entitled to B2C) with its own meaning and what-to-do', () => {
    const e = explain('b2c', '403.002.1001', 'You are not authorized to initiate this transaction');
    expect(e.safaricomSaid).toBe('You are not authorized to initiate this transaction');
    expect(e.meaning).toBeTruthy();
    expect(e.whatToDo).toBeTruthy();
    expect(`${e.meaning} ${e.whatToDo}`).toContain('B2C');
  });

  it('explain covers the balance 2001 initiator-credential rejection (bad API operator) with its own meaning and what-to-do', () => {
    const e = explain('balance', '2001', 'The initiator information is invalid.');
    expect(e.safaricomSaid).toBe('The initiator information is invalid.');
    expect(e.meaning).toBeTruthy();
    expect(e.whatToDo).toBeTruthy();
    expect(`${e.meaning} ${e.whatToDo}`).toContain('operator');
  });

  it('SDK 1.5.0 surface: status by OriginatorConversationID, b2c v3 id, lifted status fields', async () => {
    const { parseStatusResult } = await import('@kepas/daraja-js');
    const r = parseStatusResult({ Result: { ResultCode: 0, ResultDesc: 'ok', ResultParameters: { ResultParameter: [{ Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'ReceiptNo', Value: 'RI1' }] } } });
    expect(r.transactionStatus).toBe('Completed');
    expect(r.receipt).toBe('RI1');
    const f = createDarajaFactory({ ...deps, secretKey: deps.config.secretKey });
    const d = await f.get();
    // Type-level: these compile only against 1.5.0. Runtime: no request is made (initiator missing → validation error).
    await expect(d.status.transaction({ originatorConversationId: 'x', resultUrl: 'https://s.example/r', queueTimeoutUrl: 'https://s.example/t' })).rejects.toThrow(/initiator/);
    await expect(d.b2c.send({ phone: '254700123456', amount: 1, originatorConversationId: 'x', resultUrl: 'https://s.example/r', queueTimeoutUrl: 'https://s.example/t' })).rejects.toThrow(/initiator/);
  });
});
