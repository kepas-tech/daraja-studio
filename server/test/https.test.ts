import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { loadConfig } from '../src/config.js';
import { requireHttps } from '../src/auth/middleware.js';
import { TEST_KEY } from './helpers.js';

function buildTestApp(trustProxy: string, nodeEnv: string) {
  const config = loadConfig({
    DATABASE_URL: 'postgres://ignored/ignored',
    STUDIO_SECRET_KEY: TEST_KEY,
    STUDIO_TRUST_PROXY: trustProxy,
    NODE_ENV: nodeEnv,
  });
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.get('/x', requireHttps(config), (_req, res) => res.status(200).end());
  return app;
}

describe('requireHttps', () => {
  it('rejects a forged x-forwarded-proto header when the proxy hop is not trusted', async () => {
    const app = buildTestApp('0', 'production');
    const r = await request(app).get('/x').set('x-forwarded-proto', 'https');
    expect(r.status).toBe(403);
  });

  it('accepts x-forwarded-proto only once the hop is trusted', async () => {
    const app = buildTestApp('1', 'production');
    const r = await request(app).get('/x').set('x-forwarded-proto', 'https');
    expect(r.status).toBe(200);
  });

  it('passes through outside production with no header at all', async () => {
    const app = buildTestApp('0', 'test');
    const r = await request(app).get('/x');
    expect(r.status).toBe(200);
  });
});
