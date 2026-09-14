import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { DarajaAPIError } from '@kepas/daraja-js';
import { withOrg, resetContextForTests } from '../src/db/pool.js';
import { explain, whitelistAdvice } from '../src/sdk/meaning.js';
import { createOperatorService } from '../src/operators/service.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { makeApp, makePerson, loginAs, resetTables, ensureTestOrg, TEST_ORG_ID } from './helpers.js';

const IPS = ['203.0.113.1'];
const REFUSED = 'You are not authorized to initiate this transaction';
const B2C_TODAY = 'On the Daraja portal, open the app whose key you saved and check that the B2C API is on it. If it is not, ask Safaricom API support to enable B2C for this shortcode, then try again.';

// Whether the whitelist line appears is gated purely on whether egress addresses are configured
// (sdk/meaning.ts), never on which product this is — a self-hoster who sets STUDIO_EGRESS_IPS
// gets exactly the same advice a hosted install always has.
const withIps = makeApp({ env: { STUDIO_EGRESS_IPS: IPS.join(',') } });
const noIps = makeApp();

afterAll(async () => {
  await withIps.close();
  await noIps.close();
  resetContextForTests();
});

beforeEach(async () => {
  await resetTables();
  await ensureTestOrg();
});

describe('explain()', () => {
  it('says nothing about a whitelist when there are no addresses to name', () => {
    const ex = explain('b2c', '403.002.1001', REFUSED);
    expect(ex.whatToDo).toBe(B2C_TODAY);
  });

  it('names the addresses to whitelist when they are configured', () => {
    const ex = explain('b2c', '403.002.1001', REFUSED, { egressIps: IPS });
    expect(ex.whatToDo).toBe(whitelistAdvice(IPS));
  });
});

describe('History', () => {
  /** A send Safaricom refused before it started, exactly as the synchronous path records one. */
  async function refusedSend(db: Parameters<typeof makePerson>[0], orgId: string): Promise<string> {
    const [row] = await withOrg(orgId, () =>
      db.query<{ id: string }>(
        `INSERT INTO requests(type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value,
                              result_at, result_code, result_desc, meaning, retriable, payload_json)
         VALUES ('b2c','phone',$1,'failed',1000,'phone','254700000000', now(), '403.002.1001', $2, $3, false, '{}'::jsonb)
         RETURNING id`,
        [`oc-${orgId}`, REFUSED, 'This Daraja app is not allowed to use Business to Customer (B2C) payments in this environment. Balance and lookups can still work while this is the case.'],
      ),
    );
    return row.id;
  }

  it('names the addresses to whitelist when configured', async () => {
    await makePerson(withIps.deps.db, TEST_ORG_ID, { username: 'owner', password: 'correct horse', displayName: 'Owner', isOwner: true, role: 'owner' });
    const withIpsId = await refusedSend(withIps.deps.db, TEST_ORG_ID);
    const w = await loginAs(withIps.app, 'owner', 'correct horse');
    const withIpsView = await request(withIps.app).get(`/api/requests/${withIpsId}`).set('Cookie', w.cookie).set('x-csrf-token', w.csrf);
    expect(withIpsView.status).toBe(200);
    expect(withIpsView.body.whatToDo).toBe(whitelistAdvice(IPS));
  });

  it('gives today\'s copy when none are configured', async () => {
    await makePerson(noIps.deps.db, TEST_ORG_ID, { username: 'owner', password: 'correct horse', displayName: 'Owner', isOwner: true, role: 'owner' });
    const noIpsId = await refusedSend(noIps.deps.db, TEST_ORG_ID);
    const s = await loginAs(noIps.app, 'owner', 'correct horse');
    const noIpsView = await request(noIps.app).get(`/api/requests/${noIpsId}`).set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
    expect(noIpsView.status).toBe(200);
    expect(noIpsView.body.whatToDo).toBe(B2C_TODAY);
  });

  it('says the same thing in the list as in the detail', async () => {
    await makePerson(withIps.deps.db, TEST_ORG_ID, { username: 'owner', password: 'correct horse', displayName: 'Owner', isOwner: true, role: 'owner' });
    await refusedSend(withIps.deps.db, TEST_ORG_ID);
    const w = await loginAs(withIps.app, 'owner', 'correct horse');
    const list = await request(withIps.app).get('/api/requests').set('Cookie', w.cookie).set('x-csrf-token', w.csrf);
    expect(list.status).toBe(200);
    expect(list.body.items[0].whatToDo).toBe(whitelistAdvice(IPS));
  });
});

describe('the whitelist line reaches every product surface, not just a stored row', () => {
  // A synchronous HTTP 403 straight from the gateway, exactly as isV3GatewayRefusal's own
  // fixtures build one (money-out.test.ts) — Safaricom's own errorCode, no ResultCode/ack.
  function refusalError(): DarajaAPIError {
    return Object.assign(new DarajaAPIError('rejected', { raw: { errorCode: '403.002.1001', errorMessage: REFUSED } }), { httpStatus: 403 });
  }
  const fakeClient = { balance: { query: async () => { throw refusalError(); } }, config: { initiator: 'KEPAS' } } as never;
  const refusalDaraja: DarajaFactory = {
    get: async () => fakeClient, getForOperator: async () => fakeClient, invalidate: () => {}, stkEnabled: async () => false,
  };
  const localWithIps = makeApp({ daraja: refusalDaraja, env: { STUDIO_EGRESS_IPS: IPS.join(',') } });
  const localNoIps = makeApp({ daraja: refusalDaraja });

  afterAll(async () => {
    await localWithIps.close();
    await localNoIps.close();
  });

  it('POST /api/balances/refresh shows the address to whitelist, when egress addresses are configured', async () => {
    await makePerson(localWithIps.deps.db, TEST_ORG_ID, { username: 'owner', password: 'correct horse', displayName: 'Owner', isOwner: true, role: 'owner' });
    await localWithIps.deps.settings.set('public.url', 'https://studio.example');
    await localWithIps.deps.settings.set('public.verifiedAt', new Date().toISOString());
    await localWithIps.deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS','x','verified')`);
    const w = await loginAs(localWithIps.app, 'owner', 'correct horse');
    const r = await request(localWithIps.app).post('/api/balances/refresh').set('Cookie', w.cookie).set('x-csrf-token', w.csrf).send({});
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('safaricom_rejected');
    expect(r.body.error.details.whatToDo).toBe(whitelistAdvice(IPS));
  });

  it('the same route gives today\'s copy with no address, when none are configured', async () => {
    await makePerson(localNoIps.deps.db, TEST_ORG_ID, { username: 'owner', password: 'correct horse', displayName: 'Owner', isOwner: true, role: 'owner' });
    await localNoIps.deps.settings.set('public.url', 'https://studio.example');
    await localNoIps.deps.settings.set('public.verifiedAt', new Date().toISOString());
    await localNoIps.deps.db.query(`INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS','x','verified')`);
    const s = await loginAs(localNoIps.app, 'owner', 'correct horse');
    const r = await request(localNoIps.app).post('/api/balances/refresh').set('Cookie', s.cookie).set('x-csrf-token', s.csrf).send({});
    expect(r.status).toBe(502);
    expect(r.body.error.details.whatToDo).toBe('If this keeps happening, contact Safaricom API support with the text above.');
  });

  it('an operator probe records the address in the operator\'s own last_error', async () => {
    await localWithIps.deps.settings.set('public.url', 'https://studio.example');
    const [op] = await localWithIps.deps.db.query<{ id: string }>(
      `INSERT INTO operators(name, credential_enc, status) VALUES ('KEPAS-P','x','pending') RETURNING id`,
    );
    const svc = createOperatorService({
      db: localWithIps.deps.db, settings: localWithIps.deps.settings, keyring: localWithIps.deps.keyring,
      daraja: refusalDaraja, events: localWithIps.deps.events, orgs: localWithIps.deps.orgs, config: localWithIps.deps.config,
    });
    await svc.probe(op.id);
    const [row] = await localWithIps.deps.db.query<{ last_error: string | null }>('SELECT last_error FROM operators WHERE id=$1', [op.id]);
    expect(row.last_error).toContain('203.0.113.1');
  });
});

describe('nothing else changed', () => {
  it('still explains a code the catalog knows', () => {
    expect(explain('stk', 1032, 'Request cancelled by user').whatToDo).toBe('The customer cancelled the prompt. Nothing was charged.');
  });
});
