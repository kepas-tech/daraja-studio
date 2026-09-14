import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { sseRoute } from '../src/events/sse.js';
import { createEventHub, type EventHub, type StudioEvent } from '../src/events/hub.js';
import { hashPassword } from '../src/auth/password.js';
import { createSession, SESSION_COOKIE } from '../src/auth/sessions.js';
import { orgContext } from '../src/http/orgContext.js';
import { withOrg } from '../src/db/pool.js';
import { testDeps, resetTables, TEST_ORG_ID } from './helpers.js';

const deps = testDeps();

describe('sse route', () => {
  it('sets sse headers, sends the connected preamble, and unsubscribes when the client goes away', async () => {
    await resetTables(deps.db);
    const [{ id: personId }] = await deps.db.query<{ id: string }>(
      `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('sse-user','SSE',$1,true) RETURNING id`,
      [await hashPassword('correct horse battery staple')],
    );
    const session = await createSession(deps.db, personId, '127.0.0.1', 'test');

    let unsubCalled = false;
    const fakeHub: EventHub = {
      async start() {},
      async stop() {},
      async publish() {},
      subscribe(_fn: (e: StudioEvent) => void) {
        return () => { unsubCalled = true; };
      },
    };

    const app = express();
    // requireAuth no longer looks up the session itself  — orgContext does that and puts
    // the request inside its organisation, so this standalone app needs it too, the way buildApp's does.
    app.use(orgContext({ db: deps.db }));
    app.use('/api/events', sseRoute(fakeHub, deps.db));
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { Cookie: `${SESSION_COOKIE}=${session.id}` },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(': connected\n\n');
    } finally {
      controller.abort();
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unsubCalled).toBe(true);
    } finally {
      // The aborted fetch's socket is only actually torn down by undici's own keep-alive timeout
      // (~4s), which server.close() would otherwise sit through waiting for — closing it here
      // first is what keeps this test's teardown fast instead of at the mercy of that timer. In a
      // finally so it still runs if the assertion above fails.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 20_000);

  it('delivers only the connected organisation\'s own events, never another organisation\'s', async () => {
    await resetTables(deps.db);
    const [{ id: personId }] = await deps.db.query<{ id: string }>(
      `INSERT INTO people(username, display_name, password_hash, is_owner) VALUES ('sse-user-2','SSE2',$1,true) RETURNING id`,
      [await hashPassword('correct horse battery staple')],
    );
    // No withOrg wrapper: testDeps() sets TEST_ORG_ID as the fallback, so this person (and the
    // session below) belong to it, matching the connection's own organisation.
    const session = await createSession(deps.db, personId, '127.0.0.1', 'test');
    // Never a real organisation — publish() carries no FK, and a filtering test needs no row for
    // the organisation the connection must NOT see.
    const OTHER_ORG = '00000000-0000-4000-8000-0000000000ee';

    const hub = createEventHub(deps.config.databaseUrl, deps.db);
    await hub.start();
    const app = express();
    app.use(orgContext({ db: deps.db }));
    app.use('/api/events', sseRoute(hub, deps.db));
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

      await withOrg(OTHER_ORG, () => hub.publish('alert', { kind: 'not-yours' }));
      await withOrg(TEST_ORG_ID, () => hub.publish('alert', { kind: 'yours' }));

      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('yours');
      expect(text).not.toContain('not-yours');
    } finally {
      controller.abort();
      await hub.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }, 20_000);
});
