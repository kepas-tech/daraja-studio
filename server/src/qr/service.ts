import { DarajaAPIError, DarajaAuthError, DarajaConnectionError } from '@kepas/daraja-js';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { audit } from '../audit/log.js';
import { explain } from '../sdk/meaning.js';
import { HttpError } from '../util/errors.js';
import { resolveAccount } from '../businesses/lookup.js';

const inputSchema = z.object({
  accountReference: z.string().trim().min(1).max(32),
  amountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  trxCode: z.enum(['PB', 'BG']),
  /** Brief 2, item 1: a saved account. When it is named, its full number is the reference in the code. */
  accountId: z.string().uuid().optional(),
}).strict();

const failure = (code: string, said: string, meaning: string, whatToDo: string, status = 502) =>
  new HttpError(status, code, meaning, { safaricomSaid: said, meaning, whatToDo });
const malformed = () => failure('qr_bad_response', 'No usable QR image was returned.',
  'Studio could not read the QR response.', 'Try generating the code again. If this continues, contact Safaricom API support.');

// Only a bounded PNG can become an image/download. Never accept URLs, HTML or SVG from upstream.
function pngDataUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw malformed();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(16) > 2048
    || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 2048
    || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') throw malformed();
  return `data:image/png;base64,${value}`;
}

export function createQrService(deps: Pick<AppDeps, 'db' | 'daraja'>) {
  async function context() {
    const client = await deps.daraja.get();
    const [org] = await deps.db.query<{ name: string }>('SELECT name FROM orgs WHERE id=app_current_org()');
    if (!org) throw new HttpError(404, 'org_missing', 'This organisation could not be found.');
    return { client, merchantName: org.name, shortcode: client.config.shortcode, environment: client.config.environment };
  }
  return {
    async details() {
      const { merchantName, shortcode, environment } = await context();
      return { merchantName, shortcode, environment };
    },
    async generate(body: unknown, actor: { personId: string; ip: string }) {
      const parsed = inputSchema.safeParse(body);
      if (!parsed.success) throw failure('qr_invalid', 'No request was sent to Safaricom.',
        'Enter a reference of 1–32 characters, a valid amount, and Pay Bill or Buy Goods.', 'Check the fields and try again.', 400);
      const input = parsed.data;
      // Brief 2, item 1: a picked account decides the reference itself, so the code the payer scans
      // carries the full account number and the payment sorts itself when it arrives.
      const picked = input.accountId ? await resolveAccount(deps.db, input.accountId) : null;
      const accountReference = picked ? picked.fullNumber : input.accountReference;
      const { client, ...details } = await context();
      let answer;
      try {
        answer = await client.qr.generate({ accountReference, amount: input.amountCents / 100,
          trxCode: input.trxCode, size: 400, merchantName: details.merchantName });
      } catch (e) {
        if (e instanceof DarajaAPIError) {
          const raw = e.raw && typeof e.raw === 'object' ? e.raw as Record<string, unknown> : {};
          const code = raw.ResponseCode ?? raw.errorCode ?? e.resultCode;
          const desc = raw.ResponseDescription ?? raw.errorMessage ?? e.resultDesc;
          if ((typeof code === 'string' || typeof code === 'number') && typeof desc === 'string') {
            const ex = explain('qr', code, desc);
            throw failure('safaricom_rejected', ex.safaricomSaid, ex.meaning, ex.whatToDo);
          }
          throw malformed();
        }
        if (e instanceof DarajaAuthError) throw failure('qr_auth', 'Safaricom refused the app credentials.',
          'The app could not sign in to Safaricom.', 'Ask the owner to test the Daraja credentials in Settings.');
        if (e instanceof DarajaConnectionError) throw failure('qr_unreachable', 'No response was received from Safaricom.',
          'Studio could not reach the QR service.', 'Check the connection and try again.');
        throw malformed();
      }
      if (!answer || answer.responseCode !== '00') throw malformed();
      const imageUrl = pngDataUrl(answer.qrCode);
      await audit(deps.db, { ...actor, action: 'qr.generated', after: { amountCents: input.amountCents, trxCode: input.trxCode } });
      return { ...details, ...input, accountReference, imageUrl };
    },
  };
}
