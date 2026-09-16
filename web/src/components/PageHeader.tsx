import { copy } from '../copy/en';

export function PageHeader({ title, safaricom, subtitle, children }: { title: string; safaricom?: string | null; /** A plain line under the title, no Safaricom prefix. */ subtitle?: string | null; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
      <div><h1 className="text-2xl font-semibold text-ink">{title}</h1>{subtitle && <p className="text-sm text-muted">{subtitle}</p>}{safaricom && <p className="text-sm text-muted">{copy.pageHeader.safaricomPrefix}{safaricom}</p>}</div>
      {children}
    </div>
  );
}
