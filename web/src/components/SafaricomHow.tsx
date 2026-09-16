import { Icon } from './Icon';
import { copy } from '../copy/en';
import type { GuideLink } from '../copy/guide';

const ARROW = ' → ';

/**
 * "Where to get it": a button to the Safaricom page and, under it, the clicks once there as a
 * trail (a → b → c). The same data feeds the manual, so a form's hint and the guide never differ.
 */
export function SafaricomHow({ links, title = copy.guidePage.whereToGet }: { links: GuideLink[]; title?: string | null }) {
  return (
    <div className="space-y-2" data-testid="safaricom-how">
      {title && <p className="text-sm font-semibold">{title}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {links.map((l) => {
          const external = !l.href.startsWith('mailto:');
          return (
            <div key={l.href + l.label} className="rounded-md border border-line bg-page p-3">
              <a href={l.href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined} className="inline-flex items-center gap-2 font-semibold">
                {l.label}<Icon name="external-link" className="size-4" />
              </a>
              <p className="mt-1 text-sm text-muted">{copy.guidePage.then} {l.trail.join(ARROW)}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
