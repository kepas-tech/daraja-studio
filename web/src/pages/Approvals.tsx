import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api/client';
import { useEvents } from '../api/events';
import { useSession } from '../app/session';
import type { Page, RequestView } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { TextField } from '../components/TextField';
import { useToast } from '../components/Toast';
import { copy } from '../copy/en';
import { money, phone, when } from '../format';
import { useStepUp } from './settings/useStepUp';

/**
 * Held sends, for the second pair of eyes. Release asks for the password (money leaves);
 * Refuse asks for a reason (nothing leaves, but the maker deserves to know why).
 */
export function Approvals() {
  const toast = useToast();
  const { person } = useSession();
  const stepUp = useStepUp();
  const c = copy.approvals;
  const [items, setItems] = useState<RequestView[] | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [refusing, setRefusing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<Page<RequestView>>('/api/approvals').then((p) => setItems(p.items)), []);
  useEffect(() => { load().catch((e) => setErr(explainApiError(e))); }, [load]);
  useEvents(useCallback((e) => { if (e.type === 'request.updated') void load().catch(() => {}); }, [load]));

  const release = (r: RequestView) => stepUp.ask(c.confirmRelease(money(r.amountCents)), async (password) => {
    await api.post(`/api/approvals/${r.id}/release`, { password });
    toast.success(c.released);
    await load();
  });
  const refuse = async (r: RequestView) => {
    setBusy(true); setErr(null);
    try { await api.post(`/api/approvals/${r.id}/refuse`, { reason: reason.trim() }); toast.success(c.refused); setRefusing(null); setReason(''); await load(); }
    catch (e) { setErr(e instanceof ApiError ? explainApiError(e) : new Error(copy.error.generic)); }
    finally { setBusy(false); }
  };

  if (!items) return <><PageHeader title={c.title} safaricom={c.safaricom} />{err ? <ErrorCard error={err} /> : <Loading />}</>;
  return (
    <>
      <PageHeader title={c.title} safaricom={c.safaricom} />
      <p className="mb-4 text-base text-muted">{c.intro}</p>
      <ErrorCard error={err} />
      {items.length === 0 ? <Card bodyClassName="p-4"><p className="text-base text-muted">{c.empty}</p></Card> : (
        <div className="space-y-4">
          {items.map((r) => {
            const own = r.createdBy?.id === person?.id;
            return (
              <Card key={r.id} title={money(r.amountCents)} actions={<span className="text-sm text-muted">{when(r.createdAt)}</span>} bodyClassName="space-y-3 p-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
                  <dt className="text-muted">{copy.request.to}</dt><dd><Link to={`/requests/${r.id}`}>{phone(r.recipient.value)}</Link>{r.recipient.name && <span className="block text-sm text-muted">{r.recipient.name}</span>}</dd>
                  {r.category && <><dt className="text-muted">{copy.request.category}</dt><dd>{r.category}</dd></>}
                  {r.remarks && <><dt className="text-muted">{copy.send.phone.remarks}</dt><dd>{r.remarks}</dd></>}
                  <dt className="text-muted">{c.madeBy}</dt><dd>{r.createdBy?.displayName ?? '—'}</dd>
                </dl>
                {own ? <p className="text-sm text-muted">{c.own}</p> : refusing === r.id ? (
                  <div className="space-y-2">
                    <TextField label={c.reason} hint={c.reasonHint} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                    <div className="flex flex-wrap gap-2">
                      <Button variant="danger" disabled={busy || reason.trim().length === 0} onClick={() => void refuse(r)}>{c.refuse}</Button>
                      <Button variant="secondary" onClick={() => { setRefusing(null); setReason(''); }}>{copy.confirm.cancel}</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => release(r)}>{c.release}</Button>
                    <Button variant="secondary" onClick={() => { setRefusing(r.id); setReason(''); }}>{c.refuse}</Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
