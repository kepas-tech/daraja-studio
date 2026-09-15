import { DarajaAPIError, DarajaAuthError, DarajaConnectionError, type C2bPayment } from '@kepas/daraja-js';
import type { Db } from '../db/pool.js';
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
export interface MoneyInView { mode: Env; c2bRegisteredAt: string | null; pullRegisteredAt: string | null; pullCheckedAt: string | null; nominatedNumber: string | null; publicVerified: boolean }
export interface MoneyInService {
  status(): Promise<MoneyInView>;
  register(actor: Actor): Promise<MoneyInView>;
  checkMissed(): Promise<{ found: number; checkedAt: string }>;
  /** The hourly job: nothing to do until the owner has registered. */
  checkMissedIfRegistered(): Promise<void>;
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
  return {
    transactionType: s('transactiontype') || s('TransactionType') || 'Pay Bill', transId, transTime: date.replace(/[^0-9]/g, '').slice(0, 14), amount,
    shortCode: s('shortcode') || s('BusinessShortCode'), billRefNumber: s('billreference') || s('BillRefNumber'), invoiceNumber: '', thirdPartyTransId: '',
    msisdn: s('msisdn') || s('MSISDN'), firstName: s('sender') || s('FirstName'), middleName: '', lastName: '',
  };
}

/**
 * Money that arrives without a request from us. Nothing here spends an allowance, needs an
 * operator or is polled by the sweep: the only calls are the one-time registrations and the
 * read-only pull that backfills a confirmation Safaricom never delivered.
 */
export function createMoneyInService(deps: { db: Db; settings: Settings; daraja: DarajaFactory; events: EventHub; orgs: OrgService }): MoneyInService {
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
      const s = await deps.settings.getMany([`env.${env}.c2bRegisteredAt`, `env.${env}.pullRegisteredAt`, `env.${env}.pullCheckedAt`, 'org.nominatedNumber', 'public.verifiedAt']);
      return { mode: env, c2bRegisteredAt: s[`env.${env}.c2bRegisteredAt`], pullRegisteredAt: s[`env.${env}.pullRegisteredAt`], pullCheckedAt: s[`env.${env}.pullCheckedAt`], nominatedNumber: s['org.nominatedNumber'], publicVerified: !!s['public.verifiedAt'] };
    },
    async register(actor) {
      const env = await mode();
      const s = await deps.settings.getMany(['public.url', 'public.verifiedAt', 'org.nominatedNumber']);
      if (!s['public.url'] || !s['public.verifiedAt']) throw new HttpError(409, 'public_url_unverified', PUBLIC_URL_UNVERIFIED);
      if (!s['org.nominatedNumber']) throw new HttpError(409, 'no_nominated_number', NO_NOMINATED);
      const urls = callbackUrls(s['public.url'], await currentCallbackSecret(deps.orgs));
      const client = await deps.daraja.get();
      try {
        // Safaricom keeps the first registration and answers the repeat as a success, so pressing
        // the button again is safe; the timestamp records the latest confirmation either way.
        await client.c2b.registerUrls({ confirmationUrl: urls.c2bConfirm, validationUrl: urls.c2bValidate, responseType: 'Completed' });
        await deps.settings.set(`env.${env}.c2bRegisteredAt`, new Date().toISOString());
        await client.pull.registerUrl({ nominatedNumber: s['org.nominatedNumber'], callbackUrl: urls.pull });
        await deps.settings.set(`env.${env}.pullRegisteredAt`, new Date().toISOString());
      } catch (e) { threeLines(e); }
      await audit(deps.db, { personId: actor.personId, action: 'money_in.registered', after: { environment: env }, ip: actor.ip });
      return svc.status();
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
            if ((await recordC2b(deps, p, 'poll')).verdict === 'applied') found += 1;
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
