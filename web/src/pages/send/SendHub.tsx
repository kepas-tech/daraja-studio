import { Link } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { copy } from '../../copy/en';

export function SendHub() {
  return (
    <>
      <PageHeader title={copy.send.title} safaricom={copy.send.safaricom} />
      <p className="mb-6 text-base text-muted">{copy.send.hubIntro}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {copy.send.kinds.map((k) => (
          <article key={k.key} className="rounded-md border border-line bg-surface p-4">
            {k.live
              ? <Link to={k.path} className="text-lg font-semibold text-brand-dark underline">{k.label}</Link>
              : <span className="text-lg font-semibold text-muted">{k.label}</span>}
            <p className="text-sm text-muted">{copy.pageHeader.safaricomPrefix}{k.safaricom}</p>
            {!k.live && <p className="mt-1 text-sm text-muted">{copy.send.later}</p>}
          </article>
        ))}
      </div>
    </>
  );
}
