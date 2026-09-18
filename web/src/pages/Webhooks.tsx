import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { WebhookSaved, WebhookView } from '../api/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { TextField } from '../components/TextField';
import { copy } from '../copy/en';
import { when } from '../format';

/**
 * Round 3, phase E: the webhook address, under Advanced and out of the way of daily use.
 *
 * One address per organisation, and one secret that signs everything sent to it. The secret is
 * shown once, when it is made or rotated, because the receiver needs it to check the signature;
 * the page keeps only its last four characters so the owner can tell the two apart.
 */
export function Webhooks() {
  const c = copy.webhooks;
  const [hook, setHook] = useState<WebhookView | null>(null);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => api.get<{ webhook: WebhookView }>('/api/webhooks')
    .then((r) => { setHook(r.webhook); setUrl(r.webhook.url ?? ''); })
    .catch((e) => setErr(explainApiError(e))), []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.put<WebhookSaved>('/api/webhooks', { url: url.trim() });
      setHook(r.webhook); setSecret(r.secret);
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };
  const rotate = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.post<WebhookSaved>('/api/webhooks/secret');
      setHook(r.webhook); setSecret(r.secret); setMsg(c.afterRotate);
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.del('/api/webhooks');
      setHook({ url: null, secretHint: null, updatedAt: null }); setUrl(''); setSecret(null); setMsg(c.afterRemove);
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title={c.title} />
      <div className="max-w-2xl space-y-6">
        <p className="text-base text-muted">{c.intro}</p>
        {err && <ErrorCard error={err} />}
        {msg && <Flash tone="success" role="status">{msg}</Flash>}
        {secret && (
          <Flash tone="success" role="status" data-testid="secret-shown-once">
            <p className="font-semibold">{c.shownOnce}</p>
            <p className="mt-1 break-all"><code data-testid="webhook-secret">{secret}</code></p>
            <p className="mt-1 text-sm">{c.signature}</p>
            <div className="pt-2"><Button type="button" onClick={() => setSecret(null)}>{c.gotIt}</Button></div>
          </Flash>
        )}

        {hook === null ? <Loading /> : (
          <Card title={c.address}>
            <div className="space-y-3">
              <TextField label={c.url} value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} hint={c.urlHint} />
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={!url.trim() || busy} onClick={() => void save()}>{hook.url ? c.change : c.save}</Button>
                {hook.url && <Button type="button" variant="secondary" disabled={busy} onClick={() => void rotate()}>{c.newSecret}</Button>}
                {hook.url && <Button type="button" variant="secondary" disabled={busy} onClick={() => void remove()}>{c.remove}</Button>}
              </div>
            </div>
            {hook.url && (
              <p className="mt-3 text-sm text-muted">
                {c.inUse(hook.url, hook.secretHint ?? '', hook.updatedAt ? when(hook.updatedAt) : '')}
              </p>
            )}
          </Card>
        )}

        {hook?.url && (
          <Card title={c.next}>
            <p className="text-base">{c.deliveriesNote}</p>
            <p className="mt-2"><Link to="/webhooks/deliveries">{c.deliveriesLink}</Link></p>
          </Card>
        )}
      </div>
    </>
  );
}
