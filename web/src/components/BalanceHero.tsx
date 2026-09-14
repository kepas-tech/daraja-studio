import type { ReactNode } from 'react';
import { Card } from './Card';
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
export function BalanceHero({ balance, action, children, className = '' }: { balance: BalanceView | null | undefined; action?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <Card className={className} bodyClassName="p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid flex-1 gap-6 sm:grid-cols-2">
          <Figure label={copy.balances.utility} hint={copy.balances.utilityHint} cents={balance?.utilityCents} />
          <Figure label={copy.balances.working} hint={copy.balances.workingHint} cents={balance?.workingCents} />
        </div>
        {action}
      </div>
      <p className="mt-4 text-sm text-muted">{balance ? copy.balances.asOf(when(balance.queriedAt)) : copy.balances.never}</p>
      {children}
    </Card>
  );
}
