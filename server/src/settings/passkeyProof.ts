import type { AppDeps } from '../app.js';
import { audit } from '../audit/log.js';
import { HttpError } from '../util/errors.js';
import type { Env } from './store.js';

/**
 * The one proof a passkey can have: no read-only Daraja call exercises it, so the only evidence it
 * is right is Safaricom accepting a push made with it. A wrong one is refused at the acknowledgement,
 * before any phone rings, so this is safe: a failure costs nothing and a success can be cancelled on
 * the owner's own handset. Shared by the setup wizard and the Go live flow so the two never differ.
 *
 * The push goes through the environment in use, so `env` must be that environment; proving a
 * passkey for the other one would test it against the wrong Safaricom.
 */
export async function provePasskey(
  deps: Pick<AppDeps, 'settings' | 'settingsService' | 'collect' | 'db'>,
  env: Env,
  input: { passkey: string; phone: string },
  actor: { personId: string; ip: string },
  action: 'setup.passkey' | 'settings.passkey_prove',
): Promise<{ proven: boolean; requestId: string }> {
  const current = ((await deps.settings.get('daraja.environment')) as Env) ?? 'sandbox';
  if (current !== env) throw new HttpError(409, 'wrong_mode', `Switch to ${env === 'production' ? 'Production' : 'Sandbox'} first; the test prompt goes through the mode in use.`);
  await deps.settingsService.setPasskey(env, input.passkey, actor);
  const v = await deps.collect.askToPay(
    { phone: input.phone, amountCents: 100, accountReference: 'SETUP', description: 'Studio test', confirmDuplicate: true },
    actor,
  );
  const proven = !!(await deps.settings.get(`env.${env}.passkeyProvenAt`));
  await audit(deps.db, { personId: actor.personId, action, ip: actor.ip, after: { proven } });
  return { proven, requestId: v.id };
}
