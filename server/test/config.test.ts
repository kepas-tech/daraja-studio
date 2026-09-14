import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const key = Buffer.alloc(32, 7).toString('base64');

describe('loadConfig', () => {
  it('parses a valid env', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://u:p@h/db', STUDIO_SECRET_KEY: key });
    expect(c.port).toBe(8080);
    expect(c.trustProxy).toBe(0);
    expect(c.secretKey.length).toBe(32);
  });
  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://u:p@h/db', STUDIO_SECRET_KEY: 'short' })).toThrow(/32 bytes/);
  });
  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ STUDIO_SECRET_KEY: key })).toThrow(/DATABASE_URL/);
  });

  it('treats an empty STUDIO_MAX_SEND_CENTS or STUDIO_PUBLIC_URL as not set (compose forwards them with ${VAR:-})', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', STUDIO_SECRET_KEY: key, STUDIO_MAX_SEND_CENTS: '', STUDIO_PUBLIC_URL: '' });
    expect(c.maxSendCents).toBeNull();
    expect(c.publicUrl).toBeUndefined();
  });

  it('reads STUDIO_MAX_SEND_CENTS and STUDIO_FAKE_SAFARICOM', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x', STUDIO_SECRET_KEY: key, STUDIO_MAX_SEND_CENTS: '100', STUDIO_FAKE_SAFARICOM: '1', NODE_ENV: 'development' });
    expect(c.maxSendCents).toBe(100);
    expect(c.fakeSafaricom).toBe(true);
    const d = loadConfig({ DATABASE_URL: 'postgres://x', STUDIO_SECRET_KEY: key });
    expect(d.maxSendCents).toBeNull();
    expect(d.fakeSafaricom).toBe(false);
  });

  it('rejects a non-positive cap and refuses the fake in production', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', STUDIO_SECRET_KEY: key, STUDIO_MAX_SEND_CENTS: '0' })).toThrow(/STUDIO_MAX_SEND_CENTS/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', STUDIO_SECRET_KEY: key, STUDIO_FAKE_SAFARICOM: '1', NODE_ENV: 'production' })).toThrow(/STUDIO_FAKE_SAFARICOM/);
  });

  it('splits STUDIO_EGRESS_IPS on commas, trims, and drops empties', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgres://x',
      STUDIO_SECRET_KEY: key,
      STUDIO_EGRESS_IPS: ' 192.0.2.10 , 2001:db8::1 ,',
    });
    expect(c.egressIps).toEqual(['192.0.2.10', '2001:db8::1']);
    const d = loadConfig({ DATABASE_URL: 'postgres://x', STUDIO_SECRET_KEY: key });
    expect(d.egressIps).toEqual([]);
    const e = loadConfig({ DATABASE_URL: 'postgres://x', STUDIO_SECRET_KEY: key, STUDIO_EGRESS_IPS: '' });
    expect(e.egressIps).toEqual([]);
  });
});

describe('SMTP configuration', () => {
  const env = { DATABASE_URL: 'postgres://u:p@h/db', STUDIO_SECRET_KEY: key, STUDIO_PUBLIC_URL: 'https://studio.example', NODE_ENV: 'production', STUDIO_SMTP_HOST: 'mail.example.com', STUDIO_SMTP_USER: 'noreply@example.com', STUDIO_SMTP_PASSWORD: 'test-only', STUDIO_SMTP_FROM: 'noreply@example.com' };
  it('requires all submission settings together and rejects plaintext SMTP ports and public links', () => {
    expect(loadConfig(env).smtp?.port).toBe(465);
    expect(loadConfig({ ...env, STUDIO_SMTP_PORT: '587' }).smtp?.port).toBe(587);
    expect(() => loadConfig({ ...env, STUDIO_SMTP_PASSWORD: '' })).toThrow(/SMTP needs/);
    expect(() => loadConfig({ ...env, STUDIO_SMTP_PORT: '25' })).toThrow(/TLS submission/);
    expect(() => loadConfig({ ...env, STUDIO_PUBLIC_URL: 'http://studio.example' })).toThrow(/https/);
  });
  it('keeps existing self-hosted installs working with empty Compose email settings', () => {
    expect(loadConfig({ DATABASE_URL: env.DATABASE_URL, STUDIO_SECRET_KEY: key, STUDIO_SMTP_HOST: '', STUDIO_SMTP_USER: '', STUDIO_SMTP_PASSWORD: '', STUDIO_SMTP_FROM: '', STUDIO_SMTP_PORT: '' }).smtp).toBeUndefined();
  });
});
