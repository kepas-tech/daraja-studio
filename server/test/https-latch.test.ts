import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { createDbKeyring } from '../src/crypto/secrets.js';
import { createOrgService } from '../src/orgs/service.js';
import { createSettings, type SettingKey } from '../src/settings/store.js';
import { createInstanceSettings, type InstanceKey, type InstanceSettings } from '../src/settings/instance.js';
import { createCache } from '../src/db/cache.js';
import { createEventHub } from '../src/events/hub.js';
import { createDarajaFactory } from '../src/sdk/client.js';
import { createOperatorService } from '../src/operators/service.js';
import { createSettingsService } from '../src/settings/service.js';
import { createMoneyOutService } from '../src/money_out/service.js';
import { buildApp, type AppDeps } from '../src/app.js';
import { TEST_KEY, resetTables, ensureTestOrg, TEST_ORG_ID } from './helpers.js';

// A dedicated app builder (rather than helpers.ts's makeApp/testDeps, which hardcode
// NODE_ENV='test') so this test can run with NODE_ENV='production' and a spied settings.get.
function buildProdApp() {
  const config = loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://studio:studio@localhost:5433/studio_test',
    STUDIO_SECRET_KEY: TEST_KEY,
    STUDIO_TRUST_PROXY: '1',
    NODE_ENV: 'production',
  });
  const db = createPool(config.databaseUrl);
  db.setFallbackOrg(TEST_ORG_ID);
  const keyring = createDbKeyring(db, config.secretKey);
  const orgs = createOrgService({ db, keyring, master: config.secretKey });
  const realSettings = createSettings(db, keyring);
  const getSpy = vi.fn((key: SettingKey) => realSettings.get(key));
  const settings = { ...realSettings, get: getSpy };
  const realInstance = createInstanceSettings(db, config.secretKey);
  const instanceGetSpy = vi.fn((key: InstanceKey) => realInstance.get(key));
  const instance: InstanceSettings = { ...realInstance, get: instanceGetSpy };
  const cache = createCache(db);
  const events = createEventHub(config.databaseUrl, db);
  const daraja = createDarajaFactory({ settings, cache, db, keyring });
  const operators = createOperatorService({ db, settings, keyring, daraja, events, orgs, config });
  const settingsService = createSettingsService({ db, config, settings, instance, cache, daraja, operators, orgs });
  const moneyOut = createMoneyOutService({ db, settings, daraja, events, config, orgs });
  const deps: AppDeps = { config, mode: 'single', db, keyring, orgs, settings, instance, cache, events, daraja, operators, settingsService, moneyOut };
  const app = buildApp(deps);
  return { app, db, realInstance, getSpy, instanceGetSpy };
}

describe('https latch', () => {
  it('writes https.seen once and never re-reads it after the first request', async () => {
    const { app, db, realInstance, getSpy, instanceGetSpy } = buildProdApp();
    try {
      await resetTables(db);
      await ensureTestOrg();
      // instance_settings is install-wide and never truncated by resetTables() — start this test
      // from a clean slate so the assertions below actually observe the latch firing, rather than
      // trivially passing on a 'true' value some earlier test left behind.
      await db.query(`DELETE FROM instance_settings WHERE key='https.seen'`);

      await request(app).get('/healthz').set('X-Forwarded-Proto', 'https');
      await request(app).get('/healthz').set('X-Forwarded-Proto', 'https');
      // The write is fire-and-forget; give its microtask/DB round trip a moment to land.
      await new Promise((r) => setTimeout(r, 100));

      // Read via the unspied store: instance.get would be the wrapped one and would itself count
      // as a read, undermining the read-count assertion below.
      expect(await realInstance.get('https.seen')).toBe('true');
      // https.seen no longer goes through settings.get at all.
      expect(getSpy.mock.calls.filter(([key]) => key === 'https.seen').length).toBe(0);
      // The in-process `httpsSeen` flag means only the first qualifying request ever reads it.
      const httpsSeenReads = instanceGetSpy.mock.calls.filter(([key]) => key === 'https.seen').length;
      expect(httpsSeenReads).toBe(1);
    } finally {
      await db.end();
    }
  });
});
