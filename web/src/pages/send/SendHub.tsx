import { Link } from 'react-router';
import { Card, cardRow } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { copy } from '../../copy/en';

export function SendHub() {
  const live = copy.send.kinds.filter((k) => k.live);
  const planned = copy.send.kinds.filter((k) => !k.live);
  return (
    <>
      <PageHeader title={copy.send.title} safaricom={copy.send.safaricom} />
      <div className="max-w-xl space-y-6">
        {live.map((k) => (
          <Link key={k.key} to={k.path} className="flex items-center gap-4 rounded-md border border-line bg-surface p-5 text-ink hover:border-brand hover:no-underline">
            <Icon name="arrow-right-circle" className="size-8 text-brand" />
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-semibold">{k.label}</span>
              <span className="block text-sm text-muted">{copy.pageHeader.safaricomPrefix}{k.safaricom}</span>
            </span>
            <Icon name="chevron-right" className="size-5 text-muted" />
          </Link>
        ))}
        <Card title={copy.send.planned} bodyClassName="p-0">
          <ul>
            {planned.map((k) => (
              <li key={k.key} className={`${cardRow} flex items-center justify-between gap-3 text-muted`}>
                <span className="min-w-0"><span className="block">{k.label}</span><span className="block text-xs">{copy.pageHeader.safaricomPrefix}{k.safaricom}</span></span>
                <span className="shrink-0 text-xs">{copy.send.later}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
