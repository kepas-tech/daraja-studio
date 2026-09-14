import { copy } from '../copy/en';

export function PageHeader({ title, safaricom, children }: { title: string; safaricom?: string | null; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
      <div><h1 className="text-2xl font-semibold text-ink">{title}</h1>{safaricom && <p className="text-sm text-muted">{copy.pageHeader.safaricomPrefix}{safaricom}</p>}</div>
      {children}
    </div>
  );
}
