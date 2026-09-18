import { DarajaAPIError, DarajaAuthError, DarajaConnectionError, type C2bPayment } from '@kepas/daraja-js';
import { currentOrgId, withOrg, type Db } from '../db/pool.js';
import type { Cache } from '../db/cache.js';
import type { Settings, Env } from '../settings/store.js';
import type { DarajaFactory } from '../sdk/client.js';
import type { EventHub } from '../events/hub.js';
import type { OrgService } from '../orgs/service.js';
import { currentCallbackSecret } from '../orgs/secret.js';
import { callbackUrls } from '../sdk/callbackUrls.js';
import { explain } from '../sdk/meaning.js';
import { HttpError } from '../util/errors.js';
import { audit } from '../audit/log.js';
import { PUBLIC_URL_UNVERIFIED } from '../money_out/ready.js';
import { syncRejection } from '../money_out/service.js';
import { recordC2b } from './record.js';

export interface Actor { personId: string; ip: string }
export interface MoneyInView {
  mode: Env; c2bRegisteredAt: string | null; pullRegisteredAt: string | null; pullCheckedAt: string | null; nominatedNumber: string | null; publicVerified: boolean;
  /** A registration is in flight (started within the last two minutes and not yet finished). */
  registering: boolean;
  /** Why the last registration failed, in the studio's three-line form joined by newlines; null after a success. */
  lastError: string | null;
  /** Safaricom said the addresses were already on record when this studio registered: kept as registered, with a caveat. */
  alreadyRegistered: boolean;
  /** Round 5: where this paybill's confirmations arrive today. Null until the owner answers. */
  arrival: 'studio' | 'forwarder' | null;
  /** The last payment fed in by another system, if any. */
  lastFedAt: string | null;
  /** Live API keys that may feed money in (the forwarder role). */
  feedKeys: number;
}
export interface MoneyInService {
  status(): Promise<MoneyInView>;
  /** Starts the registration and returns at once; the outcome lands in status(). */
  register(actor: Actor): Promise<MoneyInView>;
  /** The work register() starts. Exposed so tests can await it. */
  runRegistration(actor: Actor): Promise<void>;
  checkMissed(): Promise<{ found: number; checkedAt: string }>;
  /** The hourly job: nothing to do until the owner has registered. */
  checkMissedIfRegistered(): Promise<void>;
  /** Round 5: the answer to "where do these payments arrive today". */
  setArrival(arrival: 'studio' | 'forwarder', actor: Actor): Promise<MoneyInView>;
}

export const NOT_REGISTERED = 'Turn on Money in first, so Safaricom knows where to send payments.';
export const NO_NOMINATED = 'Set the nominated number in Settings › Organisation first.';
const PULL_PAGE = 100;

/** `YYYY-MM-DD HH:mm:ss` in East Africa Time, as the Pull API wants it. */
export function eatStamp(d: Date): string {
  const t = new Date(d.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/** A pulled record uses the portal's field names, not the callback's. */
export function pulledToPayment(t: Record<string, unknown>): C2bPayment | null {
  const s = (k: string) => { const v = t[k]; return v == null ? '' : String(v); };
  const transId = s('transactionId') || s('TransID');
  if (!transId) return null;
  const amount = Number(s('amount') || s('TransAmount'));
  if (!Number.isFinite(amount)) return null;
  const date = s('trxDate') || s('TransTime');
  // Phase A: the portal's `sender` column and the three callback-shaped name fields are two
  // spellings of the same thing, and all three parts are read. The named parts win when Safaricom
  // sent them; `sender` stands in when it did not, and then it is the whole name (it carries the
  // phone in front of it, which the cleaning helper drops at storage).
  const sender = s('sender');
  const first = s('FirstName');
  return {
    transactionType: s('transactiontype') || s('TransactionType') || 'Pay Bill', transId, transTime: date.replace(/[^0-9]/g, '').slice(0, 14), amount,
    shortCode: s('shortcode') || s('BusinessShortCode'), billRefNumber: s('billreference') || s('BillRefNumber'), invoiceNumber: '', thirdPartyTransId: '',
    msisdn: s('msisdn') || s('MSISDN'), firstName: first || sender, middleName: first ? s('MiddleName') : '', lastName: first ? s('LastName') : '',
  };
}

/**
 * Money that arrives without a request from us. Nothing here spends an allowance, needs an
 * operator or is polled by the sweep: the only calls are the one-time registrations and the
 * read-only pull that backfills a confirmation Safaricom never delivered.
 */
export function createMoneyInService(deps: { db: Db; settings: Settings; daraja: DarajaFactory; events: EventHub; orgs: OrgService; cache: Cache }): MoneyInService {
  const mode = async (): Promise<Env> => ((await deps.settings.get('daraja.environment')) as Env) ?? 'sandbox';
  const threeLines = (e: unknown): never => {
    if (e instanceof HttpError) throw e;
    if (e instanceof DarajaAuthError) throw new HttpError(502, 'auth_failed', 'Safaricom refused the Daraja key and secret. Check them in Settings.');
    if (e instanceof DarajaConnectionError) throw new HttpError(502, 'unreachable', 'Safaricom could not be reached. Try again in a moment.');
    if (e instanceof DarajaAPIError) {
      const { code, desc } = syncRejection(e);
      const ex = code !== null ? explain('c2b', code, desc) : null;
      throw new HttpError(502, 'refused', ex ? ex.safaricomSaid : desc, ex ? { safaricomSaid: ex.safaricomSaid, meaning: ex.meaning, whatToDo: ex.whatToDo } : undefined);
    }
    throw e;
  };
  const svc: MoneyInService = {
    async status() {
      const env = await mode();
      const s = await deps.settings.getMany([`env.${env}.c2bRegisteredAt`, `env.${env}.pullRegisteredAt`, `env.${env}.pullCheckedAt`, `env.${env}.c2bRegisterStartedAt`, `env.${env}.c2bRegisterError`, `env.${env}.c2bAlreadyRegistered`, 'org.nominatedNumber', 'public.verifiedAt', 'moneyIn.arrival']);
      // Round 5: what the feed branch needs to show its state, read here so one call answers the page.
      const [fed] = await deps.db.query<{ at: Date | null }>(`SELECT max(result_at) AS at FROM requests WHERE result_source = 'feed'`);
      const [keys] = await deps.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_keys WHERE role = 'forwarder' AND revoked_at IS NULL`);
      const arrival = s['moneyIn.arrival'] === 'studio' || s['moneyIn.arrival'] === 'forwarder' ? s['moneyIn.arrival'] as 'studio' | 'forwarder' : null;
      const started = s[`env.${env}.c2bRegisterStartedAt`];
      const registering = !!started && Date.now() - Date.parse(started) < 2 * 60_000;
      return {
        mode: env, c2bRegisteredAt: s[`env.${env}.c2bRegisteredAt`], pullRegisteredAt: s[`env.${env}.pullRegisteredAt`], pullCheckedAt: s[`env.${env}.pullCheckedAt`],
        nominatedNumber: s['org.nominatedNumber'], publicVerified: !!s['public.verifiedAt'], registering, lastError: s[`env.${env}.c2bRegisterError`],
        alreadyRegistered: s[`env.${env}.c2bAlreadyRegistered`] === 'true',
        arrival,
        lastFedAt: fed?.at ? fed.at.toISOString() : null,
        feedKeys: keys?.n ?? 0,
      };
    },

    async setArrival(arrival, actor) {
      await deps.settings.set('moneyIn.arrival', arrival);
      await audit(deps.db, { personId: actor.personId, ip: actor.ip, action: 'money_in.arrival_set', after: { arrival } });
      return svc.status();
    },
    async register(actor) {
      const env = await mode();
      const s = await deps.settings.getMany(['public.url', 'public.verifiedAt', 'org.nominatedNumber']);
      if (!s['public.url'] || !s['public.verifiedAt']) throw new HttpError(409, 'public_url_unverified', PUBLIC_URL_UNVERIFIED);
      if (!s['org.nominatedNumber']) throw new HttpError(409, 'no_nominated_number', NO_NOMINATED);
      // Safaricom can take long enough here that a proxy in front of the studio gives up first, and
      // the page would then see a cut connection rather than an answer. So the work runs after this
      // reply, and the page reads its outcome from status(): started, then registered or an error.
      await deps.settings.set(`env.${env}.c2bRegisterStartedAt`, new Date().toISOString());
      await deps.settings.delete(`env.${env}.c2bRegisterError`);
      const orgId = currentOrgId();
      setImmediate(() => {
        const run = () => svc.runRegistration(actor);
        (orgId ? withOrg(orgId, run) : run()).catch((e) => console.error('money in registration failed', e instanceof Error ? e.name : 'error'));
      });
      return svc.status();
    },

    async runRegistration(actor) {
      const env = await mode();
      const s = await deps.settings.getMany(['public.url', 'org.nominatedNumber']);
      const finish = async (error: string | null) => {
        await deps.settings.delete(`env.${env}.c2bRegisterStartedAt`);
        if (error) await deps.settings.set(`env.${env}.c2bRegisterError`, error.slice(0, 600));
        else await deps.settings.delete(`env.${env}.c2bRegisterError`);
        await deps.events.publish('money_in.updated', { environment: env, ok: !error });
      };
      try {
        const urls = callbackUrls(s['public.url'] ?? '', await currentCallbackSecret(deps.orgs));
        const client = await deps.daraja.get();
        // Safaricom keeps the first registration and answers the repeat as a success, so pressing
        // the button again is safe; the timestamp records the latest confirmation either way.
        try {
          await client.c2b.registerUrls({ confirmationUrl: urls.c2bConfirm, validationUrl: urls.c2bValidate, responseType: 'Completed' });
          await deps.settings.set(`env.${env}.c2bAlreadyRegistered`, 'false');
        } catch (e) {
          // A production paybill takes one registration; Safaricom refuses the next with this text.
          // The addresses on record are then most likely this studio's own (a first press whose
          // reply was lost), so it counts as registered, with the caveat shown on the page.
          if (!(e instanceof DarajaAPIError) || !/already registered/i.test(syncRejection(e).desc)) throw e;
          await deps.settings.set(`env.${env}.c2bAlreadyRegistered`, 'true');
        }
        await deps.settings.set(`env.${env}.c2bRegisteredAt`, new Date().toISOString());
        await client.pull.registerUrl({ nominatedNumber: s['org.nominatedNumber'] ?? '', callbackUrl: urls.pull });
        await deps.settings.set(`env.${env}.pullRegisteredAt`, new Date().toISOString());
        await audit(deps.db, { personId: actor.personId, action: 'money_in.registered', after: { environment: env }, ip: actor.ip });
        await finish(null);
      } catch (e) {
        let message: string;
        try { threeLines(e); message = 'Something went wrong on our side.'; } catch (h) {
          const he = h as HttpError;
          const d = he.details as { safaricomSaid?: string; meaning?: string; whatToDo?: string } | undefined;
          message = d?.safaricomSaid ? [d.safaricomSaid, d.meaning, d.whatToDo].filter(Boolean).join('\n') : he.message;
        }
        console.error('money in registration failed', env, e instanceof Error ? e.name : 'error');
        await finish(message);
      }
    },

    async checkMissed() {
      const env = await mode();
      if (!(await deps.settings.get(`env.${env}.pullRegisteredAt`))) throw new HttpError(409, 'not_registered', NOT_REGISTERED);
      const client = await deps.daraja.get();
      const end = new Date(); const start = new Date(end.getTime() - 48 * 3_600_000);
      let found = 0;
      try {
        for (let offset = 0; offset < 5000; offset += PULL_PAGE) {
          const page = await client.pull.query({ startDate: eatStamp(start), endDate: eatStamp(end), offset });
          for (const t of page.transactions) {
            const p = pulledToPayment(t);
            if (!p) continue;
            if ((await recordC2b({ db: deps.db, events: deps.events, cache: deps.cache }, p, 'poll')).verdict === 'applied') found += 1;
          }
          if (page.transactions.length < PULL_PAGE) break;
        }
      } catch (e) { threeLines(e); }
      const checkedAt = new Date().toISOString();
      await deps.settings.set(`env.${env}.pullCheckedAt`, checkedAt);
      return { found, checkedAt };
    },
    async checkMissedIfRegistered() {
      const env = await mode();
      if (!(await deps.settings.get(`env.${env}.pullRegisteredAt`))) return;
      await svc.checkMissed();
    },
  };
  return svc;
}
