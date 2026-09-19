import { PERMISSIONS, type PermissionKey } from '../permissions/catalog.js';

/**
 * Step one of the tiers-and-modules design. Every part of Studio the owner can switch declares, in
 * one place: its key, its name, one plain sentence, the permissions it adds, the menu entries it
 * adds, what turning it off hides, and what it stands on. The route guard, the menu builder, the
 * read layer and the page all read this list, so a module cannot be half-declared.
 */
export interface ModuleDecl {
  key: string;
  name: string;
  sentence: string;
  /** The permissions this module adds to the catalogue. Turning it off refuses its routes; it never
   *  takes a permission off a person. */
  permissions: PermissionKey[];
  /** The menu entries this module adds, by the web's own nav keys. One owner per entry. */
  menu: string[];
  /** What turning this module off hides, in the owner's words. */
  hides: string;
  /** What this one stands on: another module it cannot be on without, or a part of Studio that is
   *  always on (see ALWAYS_ON below), named to the owner and never blocking. */
  needs: string[];
  /** False for a module that is declared and not built yet: listed for the owner, never switchable. */
  built: boolean;
}

export const MODULES: ModuleDecl[] = [
  {
    key: 'contacts', name: 'Contacts',
    sentence: 'The people and businesses you pay often, saved once so a name is never retyped.',
    permissions: ['contacts.manage'], menu: ['contacts'],
    hides: 'the address book, and the saved names in Send money and Bulk send',
    needs: [], built: true,
  },
  {
    key: 'businesses', name: 'Businesses and accounts',
    sentence: 'The businesses this paybill serves, the account numbers under each one, and the customers behind them.',
    permissions: ['businesses.manage'], menu: ['businesses'],
    hides: 'the Businesses page, every account number, and the fixes on Money in',
    needs: [], built: true,
  },
  {
    key: 'statements', name: 'Statements and arrears',
    sentence: 'One account\u2019s running statement, what it owes, and who is behind.',
    permissions: [], menu: [],
    hides: 'statements, arrears and the reminders that go with them',
    needs: ['businesses'], built: true,
  },
  {
    key: 'invoices', name: 'Invoices',
    sentence: 'Bills your customers can pay, with reminders and each payment matched to its bill.',
    permissions: ['invoices.manage'], menu: ['invoices'],
    hides: 'the Invoices page and every bill in it',
    needs: [], built: true,
  },
  {
    key: 'people', name: 'People and roles',
    sentence: 'Who may log in to this studio, and what each of them may do.',
    permissions: [], menu: [],
    hides: 'the People page and every role but the owner\u2019s',
    needs: [], built: true,
  },
  {
    key: 'approvals', name: 'Approvals',
    sentence: 'A second person releases a send above the amount you set, so one pair of hands is never enough.',
    permissions: ['send.approve'], menu: ['approvals'],
    hides: 'Waiting, and the amount that holds a send for a second person',
    needs: ['people'], built: true,
  },
  {
    key: 'reports', name: 'Reports',
    sentence: 'The week\u2019s numbers: what came in, what went out, and why anything failed.',
    permissions: [], menu: ['reports'],
    hides: 'the Reports page',
    needs: [], built: true,
  },
  {
    key: 'reconcile', name: 'Reconcile',
    sentence: 'Safaricom\u2019s own record set beside Studio\u2019s, so a payment that went missing is found.',
    permissions: [], menu: [],
    hides: 'the check for missing payments',
    needs: [], built: true,
  },
  {
    key: 'cases', name: 'Case files',
    sentence: 'A note kept on one payment while somebody looks into it.',
    permissions: ['cases.manage'], menu: [],
    hides: 'the case file on a payment',
    needs: [], built: true,
  },
  {
    key: 'reversals', name: 'Reversal requests',
    sentence: 'Send a payment back to whoever paid it.',
    permissions: ['reverse.request'], menu: ['reverse'],
    hides: 'Reverse a payment',
    needs: [], built: true,
  },
  {
    key: 'standing_orders', name: 'Standing orders',
    sentence: 'A payer agrees once, and Safaricom collects from them on the schedule you set.',
    permissions: ['standing_orders.manage'], menu: ['standing-orders'],
    hides: 'the Standing orders page',
    needs: [], built: true,
  },
  {
    key: 'express_checkout', name: 'Express checkout',
    sentence: 'Prompt another business’s till to pay this paybill.',
    permissions: ['express.checkout'], menu: ['express'],
    hides: 'the Express checkout page',
    needs: [], built: true,
  },
  {
    key: 'bonga', name: 'Bonga points',
    sentence: 'Let a payer pay with their Bonga points.',
    permissions: ['bonga.redeem'], menu: ['bonga'],
    hides: 'the Bonga points page',
    needs: [], built: true,
  },
  {
    key: 'notifications', name: 'Notifications and push',
    sentence: 'The inbox of what happened, and a nudge on the devices that asked for one.',
    permissions: [], menu: ['notifications'],
    hides: 'the bell, the inbox, and notifications on your devices',
    needs: [], built: true,
  },
  {
    key: 'developer', name: 'Developer',
    sentence: 'Keys another system calls this studio with, the address Studio tells when a payment finishes, and every delivery it has made.',
    permissions: [], menu: ['api-keys', 'webhooks'],
    hides: 'API keys, Webhooks and Deliveries',
    needs: [], built: true,
  },
  {
    key: 'feed', name: 'Payment feed',
    sentence: 'Another system owns this paybill\u2019s confirmation addresses and posts each payment in; Studio records it exactly as its own.',
    permissions: ['money_in.feed'], menu: [],
    hides: 'the inbox other systems post to, and the Forwarder key that opens it',
    needs: ['developer'], built: true,
  },
  {
    // Declared for the B2B-and-schedules work that follows step one (design: scheduled-payments),
    // and deliberately not built here: listed for the owner, never switchable, no routes, no screen.
    // It stands on money out — the payments themselves — which is always on, and on the contact book.
    key: 'scheduled_payments', name: 'Scheduled payments',
    sentence: 'Pay the same people on a timetable.',
    permissions: [], menu: [],
    hides: 'nothing yet — it is not built',
    needs: ['money_out', 'contacts'], built: false,
  },
  {
    // Declared here so Platform has a place to hang it, and deliberately not built in step one.
    key: 'custody', name: 'Custody',
    sentence: 'Studio holds customer balances: wallets, a double-entry ledger, integrity checks and the float rule. Not built yet.',
    permissions: [], menu: [],
    hides: 'nothing yet \u2014 it is not built',
    needs: [], built: false,
  },
];

/**
 * Register one more declaration. This is the seam an installed package uses at boot: it hands over
 * the same shape the list above is written in, and the guard, the menu, the page and the tiers pick
 * it up with nothing else changing here. A declaration whose key is already known replaces it.
 */
export function registerModule(decl: ModuleDecl): void {
  const at = MODULES.findIndex((m) => m.key === decl.key);
  if (at >= 0) MODULES[at] = decl;
  else MODULES.push(decl);
}

export type TierKey = 'simple' | 'business' | 'platform';
export interface TierDecl {
  key: TierKey;
  name: string;
  sentence: string;
  /** The modules this tier turns on. Every one of them is built, and the set is closed under a
   *  module's own needs, so applying a tier never asks for a dependency it does not carry. */
  on: string[];
  /** Modules this tier has a place for that are not built yet. */
  planned: string[];
}

const everyday = ['contacts', 'notifications', 'businesses', 'statements', 'invoices', 'people', 'approvals', 'reports', 'reconcile', 'cases', 'reversals', 'standing_orders', 'express_checkout', 'bonga'];

export const TIERS: TierDecl[] = [
  {
    key: 'simple', name: 'Simple',
    sentence: 'A shop or a stall: take money, send money, history, contacts, notifications.',
    on: ['contacts', 'notifications'], planned: [],
  },
  {
    key: 'business', name: 'Business',
    sentence: 'Studio as it stands today: businesses and account numbers, statements and arrears, invoices, people and roles, approvals, reports, checking nothing is missing, case files, reversal requests.',
    on: everyday, planned: ['scheduled_payments'],
  },
  {
    key: 'platform', name: 'Platform',
    sentence: 'Everything in Business, plus the developer surface and the payment feed \u2014 and the place custody will hang when it is built.',
    on: [...everyday, 'developer', 'feed'], planned: ['scheduled_payments', 'custody'],
  },
];

/** Where an organisation that has never chosen a tier starts. Platform is a deliberate choice, so
 *  the developer surface and the custody module stay off until somebody asks for them. */
export const DEFAULT_TIER: TierKey = 'business';

/**
 * Parts of Studio that are always on and have no switch: money out is the payments themselves
 * (B2C, B2B, bulk, reversals), and no tier and no owner switch turns paying out off. A module may
 * stand on one of these, and the page says so, but nothing can hold it off, so no guard enforces it.
 * Keyed by the name a declaration uses, valued by the words the owner reads.
 */
export const ALWAYS_ON: Record<string, string> = { money_out: 'Money out' };

export function isTierKey(s: string): s is TierKey { return TIERS.some((t) => t.key === s); }
export function moduleDecl(key: string): ModuleDecl | undefined { return MODULES.find((m) => m.key === key); }
/** What a module stands on, in the owner's words: another module, or a part that is always on. */
export function dependencyName(key: string): string { return moduleDecl(key)?.name ?? ALWAYS_ON[key] ?? key; }
export function tierDecl(key: TierKey): TierDecl { return TIERS.find((t) => t.key === key)!; }
/** Whether a tier turns this module on by itself. A module that is not built is never on. */
export function tierHas(tier: TierKey, key: string): boolean {
  return tierDecl(tier).on.includes(key);
}
/** The plain label the catalogue already carries for a permission. */
export function permissionLabel(key: PermissionKey): string {
  return PERMISSIONS.find((p) => p.key === key)?.label ?? key;
}
