import type { ReactNode } from 'react';
import { StatusPill } from './StatusPill';
import { ErrorCard } from './ErrorCard';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';
import type { RequestView } from '../api/types';

export const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = { pending: 'muted', sent: 'warn', completed: 'ok', failed: 'bad', unknown: 'warn', cancelled: 'muted', rejected: 'bad', awaiting_approval: 'warn' };

export function RequestCard({ request: r, children }: { request: RequestView; children?: ReactNode }) {
  const label = copy.request.status[r.status] ?? r.status;
  const explained = r.status === 'failed' && r.safaricomSaid && r.meaning && r.whatToDo ? { safaricomSaid: r.safaricomSaid, meaning: r.meaning, whatToDo: r.whatToDo } : null;
  return (
    <section className="space-y-3 rounded-md border border-line bg-surface p-5" aria-label={label}>
      <div className="flex items-center justify-between">
        <span className="text-xl font-semibold">{money(r.amountCents)}</span>
        <StatusPill kind={STATUS_TONE[r.status] ?? 'muted'}>{label}</StatusPill>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
        <dt className="text-muted">{copy.request.to}</dt>
        <dd>{r.recipient.kind === 'phone' ? phone(r.recipient.value) : r.recipient.value ?? '—'}{r.recipient.name && <span className="block text-sm text-muted">{r.recipient.name}</span>}</dd>
        {r.category && <><dt className="text-muted">{copy.request.category}</dt><dd>{r.category}</dd></>}
        {r.receipt && <><dt className="text-muted">{copy.request.receipt}</dt><dd><code>{r.receipt}</code></dd></>}
        <dt className="text-muted">{copy.request.when}</dt>
        <dd>{when(r.resultAt ?? r.sentAt ?? r.createdAt)}</dd>
        {r.remarks && <><dt className="text-muted">{copy.send.phone.remarks}</dt><dd>{r.remarks}</dd></>}
      </dl>
      {r.status === 'sent' && <p className="text-base text-muted">{copy.request.waiting}</p>}
      {explained && <ErrorCard error={explained} />}
      {r.status === 'failed' && !explained && <ErrorCard error={new Error(r.meaning ?? r.safaricomSaid ?? copy.error.generic)} />}
      {r.status === 'unknown' && (
        <div className="space-y-1 rounded-md border border-line bg-page p-3 text-base">
          {r.checked ? (
            <p className="text-sm text-ink">{copy.request.checkedBy(r.checked.by?.displayName ?? '', r.checked.note)}</p>
          ) : (
            <>
              <p>{r.meaning}</p>
              {r.whatToDo && <p>{r.whatToDo}</p>}
            </>
          )}
        </div>
      )}
      {children && <div className="flex flex-wrap gap-2 pt-1">{children}</div>}
    </section>
  );
}
