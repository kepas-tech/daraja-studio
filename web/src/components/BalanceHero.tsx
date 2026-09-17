import type { ReactNode } from 'react';
import { Card } from './Card';
import { Flash } from './Flash';
import { copy } from '../copy/en';
import { money, when } from '../format';
import type { BalanceView } from '../api/types';

function Figure({ label, hint, cents }: { label: string; hint: string; cents: number | null | undefined }) {
  return (
    <div>
      <div className="text-sm text-muted">{label}</div>
      <div className="text-3xl font-semibold">{money(cents)}</div>
      <div className="text-sm text-muted">{hint}</div>
    </div>
  );
}

/** The two numbers the business opens the app for, as big as anything on the page. */
const STALE_MS = 24 * 3600 * 1000;

export function BalanceHero({ balance, action, message, children, className = '' }: { balance: BalanceView | null | undefined; action?: ReactNode; message?: string | null; children?: ReactNode; className?: string }) {
  const stale = balance?.queriedAt ? Date.now() - new Date(balance.queriedAt).getTime() > STALE_MS : false;
  // Feature 9: money on its way out, against the account sends come from. Only a real balance can
  // answer "is there enough", so nothing is drawn while the first read is still in flight.
  const waiting = balance?.waitingCents ?? 0;
  const short = balance != null && balance.utilityCents !== null && waiting > balance.utilityCents;
  return (
    <Card className={className} bodyClassName="p-4 md:p-5">
      {message && <Flash tone="neutral" role="status" className="mb-4">{message}</Flash>}
      {!message && stale && <Flash tone="neutral" role="status" className="mb-4">{copy.balances.stale}</Flash>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid flex-1 gap-6 sm:grid-cols-2">
          <Figure label={copy.balances.utility} hint={copy.balances.utilityHint} cents={balance?.utilityCents} />
          <Figure label={copy.balances.working} hint={copy.balances.workingHint} cents={balance?.workingCents} />
        </div>
        {action}
      </div>
      {balance !== undefined && (
        <p className={`mt-4 text-sm ${short ? 'font-semibold text-danger' : 'text-muted'}`}>
          {balance === null ? copy.home.balanceLine.none : copy.home.balanceLine.line(money(balance.utilityCents), money(waiting))}
        </p>
      )}
      {short && <p className="mt-1 text-sm text-danger">{copy.home.balanceLine.short}</p>}
      <p className="mt-4 text-sm text-muted">{balance ? <>{copy.balances.asOf(when(balance.queriedAt))} · {copy.balances.charges}: {money(balance.chargesPaidCents)}</> : copy.balances.never}</p>
      {children}
    </Card>
  );
}
