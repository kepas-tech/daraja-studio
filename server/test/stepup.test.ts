import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, loginAsOwner } from './helpers.js';

const { app, deps, close } = makeApp();
afterAll(close);

describe('step-up brute-force counter', () => {
  let cookie: string; let csrf: string;
  beforeEach(async () => { ({ cookie, csrf } = await loginAsOwner(app, deps)); });

  it('locks the step-up after 5 wrong passwords, even with the correct one on the 6th try', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf)
        .send({ allowlist: ['1.2.3.4'], password: 'wrong password' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('step_up_required');
    }
    const sixth = await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ allowlist: ['1.2.3.4'], password: 'correct horse' });
    expect(sixth.status).toBe(423);
    expect(sixth.body.error.code).toBe('locked');
  });

  it('clears the counter on a correct password before the lock engages', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf)
        .send({ allowlist: ['1.2.3.4'], password: 'wrong password' });
    }
    const ok = await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ allowlist: ['1.2.3.4'], password: 'correct horse' });
    expect(ok.status).toBe(204);
    const rows = await deps.db.query('SELECT 1 FROM login_attempts WHERE key LIKE $1', ['stepup:%']);
    expect(rows.length).toBe(0);

    // The counter being cleared means the next 5 wrong attempts start a fresh count rather than
    // being turned away immediately.
    for (let i = 0; i < 5; i++) {
      const r = await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf)
        .send({ allowlist: ['1.2.3.4'], password: 'wrong password' });
      expect(r.status).toBe(403);
    }
  });

  it('shares the same lockout key across change-password and settings step-up', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/change-password').set('Cookie', cookie).set('x-csrf-token', csrf)
        .send({ currentPassword: 'wrong password', newPassword: 'new long password 1' });
      expect(r.status).toBe(403);
    }
    // The 6th wrong try, made against a different route that step-ups with the same person,
    // is turned away without ever checking the password.
    const sixth = await request(app).put('/api/settings/allowlist').set('Cookie', cookie).set('x-csrf-token', csrf)
      .send({ allowlist: ['1.2.3.4'], password: 'correct horse' });
    expect(sixth.status).toBe(423);
    expect(sixth.body.error.code).toBe('locked');
  });
});
