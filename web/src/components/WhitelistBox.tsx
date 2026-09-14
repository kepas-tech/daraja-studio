import { copy } from '../copy/en';

/**
 * Spec 4.6. Shown on the operator step of a **production** sign-up and anywhere else a hosted
 * organisation has to be told the address. Renders nothing when this service has no egress address
 * to name — a self-hosted install's server is the tenant's own, and there is nothing to whitelist.
 */
export function WhitelistBox({ egressIps, shortcode }: { egressIps: string[]; shortcode: string | null }) {
  if (egressIps.length === 0) return null;
  return (
    <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:bg-amber-950/30">
      <h3 className="font-semibold">{copy.whitelist.title}</h3>
      <p>
        {copy.whitelist.before}{' '}
        {egressIps.map((ip) => <strong key={ip} className="mr-2 break-all">{ip}</strong>)}
      </p>
      <p>{shortcode ? copy.whitelist.ask(shortcode) : copy.whitelist.askNoShortcode}</p>
      <p>{copy.whitelist.until}</p>
      <p className="text-gray-600 dark:text-gray-400">{copy.whitelist.sandbox}</p>
    </section>
  );
}
