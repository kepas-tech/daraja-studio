import { Link } from 'react-router';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { copy } from '../copy/en';

/**
 * The destinations used rarely or set up once, in one place, grouped as the menu groups them.
 * Every card opens the real page; nothing here is a copy of it.
 */
export function Advanced() {
  const c = copy.advancedPage;
  // Round 3, phase E: Manage joins the two money groups, which is where the developer side lives.
  const groups = (['in', 'out', 'manage'] as const).map((g) => ({ g, items: copy.nav.filter((e) => e.available && e.advanced && e.group === g) })).filter((x) => x.items.length > 0);
  return (
    <>
      <PageHeader title={copy.advancedPage.title} subtitle={c.intro} />
      <div className="space-y-8">
        {groups.map(({ g, items }) => (
          <section key={g} aria-labelledby={`advanced-${g}`}>
            <h2 id={`advanced-${g}`} className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{copy.nav.groups[g]}</h2>
            <ul className="grid gap-4 md:grid-cols-2">
              {items.map((e) => (
                <li key={e.key}>
                  <Link to={e.path} className="flex h-full items-start gap-4 rounded-md border border-line bg-surface p-5 text-ink hover:border-brand hover:no-underline">
                    <Icon name={e.icon} className="mt-0.5 size-7 shrink-0 text-brand" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-lg font-semibold">{e.label}</span>
                      <span className="block text-base text-muted">{c.blurbs[e.key] ?? ''}</span>
                      {e.safaricom && <span className="mt-1 block text-xs text-muted">{copy.pageHeader.safaricomPrefix}{e.safaricom}</span>}
                    </span>
                    <Icon name="chevron-right" className="mt-1 size-5 shrink-0 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
