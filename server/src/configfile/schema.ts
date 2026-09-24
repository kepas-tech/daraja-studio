import { z } from 'zod';
import { TIERS } from '../modules/registry.js';

/**
 * The studio's configuration file: one place that says what a studio is, so a setup like KEPAS's
 * can be handed to anyone and reproduced exactly, and every feature added reaches everyone.
 *
 * The database stays the running truth. The file is the declaration: `studio config plan` shows what
 * would change, `studio config apply` makes it so, and a second apply changes nothing. Secrets never
 * live here: keys and webhook secrets are made by `apply` and shown once.
 *
 * Version 1 applies the tier, modules, businesses and apps. Routing, fees and custody are part of the
 * format already, so a file written today stays valid; `plan` says which of them are not yet in force.
 */
const code = z.string().regex(/^[0-9]{3}$/, 'a business code is three digits');
/** Paybill references are read uppercase; a prefix or alias is letters and digits. */
const token = z.string().regex(/^[A-Z0-9]{1,12}$/, 'letters and digits only, up to 12, uppercase');
const prefix = z.string().regex(/^[A-Z0-9]{1,8}$/, 'letters and digits only, up to 8, uppercase');

const business = z.object({
  code,
  name: z.string().trim().min(1).max(60),
  type: z.string().trim().min(1).max(30).default('other'),
}).strict();

const app = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'lowercase letters, digits and hyphens'),
  name: z.string().trim().min(1).max(60),
  /** The code of the business the app takes payments for. */
  business: code,
  mode: z.enum(['pass_through', 'custody']).default('pass_through'),
  hub: z.enum(['kepas', 'studio']).default('kepas'),
  status: z.enum(['active', 'paused']).default('active'),
  prefixes: z.array(prefix).max(8).default([]),
  aliases: z.array(token).max(16).default([]),
  phoneRouting: z.boolean().default(false),
  feePolicy: z.string().trim().min(1).max(40).optional(),
  /** Where the app is told about its payments. The secret is made by apply and shown once. */
  webhook: z.object({ url: z.string().url().max(500) }).strict().optional(),
}).strict();

const feePolicy = z.object({
  c2bMultiplierBp: z.number().int().min(0).max(100_000).optional(),
  withdraw: z.object({
    type: z.enum(['none', 'percentage', 'flat', 'tariff']),
    percentBp: z.number().int().min(0).max(10_000).optional(),
    flatCents: z.number().int().min(0).optional(),
    minCents: z.number().int().min(0).optional(),
    maxCents: z.number().int().min(0).optional(),
  }).strict().optional(),
  commissionBps: z.number().int().min(0).max(10_000).optional(),
  rounding: z.enum(['shilling_ceil', 'cent']).default('shilling_ceil'),
}).strict();

export const studioConfig = z.object({
  /** For editors: where the JSON Schema lives. Ignored by Studio. */
  $schema: z.string().optional(),
  /** Words for the people who read the file. Ignored by Studio. */
  notes: z.string().max(2000).optional(),
  version: z.literal(1),
  tier: z.enum(TIERS.map((t) => t.key) as [string, ...string[]]).optional(),
  /** Modules switched away from what the tier gives, by key. Checked against the registry at run
   *  time, because a private package may register modules of its own. */
  modules: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.boolean()).default({}),
  businesses: z.array(business).max(1000).default([]),
  apps: z.array(app).max(200).default([]),
  routing: z.object({
    aliases: z.array(z.object({ reference: token, business: code.optional(), app: z.string().optional() }).strict()).default([]),
    identifierRescue: z.object({ minLength: z.number().int().min(3).max(12) }).strict().optional(),
    phoneRouting: z.boolean().default(false),
  }).strict().optional(),
  fees: z.object({ policies: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), feePolicy).default({}) }).strict().optional(),
  custody: z.object({
    autoApproveMinutes: z.number().int().min(0).max(10_080).optional(),
    maxWithdrawCents: z.number().int().min(0).optional(),
  }).strict().optional(),
}).strict();

export type StudioConfig = z.infer<typeof studioConfig>;
export type AppDecl = z.infer<typeof app>;
export type BusinessDecl = z.infer<typeof business>;
