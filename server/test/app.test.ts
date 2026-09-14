import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeApp } from './helpers.js';

// buildApp() reads process.env.STUDIO_WEB_DIR synchronously (server/src/app.ts:69) and only mounts
// the SPA fallback (static files + the /{*path} catch-all) when <webDir>/index.html exists at that
// moment. web/dist is git-ignored and does not exist on a fresh checkout before `pnpm build` has
// run, so makeApp() must not run until a fixture index.html is in place — this suite builds its
// own app in beforeAll, after pointing STUDIO_WEB_DIR at a throwaway directory, rather than at
// module load time. That makes the suite pass regardless of whatever STUDIO_WEB_DIR was set to in
// the environment (including a nonexistent path), and regardless of whether web/dist exists.
let app: ReturnType<typeof makeApp>['app'];
let close: () => Promise<void>;
let tmpWebDir: string;
let originalWebDir: string | undefined;

beforeAll(() => {
  originalWebDir = process.env.STUDIO_WEB_DIR;
  tmpWebDir = mkdtempSync(path.join(tmpdir(), 'daraja-studio-web-'));
  writeFileSync(path.join(tmpWebDir, 'index.html'), '<!doctype html><title>t</title>');
  process.env.STUDIO_WEB_DIR = tmpWebDir;
  ({ app, close } = makeApp());
});

afterAll(async () => {
  await close();
  rmSync(tmpWebDir, { recursive: true, force: true });
  if (originalWebDir === undefined) delete process.env.STUDIO_WEB_DIR;
  else process.env.STUDIO_WEB_DIR = originalWebDir;
});

describe('app shell', () => {
  it('returns JSON 404 for unknown api routes', async () => {
    const r = await request(app).get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  // A8: the SPA-fallback exclusion matched any path merely starting with the string "/api" or
  // "/cb", so a real page route like /apiary was swallowed by the JSON 404 instead of falling
  // through to the SPA.
  it('falls through to the SPA for a path that merely starts with the api or cb prefix', async () => {
    const apiary = await request(app).get('/apiary');
    expect(apiary.status).toBe(200);
    expect(apiary.headers['content-type']).toMatch(/html/);

    const cbx = await request(app).get('/cbx');
    expect(cbx.status).toBe(200);
    expect(cbx.headers['content-type']).toMatch(/html/);
  });

  // The exact-match exclusion (/^\/(api|cb)(\/|$)/) must still catch the bare and
  // nested /cb path itself — callbackRoutes only defines POST handlers, so a GET here has to be
  // turned away as JSON 404, the same shape as /api/nope, not swallowed by the SPA catch-all.
  it('returns JSON 404 for GET /cb and GET /cb/x, same shape as /api/nope', async () => {
    const bare = await request(app).get('/cb');
    expect(bare.status).toBe(404);
    expect(bare.body.error.code).toBe('not_found');

    const nested = await request(app).get('/cb/x');
    expect(nested.status).toBe(404);
    expect(nested.body.error.code).toBe('not_found');
  });
});
