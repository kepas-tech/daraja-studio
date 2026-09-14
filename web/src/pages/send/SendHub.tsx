import { Link } from 'react-router';
import { PageHeader } from '../../components/PageHeader';
import { copy } from '../../copy/en';

export function SendHub() {
  return (
    <>
      <PageHeader title={copy.send.title} safaricom={copy.send.safaricom} />
      <p className="mb-6 text-base text-gray-600 dark:text-gray-400">{copy.send.hubIntro}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {copy.send.kinds.map((k) => (
          <article key={k.key} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            {k.live
              ? <Link to={k.path} className="text-lg font-semibold text-emerald-800 underline dark:text-emerald-300">{k.label}</Link>
              : <span className="text-lg font-semibold text-gray-500 dark:text-gray-400">{k.label}</span>}
            <p className="text-sm text-gray-500 dark:text-gray-400">{copy.pageHeader.safaricomPrefix}{k.safaricom}</p>
            {!k.live && <p className="mt-1 text-sm text-gray-500">{copy.send.later}</p>}
          </article>
        ))}
      </div>
    </>
  );
}
