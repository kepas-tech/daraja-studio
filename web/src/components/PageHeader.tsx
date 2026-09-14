import { copy } from '../copy/en';

export function PageHeader({ title, safaricom, children }: { title: string; safaricom?: string | null; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between">
      <div><h1 className="text-2xl font-semibold">{title}</h1>{safaricom && <p className="text-sm text-gray-500">{copy.pageHeader.safaricomPrefix}{safaricom}</p>}</div>
      {children}
    </div>
  );
}
