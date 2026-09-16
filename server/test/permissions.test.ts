import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PERMISSIONS, isPermissionKey } from '../src/permissions/catalog.js';
import { requirePermission } from '../src/permissions/middleware.js';
import { testDeps, resetTables } from './helpers.js';
import { errorMiddleware } from '../src/util/errors.js';

const deps = testDeps();
afterAll(() => deps.db.end());

describe('permissions', () => {
  it('catalog has the 22 keys with labels and roles', () => {
    expect(PERMISSIONS.length).toBe(22);
    expect(PERMISSIONS.find((p) => p.key === 'send.phone')?.role).toBe('ORG B2C API Initiator');
    expect(isPermissionKey('send.phone')).toBe(true);
    expect(isPermissionKey('nope')).toBe(false);
  });

  it('guards a route; owner bypasses', async () => {
    await resetTables(deps.db);
    const [owner] = await deps.db.query<{ id: string }>(`INSERT INTO people(username,display_name,password_hash,is_owner) VALUES ('o','O','x',true) RETURNING id`);
    const [staff] = await deps.db.query<{ id: string }>(`INSERT INTO people(username,display_name,password_hash) VALUES ('s','S','x') RETURNING id`);
    const app = express();
    app.use((req, _res, next) => {
      const who = req.get('x-test-person');
      req.person = { id: who === 'owner' ? owner.id : staff.id, username: who!, display_name: who!, is_owner: who === 'owner', status: 'active', must_change_password: false };
      next();
    });
    app.get('/x', requirePermission(deps.db, 'balances.view'), (_req, res) => res.json({ ok: true }));
    app.use(errorMiddleware);
    expect((await request(app).get('/x').set('x-test-person', 'owner')).status).toBe(200);
    expect((await request(app).get('/x').set('x-test-person', 'staff')).status).toBe(403);
    await deps.db.query(`INSERT INTO permissions(person_id, permission) VALUES ($1,'balances.view')`, [staff.id]);
    expect((await request(app).get('/x').set('x-test-person', 'staff')).status).toBe(200);
  });

  it('returns 401 with not_logged_in when no person is set', async () => {
    const app = express();
    app.get('/x', requirePermission(deps.db, 'balances.view'), (_req, res) => res.json({ ok: true }));
    app.use(errorMiddleware);
    const res = await request(app).get('/x');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('not_logged_in');
  });
});
