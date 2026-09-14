import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { withOrg, withSystem } from '../src/db/pool.js';
import { makeApp, resetTables, TEST_ORG_ID, TEST_SECRET } from './helpers.js';

describe('operator callback source policy', () => {
  const hosted = makeApp();
  beforeEach(async () => {
    await resetTables();
    await withSystem(() => hosted.deps.db.query('DELETE FROM org_environment_verifications'));
  });
  afterAll(async () => { await hosted.close(); });

  async function probe(environment: 'sandbox' | 'production', selected: 'sandbox' | 'production') {
    return withOrg(TEST_ORG_ID, async () => {
      await hosted.deps.settings.set('daraja.environment', selected);
      const [operator] = await hosted.deps.db.query<{ id: string }>(
        `INSERT INTO operators (name, environment, credential_enc, status)
         VALUES ('Source policy ' || gen_random_uuid()::text, $1, 'v1:ciphertext', 'pending') RETURNING id`, [environment],
      );
      const [pending] = await hosted.deps.db.query<{ id: string }>(
        `INSERT INTO requests (type, subtype, status, operator_id, originator_conversation_id, conversation_id)
         VALUES ('balance', 'operator_probe', 'sent', $1, $2, $3) RETURNING id`,
        [operator.id, `origin-${operator.id}`, `conversation-${operator.id}`],
      );
      return { operatorId: operator.id, requestId: pending.id };
    });
  }

  function deliver(operatorId: string, ip: string) {
    return request(hosted.app).post(`/cb/${TEST_SECRET}/balance`).set('X-Forwarded-For', ip).send({
      Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'Accepted',
        OriginatorConversationID: `origin-${operatorId}`, ConversationID: `conversation-${operatorId}`,
        TransactionID: 'source-policy' },
    }).expect(200);
  }

  it('keeps Production source checks after switching to Sandbox and accepts a later allowed callback', async () => {
    const pending = await probe('production', 'sandbox');
    await deliver(pending.operatorId, '1.2.3.4');
    await withOrg(TEST_ORG_ID, async () => {
      expect(await hosted.deps.db.query('SELECT verdict FROM callbacks_raw')).toEqual([{ verdict: 'off_range' }]);
      expect(await hosted.deps.db.query('SELECT status FROM requests WHERE id=$1', [pending.requestId])).toEqual([{ status: 'sent' }]);
      expect(await hosted.deps.db.query('SELECT status FROM operators WHERE id=$1', [pending.operatorId])).toEqual([{ status: 'pending' }]);
      expect(await hosted.deps.db.query('SELECT * FROM balances')).toEqual([]);
      expect(await hosted.deps.db.query('SELECT * FROM org_environment_verifications')).toEqual([]);
    });
    await deliver(pending.operatorId, '196.201.214.200');
    await deliver(pending.operatorId, '1.2.3.4');
    await withOrg(TEST_ORG_ID, async () => {
      expect(await hosted.deps.db.query('SELECT environment FROM org_environment_verifications')).toEqual([{ environment: 'production' }]);
      expect(await hosted.deps.db.query('SELECT verdict FROM callbacks_raw ORDER BY received_at, id')).toHaveLength(3);
      expect(await hosted.deps.db.query("SELECT count(*)::int AS n FROM callbacks_raw WHERE verdict='off_range'")).toEqual([{ n: 2 }]);
      expect(await hosted.deps.db.query('SELECT count(*)::int AS n FROM balances')).toEqual([{ n: 1 }]);
    });
  });

  it('keeps Sandbox callback relaxation after switching to Production', async () => {
    const pending = await probe('sandbox', 'production');
    await deliver(pending.operatorId, '1.2.3.4');
    await withOrg(TEST_ORG_ID, async () => {
      expect(await hosted.deps.db.query('SELECT verdict FROM callbacks_raw')).toEqual([{ verdict: 'applied' }]);
      expect(await hosted.deps.db.query('SELECT environment FROM org_environment_verifications')).toEqual([{ environment: 'sandbox' }]);
    });
  });

  it('does not relax an ambiguous callback whose identifiers also match a Production probe', async () => {
    const sandbox = await probe('sandbox', 'sandbox');
    const production = await probe('production', 'sandbox');
    await request(hosted.app).post(`/cb/${TEST_SECRET}/balance`).set('X-Forwarded-For', '1.2.3.4').send({
      Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'Accepted',
        OriginatorConversationID: `origin-${sandbox.operatorId}`, ConversationID: `conversation-${production.operatorId}` },
    }).expect(200);
    await withOrg(TEST_ORG_ID, async () => {
      expect(await hosted.deps.db.query('SELECT verdict FROM callbacks_raw')).toEqual([{ verdict: 'off_range' }]);
      expect(await hosted.deps.db.query('SELECT * FROM org_environment_verifications')).toEqual([]);
      expect(await hosted.deps.db.query("SELECT count(*)::int AS n FROM requests WHERE status='sent'")).toEqual([{ n: 2 }]);
    });
  });

  it('preserves the first proof across concurrent callbacks, redelivery and another operator', async () => {
    const first = await probe('production', 'production');
    await Promise.all([deliver(first.operatorId, '196.201.214.200'), deliver(first.operatorId, '196.201.214.200')]);
    const readProof = () => withOrg(TEST_ORG_ID, () => hosted.deps.db.query('SELECT environment, verified_at::text FROM org_environment_verifications'));
    const original = await readProof();
    expect(original).toHaveLength(1);
    await deliver(first.operatorId, '196.201.214.200');
    const next = await probe('production', 'production');
    await deliver(next.operatorId, '196.201.214.200');
    expect(await readProof()).toEqual(original);
    await withOrg(TEST_ORG_ID, async () => {
      expect(await hosted.deps.db.query('SELECT count(*)::int AS n FROM balances')).toEqual([{ n: 2 }]);
    });
  });

  it.each(['disabled', 'rotated', 'cancelled', 'missing', 'failed'] as const)('does not create a proof for a %s probe', async (state) => {
    const pending = await probe('production', 'production');
    await withOrg(TEST_ORG_ID, async () => {
      if (state === 'disabled') await hosted.deps.db.query("UPDATE operators SET status='disabled' WHERE id=$1", [pending.operatorId]);
      if (state === 'rotated') await hosted.deps.db.query("UPDATE operators SET rotated_at=now() + interval '1 second' WHERE id=$1", [pending.operatorId]);
      if (state === 'cancelled') await hosted.deps.db.query("UPDATE requests SET status='cancelled' WHERE id=$1", [pending.requestId]);
      if (state === 'missing') await hosted.deps.db.query('UPDATE requests SET operator_id=NULL WHERE id=$1', [pending.requestId]);
    });
    await request(hosted.app).post(`/cb/${TEST_SECRET}/balance`).set('X-Forwarded-For', '196.201.214.200').send({
      Result: { ResultType: 0, ResultCode: state === 'failed' ? 1 : 0, ResultDesc: 'Result',
        OriginatorConversationID: `origin-${pending.operatorId}`, ConversationID: `conversation-${pending.operatorId}` },
    }).expect(200);
    expect(await withOrg(TEST_ORG_ID, () => hosted.deps.db.query('SELECT * FROM org_environment_verifications'))).toEqual([]);
  });
});
