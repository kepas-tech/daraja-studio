import type { ReactNode } from 'react';
import { StatusPill } from './StatusPill';
import { ErrorCard } from './ErrorCard';
import { PartyLine, partyWord } from './PartyLine';
import { copy } from '../copy/en';
import { money, when } from '../format';
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
        {/* Round 3, phase A: the person leads and the number sits under them, and the row's own
            direction says whether that person is the payer or the one paid. */}
        <dt className="text-muted">{partyWord(r)}</dt>
        <dd><PartyLine r={r} /></dd>
        {r.category && <><dt className="text-muted">{copy.request.category}</dt><dd>{r.category}</dd></>}
        {r.receipt && <><dt className="text-muted">{copy.request.receipt}</dt><dd><code>{r.receipt}</code></dd></>}
        <dt className="text-muted">{copy.request.when}</dt>
        <dd>{when(r.resultAt ?? r.sentAt ?? r.createdAt)}</dd>
        {r.remarks && <><dt className="text-muted">{copy.send.phone.remarks}</dt><dd>{r.remarks}</dd></>}
      </dl>
      {r.status === 'sent' && <p className="text-base text-muted">{copy.request.waiting}</p>}
      {r.status === 'awaiting_approval' && <p className="text-base text-muted">{copy.request.held}</p>}
      {r.status === 'rejected' && r.approvedBy && <p className="text-sm text-muted">{copy.request.decidedBy(r.approvedBy.displayName)}{r.meaning ? `: ${r.meaning}` : ''}</p>}
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
