import { describe, it, expect, afterAll } from 'vitest';
import type { Client } from 'pg';
import { createEventHub, formatSse, nextBackoffMs } from '../src/events/hub.js';
import { testDeps, TEST_ORG_ID } from './helpers.js';

const deps = testDeps();
afterAll(() => deps.db.end());

describe('event hub', () => {
  it('delivers a published event to subscribers via postgres, stamped with the organisation in scope', async () => {
    const hub = createEventHub(deps.config.databaseUrl, deps.db);
    await hub.start();
    const got = new Promise<{ payload: unknown; orgId: string | null }>((resolve) =>
      hub.subscribe((e) => { if (e.type === 'ping') resolve({ payload: e.payload, orgId: e.orgId }); }),
    );
    // No withOrg wrapper: testDeps() sets the fallback organisation, and publish() defaults to it.
    await hub.publish('ping', { n: 1 });
    expect(await got).toEqual({ payload: { n: 1 }, orgId: TEST_ORG_ID });
    await hub.stop();
  });
  it('formats sse frames', () => {
    expect(formatSse({ type: 'x', payload: { a: 1 }, at: 't', orgId: null })).toBe('event: x\ndata: {"type":"x","payload":{"a":1},"at":"t","orgId":null}\n\n');
  });
  it('computes capped exponential reconnect backoff', () => {
    expect(nextBackoffMs(1)).toBe(1000);
    expect(nextBackoffMs(2)).toBe(2000);
    expect(nextBackoffMs(3)).toBe(4000);
    expect(nextBackoffMs(4)).toBe(8000);
    expect(nextBackoffMs(5)).toBe(16000);
    expect(nextBackoffMs(6)).toBe(30000);
    expect(nextBackoffMs(10)).toBe(30000);
  });
  it('stop() is safe before start() and when called twice', async () => {
    const neverStarted = createEventHub(deps.config.databaseUrl, deps.db);
    await expect(neverStarted.stop()).resolves.toBeUndefined();

    const hub = createEventHub(deps.config.databaseUrl, deps.db);
    await hub.start();
    await hub.stop();
    await expect(hub.stop()).resolves.toBeUndefined();
  });

  it('stop() cancels an in-flight connect and tears down the client instead of leaving it live', async () => {
    let resolveConnect!: () => void;
    const connectPromise = new Promise<void>((resolve) => { resolveConnect = resolve; });
    let endCalls = 0;
    const fake = {
      connect: () => connectPromise,
      query: async () => undefined,
      on: () => undefined,
      end: async () => { endCalls++; },
      removeAllListeners: () => undefined,
    } as unknown as Client;

    const hub = createEventHub(deps.config.databaseUrl, deps.db, { clientFactory: () => fake });
    const startPromise = hub.start(); // connect() is now pending — do not await start() yet
    await hub.stop(); // stop() runs while connect() is still in flight
    resolveConnect();
    await expect(startPromise).resolves.toBeUndefined(); // must not throw

    expect(endCalls).toBeGreaterThan(0); // the fake was torn down

    // If the in-flight connect had incorrectly won the race and assigned `client`,
    // a second stop() would find a live client and call end() on it again. It doesn't:
    // the internal client reference was never assigned once stop() had already run.
    const endCallsAfterStart = endCalls;
    await hub.stop();
    expect(endCalls).toBe(endCallsAfterStart);
  });
});
