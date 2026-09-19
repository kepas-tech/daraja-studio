import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { makeApp } from './helpers.js';

/**
 * Step 2b: the address move. While the deployment names the hostnames it has left behind, a GET on
 * one of them is answered with the studio's own public address — and the callback paths are not,
 * because a request Safaricom was given the old address for has to be answered there. Nothing here
 * is active without the configuration, which is what makes the move reversible and quiet.
 */
const OLD = 'darajastudio.com';
const NEW = 'https://studio.kepas.co.ke';

function appWith(env: Record<string, string>) {
  return makeApp({ env: { STUDIO_PUBLIC_URL: NEW, ...env } });
}

const oldHost = appWith({ STUDIO_REDIRECT_OLD_ADDRESSES: OLD, STUDIO_REDIRECT_UNTIL: '2999-01-01T00:00:00Z' });
afterAll(async () => { await oldHost.deps.events.stop(); await oldHost.close(); });

describe('the old address, while the move is on', () => {
  it('sends a reader on to the studio’s own address, path and query included', async () => {
    const r = await request(oldHost.app).get('/history?range=7').set('Host', OLD);
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe(NEW + '/history?range=7');
    // The root, and a hostname written in capitals, are the same host.
    expect((await request(oldHost.app).get('/').set('Host', OLD)).headers.location).toBe(NEW + '/');
    expect((await request(oldHost.app).get('/reports').set('Host', 'DARAJAstudio.com')).status).toBe(301);
  });

  it('never bounces the callback paths, which have to be answered where they were asked for', async () => {
    // The self test Safaricom's address check posts to, and a payment confirmation.
    const selftest = await request(oldHost.app).get('/cb/sekret/selftest').set('Host', OLD);
    expect(selftest.status).not.toBe(301);
    const confirm = await request(oldHost.app).post('/cb/sekret/c2b/confirm').set('Host', OLD).send({ TransID: 'RCMOVE1' });
    expect(confirm.status).not.toBe(301);
  });

  it('never bounces anything that is not a GET, so a machine posting to the old address still gets through', async () => {
    const feed = await request(oldHost.app).post('/api/money-in/feed').set('Host', OLD).send({});
    expect(feed.status).not.toBe(301);
    expect(feed.status).toBe(401);
  });

  it('leaves the studio’s own address, and any other hostname, exactly as it was', async () => {
    expect((await request(oldHost.app).get('/').set('Host', 'studio.kepas.co.ke')).status).toBe(200);
    expect((await request(oldHost.app).get('/').set('Host', 'someone-elses.example')).status).toBe(200);
  });
});

describe('the old address, once the two weeks are up or nothing is configured', () => {
  it('is served like any other address when no date is set', async () => {
    const app = appWith({ STUDIO_REDIRECT_OLD_ADDRESSES: OLD });
    try { expect((await request(app.app).get('/').set('Host', OLD)).status).toBe(200); }
    finally { await app.deps.events.stop(); await app.close(); }
  });

  it('is served again the moment the date has passed', async () => {
    const app = appWith({ STUDIO_REDIRECT_OLD_ADDRESSES: OLD, STUDIO_REDIRECT_UNTIL: '2026-01-01T00:00:00Z' });
    try { expect((await request(app.app).get('/').set('Host', OLD)).status).toBe(200); }
    finally { await app.deps.events.stop(); await app.close(); }
  });

  it('is served when nothing at all is configured, which is how the product ships', async () => {
    const app = appWith({});
    try { expect((await request(app.app).get('/').set('Host', OLD)).status).toBe(200); }
    finally { await app.deps.events.stop(); await app.close(); }
  });
});
