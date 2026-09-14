import { PageHeader } from '../components/PageHeader';
import { copy } from '../copy/en';

export function NotPossible() {
  return (
    <>
      <PageHeader title={copy.notPossiblePage.title} />
      <p className="mb-6 text-muted">{copy.notPossiblePage.intro}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {copy.notPossible.map((i) => (
          <article key={i.key} className="space-y-2 rounded-md border border-line bg-surface p-4">
            <h2 className="font-semibold">{i.title}</h2>
            <p className="text-sm">{i.what}</p>
            <p className="text-sm text-muted"><strong>{copy.notPossiblePage.why}</strong> {i.why}</p>
            <p className="text-sm"><strong>{copy.notPossiblePage.where}</strong> {i.portalPath}</p>
            {i.ussd && <p className="text-sm"><strong>{copy.notPossiblePage.phone}</strong> <code>{i.ussd}</code></p>}
            <a className="inline-block text-sm text-brand-dark underline" href="https://org.ke.m-pesa.com" target="_blank" rel="noreferrer">{copy.notPossiblePage.portalLink}</a>
          </article>
        ))}
      </div>
    </>
  );
}
