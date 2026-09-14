import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createAdminPool, withOrg, withSystem, type Db } from '../src/db/pool.js';
import { createEventHub } from '../src/events/hub.js';
import { callbackRoutes } from '../src/callbacks/router.js';
import type { OrgService } from '../src/orgs/service.js';
import { encryptForOrg, sha256 } from '../src/crypto/secrets.js';
import { makeApp, resetTables, ensureTestOrg, deleteOrg, TEST_ORG_ID, TEST_SECRET } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const ORG_B = '00000000-0000-4000-8000-0000000000b7';
const SECRET_B = 'second-organisation-secret';
const admin: Db = createAdminPool(url);
const { app, deps, close } = makeApp();

afterAll(async () => {
  await deleteOrg(ORG_B);
  await admin.end();
  await close();
});

beforeEach(async () => {
  await resetTables();
  await ensureTestOrg();
  await withSystem(() =>
    admin.query(
      `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ($1,'org-b7','Second organisation','verified',false,$2,'unset',gen_random_bytes(32))
       ON CONFLICT (id) DO UPDATE SET status='verified'`,
      [ORG_B, sha256(SECRET_B)],
    ),
  );
  const enc = await withOrg(ORG_B, () => encryptForOrg(deps.keyring, SECRET_B));
  await withSystem(() => admin.query('UPDATE orgs SET callback_secret_enc=$2 WHERE id=$1', [ORG_B, enc]));
});

const body = { Result: { ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: 'oc-x', ConversationID: 'c-x' } };

describe('callbacks resolve their organisation from the secret', () => {
  it('stores a callback against the organisation whose secret was used', async () => {
    const r = await request(app).post(`/cb/${SECRET_B}/b2c`).send(body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });

    const mine = await withOrg(ORG_B, () => deps.db.query<{ path: string }>('SELECT path FROM callbacks_raw'));
    expect(mine).toEqual([{ path: 'b2c' }]);
    const other = await withOrg(TEST_ORG_ID, () => deps.db.query('SELECT path FROM callbacks_raw'));
    expect(other).toEqual([]);
  });

  it('404s an unknown secret and stores nothing', async () => {
    const r = await request(app).post('/cb/not-a-real-secret/b2c').send(body);
    expect(r.status).toBe(404);
    expect(await withSystem(() => deps.db.query('SELECT id FROM callbacks_raw'))).toEqual([]);
  });

  it('404s a closed organisation', async () => {
    await withSystem(() => admin.query(`UPDATE orgs SET status='closed' WHERE id=$1`, [ORG_B]));
    const r = await request(app).post(`/cb/${SECRET_B}/b2c`).send(body);
    expect(r.status).toBe(404);
    expect(await withSystem(() => deps.db.query('SELECT id FROM callbacks_raw'))).toEqual([]);
  });

  it('a suspended organisation still has its callbacks stored', async () => {
    await withSystem(() => admin.query(`UPDATE orgs SET status='suspended', suspend_reason='host' WHERE id=$1`, [ORG_B]));
    const r = await request(app).post(`/cb/${SECRET_B}/b2c`).send(body);
    expect(r.status).toBe(200);
    expect(await withOrg(ORG_B, () => deps.db.query('SELECT id FROM callbacks_raw'))).toHaveLength(1);
  });

  it('one organisation\'s secret cannot resolve another organisation\'s request', async () => {
    // Organisation #1 owns the request; the callback arrives on organisation B's address.
    await withOrg(TEST_ORG_ID, () =>
      deps.db.query(
        `INSERT INTO requests(type, originator_conversation_id, status, amount_cents, sent_at)
         VALUES ('b2c','oc-x','sent',1000, now())`,
      ),
    );
    await request(app).post(`/cb/${SECRET_B}/b2c`).send(body);

    const [mine] = await withOrg(TEST_ORG_ID, () => deps.db.query<{ status: string }>('SELECT status FROM requests'));
    expect(mine.status).toBe('sent'); // untouched
    const [rawRow] = await withOrg(ORG_B, () => deps.db.query<{ verdict: string }>('SELECT verdict FROM callbacks_raw'));
    expect(rawRow.verdict).toBe('unmatched');
  });

  it('a malformed body is still stored against the right organisation and still acked', async () => {
    const r = await request(app)
      .post(`/cb/${SECRET_B}/b2c`)
      .set('content-type', 'application/json')
      .send('{ not json');
    expect(r.status).toBe(200);
    const rows = await withOrg(ORG_B, () => deps.db.query<{ body_json: { error: string } }>('SELECT body_json FROM callbacks_raw'));
    expect(rows[0].body_json.error).toBe('body_parse_failed');
  });

  it('the organisation\'s own secret still builds today\'s callback URLs', async () => {
    expect(await deps.orgs.revealSecret(TEST_ORG_ID)).toBe(TEST_SECRET);
  });

  it('a failed organisation lookup answers 503 and logs once, never a 404 or a silent 200', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failingOrgs: OrgService = { ...deps.orgs, bySecretHash: async () => { throw new Error('db down'); } };
      const failingApp = express();
      failingApp.use(express.json());
      failingApp.use('/cb', callbackRoutes({ ...deps, orgs: failingOrgs, handlers: {} }));

      const r = await request(failingApp).post(`/cb/${SECRET_B}/b2c`).send(body);
      expect(r.status).toBe(503);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0]).toEqual(['callback lookup failed', 'b2c', 'db down']);
      expect(await withSystem(() => deps.db.query('SELECT id FROM callbacks_raw'))).toEqual([]);
    } finally {
      errorLog.mockRestore();
    }

    // Once the lookup itself works again, an unknown secret still 404s and a known one still 200s.
    const unknown = await request(app).post('/cb/not-a-real-secret/b2c').send(body);
    expect(unknown.status).toBe(404);
    const known = await request(app).post(`/cb/${SECRET_B}/b2c`).send(body);
    expect(known.status).toBe(200);
  });
});

describe('cross-organisation callback bodies are never matched to another organisation\'s rows', () => {
  it('status, b2c, b2c/timeout and balance bodies naming organisation #1\'s identifiers are stored under organisation B as unmatched, and organisation #1\'s rows are untouched', async () => {
    const B2C_OC = 'a1-b2c-oc';
    const BAL_OC = 'a1-balance-oc';
    const STATUS_OC = 'a1-status-oc';
    const STATUS_CONV = `AG_${STATUS_OC}`;

    await withOrg(TEST_ORG_ID, () =>
      deps.db.query(
        `INSERT INTO requests(type, originator_conversation_id, status, amount_cents, sent_at)
         VALUES ('b2c',$1,'sent',100,now())`,
        [B2C_OC],
      ),
    );
    await withOrg(TEST_ORG_ID, () =>
      deps.db.query(`INSERT INTO requests(type, originator_conversation_id, status, sent_at) VALUES ('balance',$1,'sent',now())`, [BAL_OC]),
    );
    await withOrg(TEST_ORG_ID, () =>
      deps.db.query(
        `INSERT INTO requests(type, subtype, originator_conversation_id, conversation_id, status, sent_at, payload_json)
         VALUES ('status_query','sweep',$1,$2,'sent',now(),'{}'::jsonb)`,
        [STATUS_OC, STATUS_CONV],
      ),
    );

    const statusBody = {
      Result: {
        ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: STATUS_OC, ConversationID: STATUS_CONV,
        ResultParameters: { ResultParameter: [{ Key: 'TransactionStatus', Value: 'Completed' }, { Key: 'Amount', Value: 1 }] },
      },
    };
    const b2cResultBody = {
      Result: {
        ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: B2C_OC, ConversationID: `AG_${B2C_OC}`,
        ResultParameters: { ResultParameter: [{ Key: 'TransactionReceipt', Value: 'RXX' }] },
      },
    };
    const b2cTimeoutResultBody = { Result: { ResultType: 1, ResultCode: 1, ResultDesc: 'timed out', OriginatorConversationID: B2C_OC, ConversationID: `AG_${B2C_OC}` } };
    const balanceResultBody = {
      Result: {
        ResultType: 0, ResultCode: 0, ResultDesc: 'ok', OriginatorConversationID: BAL_OC, ConversationID: `AG_${BAL_OC}`,
        ResultParameters: { ResultParameter: [{ Key: 'AccountBalance', Value: 'Working Account|KES|1.00|1.00|0.00|0.00' }] },
      },
    };

    const posts: [string, unknown][] = [
      ['status', statusBody],
      ['b2c', b2cResultBody],
      ['b2c/timeout', b2cTimeoutResultBody],
      ['balance', balanceResultBody],
    ];
    for (const [kind, payload] of posts) {
      const r = await request(app).post(`/cb/${SECRET_B}/${kind}`).send(payload);
      expect(r.status).toBe(200);
    }

    const raw = await withOrg(ORG_B, () => deps.db.query<{ path: string; verdict: string }>('SELECT path, verdict FROM callbacks_raw ORDER BY path'));
    expect(raw).toEqual([
      { path: 'b2c', verdict: 'unmatched' },
      { path: 'b2c/timeout', verdict: 'unmatched' },
      { path: 'balance', verdict: 'unmatched' },
      { path: 'status', verdict: 'unmatched' },
    ]);

    const [b2cRow] = await withOrg(TEST_ORG_ID, () => deps.db.query<{ status: string }>('SELECT status FROM requests WHERE originator_conversation_id=$1', [B2C_OC]));
    expect(b2cRow.status).toBe('sent');
    const [balRow] = await withOrg(TEST_ORG_ID, () => deps.db.query<{ status: string }>('SELECT status FROM requests WHERE originator_conversation_id=$1', [BAL_OC]));
    expect(balRow.status).toBe('sent');
    const [statusRow] = await withOrg(TEST_ORG_ID, () => deps.db.query<{ status: string }>('SELECT status FROM requests WHERE originator_conversation_id=$1', [STATUS_OC]));
    expect(statusRow.status).toBe('sent');
    expect(await withOrg(TEST_ORG_ID, () => deps.db.query('SELECT 1 FROM balances'))).toEqual([]);
  });
});

describe('per-organisation caching and events', () => {
  it('cache keys are namespaced by organisation', async () => {
    await withOrg(ORG_B, () => deps.cache.set('token:x', 'B', 60));
    await withOrg(TEST_ORG_ID, () => deps.cache.set('token:x', 'ONE', 60));
    expect(await withOrg(ORG_B, () => deps.cache.get<string>('token:x'))).toBe('B');
    expect(await withOrg(TEST_ORG_ID, () => deps.cache.get<string>('token:x'))).toBe('ONE');
    const keys = (await deps.db.query<{ key: string }>(`SELECT key FROM cache ORDER BY key`)).map((r) => r.key);
    expect(keys).toContain(`org:${ORG_B}:token:x`);
    expect(keys).toContain(`org:${TEST_ORG_ID}:token:x`);
  });

  it('a published event carries the organisation it came from', async () => {
    // makeApp() builds the hub but never start()s it, so deps.events has no LISTEN connection and
    // nothing it publishes ever comes back (pre-flight M6). Start one for this case exactly as
    // events.test.ts does, and wait on the delivery instead of on a timer.
    const hub = createEventHub(deps.config.databaseUrl, deps.db);
    await hub.start();
    try {
      const got = new Promise<{ type: string; orgId: string | null }>((resolve) =>
        hub.subscribe((e) => { if (e.type === 'request.updated') resolve({ type: e.type, orgId: e.orgId }); }),
      );
      await withOrg(ORG_B, () => hub.publish('request.updated', { id: 'x' }));
      expect(await got).toEqual({ type: 'request.updated', orgId: ORG_B });
    } finally {
      await hub.stop();
    }
  });
});
