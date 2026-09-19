import { z } from 'zod';
import { vapidFromEnv, type Vapid } from './push/config.js';

const schema = z.object({
  STUDIO_SMTP_HOST: z.string().optional(),
  STUDIO_SMTP_PORT: z.preprocess((v) => v === '' ? undefined : v, z.coerce.number().int().refine((v) => v === 465 || v === 587, 'Use TLS submission port 465 or 587').default(465)),
  STUDIO_SMTP_USER: z.string().optional(),
  STUDIO_SMTP_PASSWORD: z.string().optional(),
  STUDIO_SMTP_FROM: z.preprocess((v) => v === '' ? undefined : v, z.string().email().optional()),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  STUDIO_SECRET_KEY: z
    .string()
    .refine((s) => Buffer.from(s, 'base64').length === 32, 'STUDIO_SECRET_KEY must be 32 bytes base64'),
  STUDIO_PORT: z.coerce.number().int().positive().default(8080),
  STUDIO_TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // An empty string means "not set": the deploy compose file forwards these two variables with
  // `${VAR:-}` so an operator who leaves them out of deploy/.env gets the default, not a boot error.
  STUDIO_PUBLIC_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  STUDIO_MAX_SEND_CENTS: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().positive('STUDIO_MAX_SEND_CENTS must be a positive whole number of cents').optional(),
  ),
  STUDIO_FAKE_SAFARICOM: z.enum(['0', '1']).default('0'),
  // Comma-separated addresses Safaricom sees this service coming from. Safaricom whitelists these
  // against the shortcode, and Studio names them when a call is refused for coming from elsewhere.
  STUDIO_EGRESS_IPS: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  // Web push (feature 12). All three or none; the shape is checked in push/config.ts, which warns
  // and stays off rather than refusing to boot over an optional feature.
  STUDIO_VAPID_PUBLIC_KEY: z.string().optional(),
  STUDIO_VAPID_PRIVATE_KEY: z.string().optional(),
  STUDIO_VAPID_SUBJECT: z.string().optional(),
  // A directory of migrations to read after the core's own, for a package installed beside Studio.
  // Empty or unset means none is read. Its files are numbered from 900.
  STUDIO_EXTENSION_MIGRATIONS: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
});

export interface Config {
  smtp?: { host: string; port: number; user: string; password: string; from: string };
  databaseUrl: string;
  secretKey: Buffer;
  port: number;
  trustProxy: number;
  publicUrl?: string;
  nodeEnv: 'development' | 'test' | 'production';
  /** Server-enforced cap on any single send, in cents. null = no cap. */
  maxSendCents: number | null;
  /** Route every Daraja call to the in-process fake. Never in production. */
  fakeSafaricom: boolean;
  /** Addresses Safaricom sees requests coming from, for the whitelist. Empty when unset. */
  egressIps: string[];
  /** Web push keys. null = web push is off: no button, no sender, no service worker. */
  vapid: Vapid | null;
  /** A second migrations directory to read after the core's own. null = none is read. */
  extensionMigrations: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new Error(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const e = r.data;
  if (e.STUDIO_FAKE_SAFARICOM === '1' && e.NODE_ENV === 'production') {
    throw new Error('STUDIO_FAKE_SAFARICOM cannot be set in production');
  }
  const smtpFields = [e.STUDIO_SMTP_HOST, e.STUDIO_SMTP_USER, e.STUDIO_SMTP_PASSWORD, e.STUDIO_SMTP_FROM];
  if (smtpFields.some(Boolean) && (!smtpFields.every(Boolean) || !e.STUDIO_PUBLIC_URL)) {
    throw new Error('SMTP needs HOST, USER, PASSWORD, FROM and STUDIO_PUBLIC_URL');
  }
  if (smtpFields.every(Boolean) && e.NODE_ENV === 'production' && !e.STUDIO_PUBLIC_URL?.startsWith('https://')) {
    throw new Error('Email confirmation requires an https STUDIO_PUBLIC_URL in production');
  }
  return {
    smtp: smtpFields.every(Boolean) ? { host: e.STUDIO_SMTP_HOST!, port: e.STUDIO_SMTP_PORT, user: e.STUDIO_SMTP_USER!, password: e.STUDIO_SMTP_PASSWORD!, from: e.STUDIO_SMTP_FROM! } : undefined,
    databaseUrl: e.DATABASE_URL,
    secretKey: Buffer.from(e.STUDIO_SECRET_KEY, 'base64'),
    port: e.STUDIO_PORT,
    trustProxy: e.STUDIO_TRUST_PROXY,
    publicUrl: e.STUDIO_PUBLIC_URL,
    nodeEnv: e.NODE_ENV,
    maxSendCents: e.STUDIO_MAX_SEND_CENTS ?? null,
    fakeSafaricom: e.STUDIO_FAKE_SAFARICOM === '1',
    egressIps: (e.STUDIO_EGRESS_IPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    extensionMigrations: e.STUDIO_EXTENSION_MIGRATIONS ?? null,
    vapid: vapidFromEnv({
      STUDIO_VAPID_PUBLIC_KEY: e.STUDIO_VAPID_PUBLIC_KEY,
      STUDIO_VAPID_PRIVATE_KEY: e.STUDIO_VAPID_PRIVATE_KEY,
      STUDIO_VAPID_SUBJECT: e.STUDIO_VAPID_SUBJECT,
    }),
  };
}
