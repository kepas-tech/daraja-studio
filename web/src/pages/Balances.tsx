import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useEvents } from '../api/events';
import { useBalanceRefresh } from '../api/useBalanceRefresh';
import type { BalanceView } from '../api/types';
import { BalanceHero } from '../components/BalanceHero';
import { Button } from '../components/Button';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { PageHeader } from '../components/PageHeader';
import { copy } from '../copy/en';
import { money } from '../format';

const STALE_MS = 24 * 3600 * 1000;

export function Balances() {
  const [b, setB] = useState<BalanceView | null | undefined>(undefined);
  const [loadErr, setLoadErr] = useState<Error | Explained | null>(null);
  const load = useCallback(() => api.get<BalanceView | null>('/api/balances/latest').then(setB).catch((e) => setLoadErr(explainApiError(e))), []);
  useEffect(() => { void load(); }, [load]);
  const { busy, msg, err, refresh, onEvent, checkPending } = useBalanceRefresh(useCallback(() => { void load(); }, [load]));
  useEvents(onEvent, true, checkPending);
  const stale = b?.queriedAt ? Date.now() - new Date(b.queriedAt).getTime() > STALE_MS : false;
  return (
    <>
      <PageHeader title={copy.balances.title} safaricom={copy.balances.safaricom}>
        <Button type="button" onClick={() => void refresh()} disabled={busy}>{busy ? copy.balances.refreshing : copy.balances.refresh}</Button>
      </PageHeader>
      <div className="space-y-4">
        {msg && <Flash tone="neutral" role="status">{msg}</Flash>}
        <ErrorCard error={err ?? loadErr} />
        {stale && <Flash tone="neutral" role="status">{copy.balances.stale}</Flash>}
        <BalanceHero balance={b}>
          {b && <p className="mt-1 text-sm text-muted">{copy.balances.charges}: {money(b.chargesPaidCents)}</p>}
        </BalanceHero>
      </div>
    </>
  );
}
