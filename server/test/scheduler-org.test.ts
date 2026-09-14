import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createAdminPool, createPool, withOrg, withSystem, type Db } from '../src/db/pool.js';
import { enqueue, claim, ensureRecurring } from '../src/db/jobs.js';
import { createScheduler } from '../src/scheduler/loop.js';
import { forEachOrg, sweepHandler, dailyHandler } from '../src/scheduler/handlers.js';
import { createEventHub, type EventHub } from '../src/events/hub.js';
import { orgContext } from '../src/http/orgContext.js';
import { sseRoute } from '../src/events/sse.js';
import { hashPassword } from '../src/auth/password.js';
import { createSession, SESSION_COOKIE } from '../src/auth/sessions.js';
import { createSettings } from '../src/settings/store.js';
import { createOrgService } from '../src/orgs/service.js';
import { createMoneyOutService } from '../src/money_out/service.js';
import { createDbKeyring, encryptForOrg } from '../src/crypto/secrets.js';
import type { DarajaFactory } from '../src/sdk/client.js';
import { testDeps, resetTables, ensureTestOrg, deleteOrg, TEST_ORG_ID, TEST_KEY } from './helpers.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test';
const ORG_B = '00000000-0000-4000-8000-0000000000b8';
const admin: Db = createAdminPool(url);
const { db, config } = testDeps();

afterAll(async () => {
  await deleteOrg(ORG_B);
  await admin.end();
  await db.end();
});

beforeEach(async () => {
  await resetTables();
  await ensureTestOrg();
  await withSystem(() =>
    admin.query(
      `INSERT INTO orgs(id, slug, name, status, is_host, callback_secret_hash, callback_secret_enc, key_salt)
       VALUES ($1,'org-b8','Second organisation','verified',false,'hash-b8','unset',gen_random_bytes(32))
       ON CONFLICT (id) DO UPDATE SET status='verified'`,
      [ORG_B],
    ),
  );
});

describe('one-shot jobs', () => {
  it('carry the organisation that enqueued them and run inside it', async () => {
    const seen: (string | null)[] = [];
    await withOrg(ORG_B, () => enqueue(db, 'probe', { requestId: 'r1' }));
    const scheduler = createScheduler(db, {
      probe: async () => {
        const { currentOrgId } = await import('../src/db/pool.js');
        seen.push(currentOrgId());
      },
    });
    expect(await scheduler.tick()).toBe(1);
    expect(seen).toEqual([ORG_B]);

    const [job] = await db.query<{ payload: { orgId: string; requestId: string }; done_at: string | null }>(
      'SELECT payload, done_at FROM jobs',
    );
    expect(job.payload).toEqual({ requestId: 'r1', orgId: ORG_B });
    expect(job.done_at).not.toBeNull();
  });

  it('a job with no organisation and no pool fallback (hosted mode) fails once and is never retried', async () => {
    // Enqueue outside every context and with no fallback, and none appears later either — matching
    // a hosted pool, which never gets one (a fallback present at tick time is now
    // legitimately adopted in single mode, see 'legacy jobs' below, so the fallback must stay null
    // for the whole test, not just the enqueue, to still exercise the hosted-mode path).
    db.setFallbackOrg(null);
    try {
      await enqueue(db, 'probe', { requestId: 'r2' });
      let ran = 0;
      const scheduler = createScheduler(db, { probe: async () => { ran++; } });
      expect(await scheduler.tick()).toBe(1);
      expect(ran).toBe(0);
      const [job] = await db.query<{ error: string; done_at: string | null; attempts: number }>(
        'SELECT error, done_at, attempts FROM jobs',
      );
      expect(job.error).toBe('no_org');
      expect(job.done_at).not.toBeNull();
      expect(job.attempts).toBe(1);
      // And a second tick finds nothing left to do.
      expect(await scheduler.tick()).toBe(0);
      expect(await claim(db, 'w')).toBeNull();
    } finally {
      db.setFallbackOrg(TEST_ORG_ID);
    }
  });

  it('a malformed orgId (not a uuid) fails finally rather than burning retries or running unscoped', async () => {
    const [{ id }] = await db.query<{ id: string }>(
      `INSERT INTO jobs(kind, payload, run_at, max_attempts) VALUES ('probe', '{"orgId":"not-a-uuid"}'::jsonb, now(), 5) RETURNING id`,
    );
    let ran = 0;
    const scheduler = createScheduler(db, { probe: async () => { ran++; } });
    expect(await scheduler.tick()).toBe(1);
    expect(ran).toBe(0);
    const [job] = await db.query<{ error: string; done_at: string | null; attempts: number }>(
      'SELECT error, done_at, attempts FROM jobs WHERE id=$1', [id],
    );
    expect(job.error).toBe('no_org');
    expect(job.done_at).not.toBeNull();
    expect(job.attempts).toBe(1);
  });
});

describe('legacy jobs with no orgId stamp (pre-Task-8 rows)', () => {
  it('single mode adopts the job into the pool\'s own fallback organisation, logging the adoption once even across a retry', async () => {
    const single = createPool(url, { role: 'studio_app' });
    single.setFallbackOrg(TEST_ORG_ID);
    try {
      const [{ id }] = await db.query<{ id: string }>(
        `INSERT INTO jobs(kind, payload, run_at, max_attempts) VALUES ('probe', '{}'::jsonb, now(), 3) RETURNING id`,
      );
      const seen: (string | null)[] = [];
      let attempt = 0;
      const scheduler = createScheduler(single, {
        probe: async () => {
          const { currentOrgId } = await import('../src/db/pool.js');
          seen.push(currentOrgId());
          attempt++;
          if (attempt === 1) throw new Error('first attempt fails');
        },
      });
      const errors: string[] = [];
      const original = console.error;
      console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
      try {
        expect(await scheduler.tick()).toBe(1);
        await db.query('UPDATE jobs SET run_at = now() WHERE id=$1', [id]);
        expect(await scheduler.tick()).toBe(1);
      } finally {
        console.error = original;
      }
      expect(seen).toEqual([TEST_ORG_ID, TEST_ORG_ID]);
      expect(errors.filter((e) => e.includes(id)).length).toBe(1);
      const [job] = await db.query<{ done_at: string | null }>('SELECT done_at FROM jobs WHERE id=$1', [id]);
      expect(job.done_at).not.toBeNull();
    } finally {
      await single.end();
    }
  });

  it('hosted mode (no pool fallback) fails the job finally instead of adopting it', async () => {
    const hosted = createPool(url, { role: 'studio_app' });
    // No setFallbackOrg call: a hosted pool never gets one.
    try {
      const [{ id }] = await db.query<{ id: string }>(
        `INSERT INTO jobs(kind, payload, run_at, max_attempts) VALUES ('probe', '{}'::jsonb, now(), 5) RETURNING id`,
      );
      let ran = 0;
      const scheduler = createScheduler(hosted, { probe: async () => { ran++; } });
      expect(await scheduler.tick()).toBe(1);
      expect(ran).toBe(0);
      const [job] = await db.query<{ error: string; done_at: string | null }>('SELECT error, done_at FROM jobs WHERE id=$1', [id]);
      expect(job.error).toBe('no_org');
      expect(job.done_at).not.toBeNull();
    } finally {
      await hosted.end();
    }
  });
});

describe('recurring jobs', () => {
  it('walk every organisation that is not closed', async () => {
    const visited: string[] = [];
    await forEachOrg(db, async (org) => { visited.push(org.id); });
    expect(visited.sort()).toEqual([TEST_ORG_ID, ORG_B].sort());

    await withSystem(() => admin.query(`UPDATE orgs SET status='closed' WHERE id=$1`, [ORG_B]));
    const after: string[] = [];
    await forEachOrg(db, async (org) => { after.push(org.id); });
    expect(after).toEqual([TEST_ORG_ID]);
  });

  it('run each organisation inside its own context', async () => {
    const inside: (string | null)[] = [];
    const { currentOrgId } = await import('../src/db/pool.js');
    await forEachOrg(db, async () => { inside.push(currentOrgId()); });
    expect(inside.sort()).toEqual([TEST_ORG_ID, ORG_B].sort());
  });

  it('continue after one organisation throws, and stay recurring', async () => {
    const visited: string[] = [];
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
    try {
      await forEachOrg(db, async (org) => {
        visited.push(org.id);
        if (org.id === TEST_ORG_ID) throw new Error('deliberate');
      });
    } finally {
      console.error = original;
    }
    expect(visited.sort()).toEqual([TEST_ORG_ID, ORG_B].sort());
    expect(errors.join('\n')).toContain(TEST_ORG_ID);
    expect(errors.join('\n')).toContain('deliberate');

    // The scheduler re-arms a recurring job whose handler threw, and never marks it done.
    await ensureRecurring(db, 'walker', 30);
    await db.query(`UPDATE jobs SET run_at = now() WHERE kind='walker'`);
    const scheduler = createScheduler(db, { walker: async () => { throw new Error('boom'); } });
    expect(await scheduler.tick()).toBe(1);
    const [job] = await db.query<{ done_at: string | null; error: string }>(`SELECT done_at, error FROM jobs WHERE kind='walker'`);
    expect(job.done_at).toBeNull();
    expect(job.error).toBe('boom');
  });

  it('a sweep pass that throws for one organisation still finishes the walk and records the failure on the job', async () => {
    const visited: string[] = [];
    const fakeMoneyOut = {
      sweep: async () => {
        const { currentOrgId } = await import('../src/db/pool.js');
        const org = currentOrgId();
        visited.push(org as string);
        if (org === TEST_ORG_ID) throw new Error('sweep exploded');
      },
    };
    await ensureRecurring(db, 'money_out_sweep', 30);
    await db.query(`UPDATE jobs SET run_at = now() WHERE kind='money_out_sweep'`);
    const original = console.error;
    console.error = () => {};
    try {
      const scheduler = createScheduler(db, { money_out_sweep: sweepHandler({ db, moneyOut: fakeMoneyOut }) });
      expect(await scheduler.tick()).toBe(1);
    } finally {
      console.error = original;
    }
    expect(visited.sort()).toEqual([TEST_ORG_ID, ORG_B].sort());
    const [job] = await db.query<{ done_at: string | null; error: string | null }>(`SELECT done_at, error FROM jobs WHERE kind='money_out_sweep'`);
    expect(job.done_at).toBeNull();
    expect(job.error).toContain(TEST_ORG_ID);
  });

  // the sse.test.ts pattern, reused: a recurring handler's own publish() call must be stamped
  // with the organisation forEachOrg is currently inside, not broadcast system-wide, so a stream
  // connected to one organisation never sees another organisation's sweep alert.
  it('a sweep alert reaches only that organisation\'s stream, never another\'s', async () => {
    const [{ id: personId }] = await db.query<{ id: string }>(
      `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('sweep-sse','Sweep',$1,true) RETURNING id`,
      [await hashPassword('correct horse battery staple')],
    );
    // No withOrg wrapper: testDeps() sets TEST_ORG_ID as the fallback, so this person (and the
    // session below) belong to it.
    const session = await createSession(db, personId, '127.0.0.1', 'test');

    const hub = createEventHub(config.databaseUrl, db);
    await hub.start();
    const app = express();
    app.use(orgContext({ db }));
    app.use('/api/events', sseRoute(hub, db));
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { Cookie: `${SESSION_COOKIE}=${session.id}` },
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read(); // the ': connected' preamble

      const fakeMoneyOut = { sweep: async () => { await hub.publish('alert', { kind: 'request_unknown' }); } };
      await sweepHandler({ db, moneyOut: fakeMoneyOut })({}, {} as never);

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain(`"orgId":"${TEST_ORG_ID}"`);
      expect(text).not.toContain(ORG_B);
    } finally {
      controller.abort();
      await hub.stop();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

// I1: RLS keys every one of these tables on org_id = app_current_org(), but the admin pool (a
// superuser) bypasses row-level security entirely — the same connection the runtime pool will use
// until the role check lands — so the sweep's and daily job's own direct queries must carry an
// explicit org_id predicate rather than relying on RLS alone. These tests run every service through
// `admin`, never a role-bound pool, so a passing assertion here can only mean the predicate itself,
// not RLS, is what kept the organisations apart.
describe('explicit organisation predicates on direct queries (I1, RLS bypassed)', () => {
  it("the sweep polls each organisation's own due row, never another's, through the admin pool", async () => {
    const keyring = createDbKeyring(admin, Buffer.from(TEST_KEY, 'base64'));
    const settings = createSettings(admin, keyring);
    const orgs = createOrgService({ db: admin, keyring, master: Buffer.from(TEST_KEY, 'base64') });
    await withOrg(TEST_ORG_ID, () => settings.set('public.url', 'https://studio.example'));
    await withOrg(ORG_B, () => settings.set('public.url', 'https://studio.example'));
    // ORG_B's callback secret starts as the migration/test placeholder 'unset' — give it a real
    // one, the same way helpers.ts's ensureTestOrg does for organisation #1, so urls() can decrypt it.
    const orgBSecretEnc = await withOrg(ORG_B, () => encryptForOrg(keyring, 'sekret-b8'));
    await admin.query('UPDATE orgs SET callback_secret_enc=$2 WHERE id=$1', [ORG_B, orgBSecretEnc]);

    await admin.query(
      `INSERT INTO requests(org_id, type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, sent_at)
       VALUES ($1,'b2c','BusinessPayment','OC-A','sent',100,'phone','254700123456', now() - interval '3 minutes')`,
      [TEST_ORG_ID]);
    await admin.query(
      `INSERT INTO requests(org_id, type, subtype, originator_conversation_id, status, amount_cents, recipient_kind, recipient_value, sent_at)
       VALUES ($1,'b2c','BusinessPayment','OC-B','sent',100,'phone','254700123456', now() - interval '3 minutes')`,
      [ORG_B]);

    // Recorded per organisation in scope at the moment Daraja is called — the direct proof that the
    // sweep's own due-row SELECT, not RLS, is what kept each pass to its own row.
    const polledByOrg: Record<string, string[]> = {};
    const statusAck = vi.fn(async (input: { originatorConversationId: string }) => {
      const { currentOrgId } = await import('../src/db/pool.js');
      const org = currentOrgId() ?? 'NONE';
      (polledByOrg[org] ??= []).push(input.originatorConversationId);
      return { conversationId: `AG_${input.originatorConversationId}`, originatorConversationId: input.originatorConversationId, responseCode: '0', responseDescription: 'Accept the service request successfully.' };
    });
    const daraja: DarajaFactory = {
      get: async () => ({}) as never,
      getForOperator: async () => ({ status: { transaction: statusAck }, config: { initiator: 'KEPAS' } }) as never,
      invalidate: () => {},
      stkEnabled: async () => false,
    };
    const fakeEvents: EventHub = { async start() {}, async stop() {}, async publish() {}, subscribe: () => () => {} };
    const moneyOut = createMoneyOutService({ db: admin, settings, daraja, events: fakeEvents, config, orgs });

    await sweepHandler({ db: admin, moneyOut })({}, {} as never);

    expect(polledByOrg[TEST_ORG_ID]).toEqual(['OC-A']);
    expect(polledByOrg[ORG_B]).toEqual(['OC-B']);
  });

  it("the daily pass never sees another organisation's operators, through the admin pool", async () => {
    // Only organisation B gets an operator whose password is about to expire. If the operators scan
    // or the "already alerted today" dedup probe ran unscoped, organisation #1's own pass (which
    // runs first — it was created before B) would see it, alert on it under the wrong organisation,
    // and its audit_log row would then suppress B's own real alert.
    const [{ id: opBId }] = await admin.query<{ id: string }>(
      `INSERT INTO operators(org_id, name, credential_enc, status, rotated_at) VALUES
         ($1,'OP-B','ciphertext','verified', ((now() AT TIME ZONE 'Africa/Nairobi')::date - 83)::timestamp AT TIME ZONE 'Africa/Nairobi') RETURNING id`,
      [ORG_B]);

    const seen: { operatorId: string }[] = [];
    const fakeEvents: EventHub = {
      async start() {}, async stop() {},
      async publish(type, payload) { if (type === 'alert') seen.push(payload as { operatorId: string }); },
      subscribe: () => () => {},
    };
    const keyring = createDbKeyring(admin, Buffer.from(TEST_KEY, 'base64'));
    const daily = dailyHandler({
      db: admin,
      settings: createSettings(admin, keyring),
      events: fakeEvents,
      // public.verifiedAt is never set for either organisation, so forOneOrg returns right after
      // the operators loop — refreshBalance must never be reached.
      moneyOut: { refreshBalance: async () => { throw new Error('must not be called'); } },
    });
    await daily({}, { id: 'j', kind: 'daily', payload: {}, attempts: 1, max_attempts: 1, recurring: true });

    expect(seen.map((p) => p.operatorId)).toEqual([opBId]);
    // Scoped to this test's own operator (target=opBId), not just the action, because audit_log is
    // never truncated between test files (it is append-only by design) and other files' own
    // operators legitimately alert under this same action.
    const rowsForA = await admin.query(`SELECT 1 FROM audit_log WHERE org_id=$1 AND action='operator_password_expiring' AND target=$2`, [TEST_ORG_ID, opBId]);
    expect(rowsForA.length).toBe(0);
    const rowsForB = await admin.query(`SELECT 1 FROM audit_log WHERE org_id=$1 AND action='operator_password_expiring' AND target=$2`, [ORG_B, opBId]);
    expect(rowsForB.length).toBe(1);
  });
});
