import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { withOrg, withSystem, createAdminPool } from '../src/db/pool.js';
import { deleteOrg, makeApp, resetTables, TEST_ORG_ID, TEST_SECRET } from './helpers.js';

const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000003c0';

describe('operator environment verification proofs', () => {
  const hosted = makeApp();
  // Only for the one test below that replays a migration file's own GRANT/ALTER statements —
  // those need a real superuser connection, which the studio_app-role pool never is.
  const admin = createAdminPool(hosted.deps.config.databaseUrl);

  beforeEach(async () => {
    vi.restoreAllMocks();
    await withSystem(() => hosted.deps.db.query('DELETE FROM org_environment_verifications'));
    await deleteOrg(OTHER_ORG_ID);
    await resetTables();
  });

  afterAll(async () => {
    await deleteOrg(OTHER_ORG_ID);
    await hosted.close();
    await admin.end();
  });

  it('records the successful operator environment even when the selected mode differs', async () => {
    await withOrg(TEST_ORG_ID, () =>
      hosted.deps.db.tx(async (c) => {
        await c.query(
          `INSERT INTO settings (org_id, key, value)
          VALUES (app_current_org(), 'daraja.environment', 'production')
           ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value`,
        );
        await c.query(
          `INSERT INTO settings (org_id, key, value)
           VALUES (app_current_org(), 'callbacks.allowlist', '127.0.0.1')
           ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value`,
        );
        const { rows: operators } = await c.query<{ id: string }>(
          `INSERT INTO operators (org_id, name, environment, credential_enc, status)
           VALUES (app_current_org(), 'Sandbox proof', 'sandbox', 'v1:ciphertext', 'pending')
           RETURNING id`,
        );
        const { rows: requests } = await c.query<{ id: string }>(
          `INSERT INTO requests
             (org_id, type, subtype, status, operator_id, originator_conversation_id, conversation_id, payload_json)
           VALUES
             (app_current_org(), 'balance', 'operator_probe', 'sent', $1, 'proof-originator', 'proof-conversation', '{}')
           RETURNING id`,
          [operators[0].id],
        );
        return { operatorId: operators[0].id, requestId: requests[0].id };
      }),
    );

    await request(hosted.app)
      .post(`/cb/${TEST_SECRET}/balance`)
      .set('X-Forwarded-For', '127.0.0.1')
      .send({
        Result: {
          ResultType: 0,
          ResultCode: 0,
          ResultDesc: 'Accepted',
          OriginatorConversationID: 'proof-originator',
          ConversationID: 'proof-conversation',
          TransactionID: 'proof-transaction',
        },
      })
      .expect(200);

    const proofs = await withOrg(TEST_ORG_ID, () =>
      hosted.deps.db.query<{ environment: string }>(
        `SELECT environment FROM org_environment_verifications WHERE org_id = app_current_org()`,
      ),
    );
    expect(proofs).toEqual([{ environment: 'sandbox' }]);

    await request(hosted.app)
      .post(`/cb/${TEST_SECRET}/balance`)
      .set('X-Forwarded-For', '127.0.0.1')
      .send({ Result: {
        ResultType: 0, ResultCode: 0, ResultDesc: 'Accepted', OriginatorConversationID: 'proof-originator',
        ConversationID: 'proof-conversation', TransactionID: 'proof-transaction',
      } })
      .expect(200);
    expect(await withOrg(TEST_ORG_ID, () => hosted.deps.db.query(
      `SELECT environment FROM org_environment_verifications WHERE org_id=app_current_org()`,
    ))).toEqual([{ environment: 'sandbox' }]);
  });

  it('records both environments after selected-mode switches for an already verified organisation', async () => {
    await withOrg(TEST_ORG_ID, () => hosted.deps.db.tx(async (c) => {
      await c.query(`INSERT INTO settings (org_id, key, value) VALUES (app_current_org(), 'daraja.environment', 'sandbox')
        ON CONFLICT (org_id, key) DO UPDATE SET value=EXCLUDED.value`);
      await c.query(`INSERT INTO settings (org_id, key, value) VALUES (app_current_org(), 'callbacks.allowlist', '127.0.0.1')
        ON CONFLICT (org_id, key) DO UPDATE SET value=EXCLUDED.value`);
      for (const [name, environment, originator, conversation] of [
        ['Production proof', 'production', 'prod-originator', 'prod-conversation'],
        ['Sandbox proof', 'sandbox', 'sandbox-originator', 'sandbox-conversation'],
      ] as const) {
        const { rows: operators } = await c.query<{ id: string }>(
          `INSERT INTO operators (org_id, name, environment, credential_enc, status)
           VALUES (app_current_org(), $1, $2, 'v1:ciphertext', 'pending') RETURNING id`, [name, environment],
        );
        await c.query(
          `INSERT INTO requests (org_id, type, subtype, status, operator_id, originator_conversation_id, conversation_id, payload_json)
           VALUES (app_current_org(), 'balance', 'operator_probe', 'sent', $1, $2, $3, '{}')`,
          [operators[0].id, originator, conversation],
        );
      }
    }));

    await request(hosted.app).post(`/cb/${TEST_SECRET}/balance`).set('X-Forwarded-For', '127.0.0.1').send({ Result: {
      ResultType: 0, ResultCode: 0, ResultDesc: 'Accepted', OriginatorConversationID: 'prod-originator',
      ConversationID: 'prod-conversation', TransactionID: 'prod-transaction',
    } }).expect(200);

    await withOrg(TEST_ORG_ID, () => hosted.deps.db.query(
      `UPDATE settings SET value='production' WHERE org_id=app_current_org() AND key='daraja.environment'`,
    ));
    await request(hosted.app).post(`/cb/${TEST_SECRET}/balance`).set('X-Forwarded-For', '127.0.0.1').send({ Result: {
      ResultType: 0, ResultCode: 0, ResultDesc: 'Accepted', OriginatorConversationID: 'sandbox-originator',
      ConversationID: 'sandbox-conversation', TransactionID: 'sandbox-transaction',
    } }).expect(200);

    const proofs = await withOrg(TEST_ORG_ID, () => hosted.deps.db.query<{ environment: string }>(
      `SELECT environment FROM org_environment_verifications WHERE org_id=app_current_org() ORDER BY environment`,
    ));
    expect(proofs).toEqual([{ environment: 'production' }, { environment: 'sandbox' }]);
  });

  it('allows a non-superseded timed-out probe, but never proves disabled or rotated credentials', async () => {
    await withOrg(TEST_ORG_ID, () => hosted.deps.db.tx(async (c) => {
      const add = async (name: string, status: string, requestStatus: string, originator: string, generation?: string) => {
        const { rows: operators } = await c.query<{ id: string }>(
          `INSERT INTO operators (org_id, name, environment, credential_enc, status, rotated_at)
           VALUES (app_current_org(), $1, 'sandbox', 'v1:ciphertext', $2, now() - interval '1 hour') RETURNING id`, [name, status],
        );
        await c.query(
          `INSERT INTO requests (org_id, type, subtype, status, operator_id, originator_conversation_id, conversation_id, sent_at, payload_json)
           VALUES (app_current_org(), 'balance', 'operator_probe', $1, $2, $3, $4, now(), $5::jsonb)`,
          [requestStatus, operators[0].id, originator, `${originator}-conversation`, JSON.stringify(generation ? { operatorRotatedAt: generation } : {})],
        );
        return operators[0].id;
      };
      await add('Late unknown', 'pending', 'unknown', 'late');
      await add('Disabled', 'disabled', 'sent', 'disabled');
      const rotated = await add('Rotated', 'pending', 'sent', 'rotated', '2000-01-01 00:00:00+00');
      await c.query(`UPDATE operators SET rotated_at=now() WHERE id=$1`, [rotated]);
    }));

    const publish = vi.spyOn(hosted.deps.events, 'publish');
    for (const originator of ['late', 'disabled', 'rotated']) {
      await request(hosted.app).post(`/cb/${TEST_SECRET}/balance`).send({ Result: {
        ResultType: 0, ResultCode: 0, ResultDesc: 'Accepted', OriginatorConversationID: originator,
        ConversationID: `${originator}-conversation`, TransactionID: `${originator}-transaction`,
      } }).expect(200);
    }

    const proofs = await withOrg(TEST_ORG_ID, () => hosted.deps.db.query<{ environment: string }>(
      `SELECT environment FROM org_environment_verifications WHERE org_id=app_current_org()`,
    ));
    expect(proofs).toEqual([{ environment: 'sandbox' }]);
    expect(await withOrg(TEST_ORG_ID, () => hosted.deps.db.query('SELECT 1 FROM balances'))).toHaveLength(1);
    expect(publish.mock.calls.filter(([name]) => name === 'balance.updated')).toHaveLength(1);
    expect(publish.mock.calls.filter(([name]) => name === 'request.updated')).toHaveLength(1);
    expect(await withOrg(TEST_ORG_ID, () => hosted.deps.db.query(
      `SELECT originator_conversation_id, status FROM requests ORDER BY originator_conversation_id`,
    ))).toEqual([
      { originator_conversation_id: 'disabled', status: 'cancelled' },
      { originator_conversation_id: 'late', status: 'completed' },
      { originator_conversation_id: 'rotated', status: 'cancelled' },
    ]);
    const statuses = await withOrg(TEST_ORG_ID, () => hosted.deps.db.query<{ name: string; status: string }>(
      `SELECT name, status FROM operators WHERE name IN ('Late unknown', 'Disabled', 'Rotated') ORDER BY name`,
    ));
    expect(statuses).toEqual([
      { name: 'Disabled', status: 'disabled' },
      { name: 'Late unknown', status: 'verified' },
      { name: 'Rotated', status: 'pending' },
    ]);
  });

  it('backfills the earliest verified proof per environment and preserves it on migration rerun', async () => {
    await withSystem(() => hosted.deps.db.tx(async (c) => {
      await c.query('DELETE FROM org_environment_verifications');
      await c.query(`INSERT INTO operators(org_id, name, environment, credential_enc, status, last_probe_at) VALUES
        ($1, 'Sandbox later', 'sandbox', 'v1:ciphertext', 'verified', '2025-02-01T00:00:00Z'),
        ($1, 'Sandbox first', 'sandbox', 'v1:ciphertext', 'verified', '2024-01-01T00:00:00Z'),
        ($1, 'Production first', 'production', 'v1:ciphertext', 'verified', '2023-03-01T00:00:00Z'),
        ($1, 'Failed ignored', 'production', 'v1:ciphertext', 'failed', '2020-01-01T00:00:00Z'),
        ($1, 'No probe ignored', 'sandbox', 'v1:ciphertext', 'verified', NULL)`, [TEST_ORG_ID]);
    }));
    const migration = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations/011_operator_verifications.sql'), 'utf8');
    await admin.tx((c) => c.query(migration));
    const first = await withSystem(() => hosted.deps.db.query<{ environment: string; verified_at: string }>(
      `SELECT environment, verified_at::date::text AS verified_at
       FROM org_environment_verifications WHERE org_id=$1 ORDER BY environment`, [TEST_ORG_ID],
    ));
    expect(first).toEqual([
      { environment: 'production', verified_at: '2023-03-01' },
      { environment: 'sandbox', verified_at: '2024-01-01' },
    ]);
    await admin.tx((c) => c.query(migration));
    expect(await withSystem(() => hosted.deps.db.query(
      `SELECT environment, verified_at::date::text AS verified_at
       FROM org_environment_verifications WHERE org_id=$1 ORDER BY environment`, [TEST_ORG_ID],
    ))).toEqual(first);
  });

  it('forces tenant reads and writes while allowing system backfill access', async () => {
    await withSystem(() => hosted.deps.db.tx(async (c) => {
      await c.query(
        `INSERT INTO orgs(id, slug, name, status, callback_secret_hash, callback_secret_enc, key_salt)
         VALUES ($1, 'proof-other', 'Proof other', 'verified', 'hash', 'enc', gen_random_bytes(32))`,
        [OTHER_ORG_ID],
      );
      await c.query(`INSERT INTO org_environment_verifications(org_id, environment, verified_at) VALUES
        ($1, 'sandbox', now()), ($2, 'production', now())`, [TEST_ORG_ID, OTHER_ORG_ID]);
    }));

    await expect(withOrg(TEST_ORG_ID, () => hosted.deps.db.query(
      `INSERT INTO org_environment_verifications(org_id, environment, verified_at) VALUES ($1, 'sandbox', now())`, [OTHER_ORG_ID],
    ))).rejects.toMatchObject({ code: '42501' });
    expect(await withOrg(TEST_ORG_ID, () => hosted.deps.db.query(
      `UPDATE org_environment_verifications SET verified_at=now() WHERE org_id=app_current_org() RETURNING org_id`,
    ))).toEqual([]);
    expect(await withOrg(TEST_ORG_ID, () => hosted.deps.db.query(
      `DELETE FROM org_environment_verifications WHERE org_id=app_current_org() RETURNING org_id`,
    ))).toEqual([]);

    const mine = await withOrg(TEST_ORG_ID, () => hosted.deps.db.query<{ environment: string }>(
      `SELECT environment FROM org_environment_verifications WHERE org_id IN (app_current_org(), $1)`, [OTHER_ORG_ID],
    ));
    expect(mine).toEqual([{ environment: 'sandbox' }]);
    expect(await withSystem(() => hosted.deps.db.query(`SELECT 1 FROM org_environment_verifications`))).toHaveLength(2);
  });
});
