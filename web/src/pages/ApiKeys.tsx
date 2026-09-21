import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ApiKeyCreated, ApiKeyView, WebhookSaved, WebhookView } from '../api/types';
import { Button } from '../components/Button';
import { Card, cardRow } from '../components/Card';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Flash } from '../components/Flash';
import { Loading } from '../components/Loading';
import { PageHeader } from '../components/PageHeader';
import { TextField } from '../components/TextField';
import { copy } from '../copy/en';
import { when } from '../format';

/**
 * Round 3, phase E: API keys, under Advanced and out of the way of daily use.
 *
 * The whole page turns on one rule: the secret is shown once, when it is made. It is not stored in
 * a readable form anywhere, so a key that is lost is replaced rather than looked up — which is also
 * why Replace shows the new secret in the same panel a brand-new key uses.
 *
 * Step six, part five: a key is also where a person names the address its payments' notices go to,
 * in the same breath as the key itself. The address and its signing secret belong to the key, so one
 * receiver can be set up, changed or stopped without disturbing another. A key with no address of
 * its own uses the organisation's, which is what every key did before there was a choice.
 */
export function ApiKeys() {
  const c = copy.apiKeys;
  const [items, setItems] = useState<ApiKeyView[] | null>(null);
  const [org, setOrg] = useState<WebhookView | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('viewer');
  const [address, setAddress] = useState('');
  // The one moment a secret exists outside the server's hash. Cleared by Done, never re-read.
  const [made, setMade] = useState<{ name: string; secret: string; rotated: boolean } | null>(null);
  // The signing secret that came with an address, shown in the same once-only panel as the key.
  const [madeHook, setMadeHook] = useState<{ url: string; secret: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => api.get<{ items: ApiKeyView[]; organisation: WebhookView }>('/api/keys')
    .then((r) => { setItems(r.items); setOrg(r.organisation ?? null); })
    .catch((e) => { setItems([]); setErr(explainApiError(e)); }), []);
  useEffect(() => { void load(); }, [load]);

  /** What a person sees under a key's name: its own address, or the one it falls back to. */
  const addressLine = (k: ApiKeyView): string => {
    if (k.webhook?.url) return c.ownAddress(k.webhook.url, k.webhook.secretHint);
    return org?.url ? c.inheritsAddress(org.url) : c.inheritsNone;
  };

  const openEditor = (k: ApiKeyView) => {
    if (editing === k.id) { setEditing(null); return; }
    setEditing(k.id);
    setEditUrl(k.webhook?.url ?? '');
  };

  const create = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const body: { name: string; role: string; webhookUrl?: string } = { name: name.trim(), role };
      if (address.trim()) body.webhookUrl = address.trim();
      const r = await api.post<ApiKeyCreated>('/api/keys', body);
      setMade({ name: r.key.name, secret: r.secret, rotated: false });
      setMadeHook(r.webhook?.secret && r.webhook.webhook.url ? { url: r.webhook.webhook.url, secret: r.webhook.secret } : null);
      setName(''); setAddress('');
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };

  const rotate = async (k: ApiKeyView) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.post<ApiKeyCreated>(`/api/keys/${k.id}/rotate`);
      setMade({ name: r.key.name, secret: r.secret, rotated: true });
      setMadeHook(null);
      setMsg(c.afterRotate);
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };

  const revoke = async (k: ApiKeyView) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.post(`/api/keys/${k.id}/revoke`);
      setMsg(c.afterRevoke);
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };

  const saveAddress = async (k: ApiKeyView) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.put<WebhookSaved>(`/api/keys/${k.id}/webhook`, { url: editUrl.trim() });
      if (r.secret && r.webhook.url) setMadeHook({ url: r.webhook.url, secret: r.secret });
      setMsg(c.afterAddress); setEditing(null);
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };

  const newAddressSecret = async (k: ApiKeyView) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.post<WebhookSaved>(`/api/keys/${k.id}/webhook/secret`);
      if (r.secret && r.webhook.url) setMadeHook({ url: r.webhook.url, secret: r.secret });
      setMsg(c.afterAddressSecret);
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };

  const removeAddress = async (k: ApiKeyView) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.del(`/api/keys/${k.id}/webhook`);
      setMsg(c.afterAddressRemoved); setEditing(null);
      await load();
    } catch (e) { setErr(explainApiError(e)); } finally { setBusy(false); }
  };

  const control = 'min-h-10 rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  return (
    <>
      <PageHeader title={c.title} />
      <div className="max-w-2xl space-y-6">
        <p className="text-base text-muted">{c.intro}</p>
        {err && <ErrorCard error={err} />}
        {msg && <Flash tone="success" role="status">{msg}</Flash>}
        {(made || madeHook) && (
          <Flash tone="success" role="status" data-testid="key-shown-once">
            {made && (
              <>
                <p className="font-semibold">{c.shownOnce}</p>
                <p className="mt-1 break-all"><code data-testid="key-secret">{made.secret}</code></p>
              </>
            )}
            {madeHook && (
              <>
                <p className="mt-3 font-semibold">{c.webhookShownOnce(madeHook.url)}</p>
                <p className="mt-1 break-all"><code data-testid="key-webhook-secret">{madeHook.secret}</code></p>
              </>
            )}
            <div className="pt-2"><Button type="button" onClick={() => { setMade(null); setMadeHook(null); }}>{c.gotIt}</Button></div>
          </Flash>
        )}

        <Card title={c.create}>
          <div className="space-y-3">
            <TextField label={c.name} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} hint={c.namePlaceholder} />
            <label className="block text-base">
              <span className="mb-1 block text-sm text-muted">{c.role}</span>
              <select aria-label={c.role} className={control} value={role} onChange={(e) => setRole(e.target.value)}>
                {Object.entries(c.roles).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </label>
            <TextField label={c.addressCreate} value={address} onChange={(e) => setAddress(e.target.value)} hint={c.addressHint} maxLength={500} />
            <Button type="button" disabled={!name.trim() || busy} onClick={() => void create()}>{busy ? c.creating : c.create}</Button>
          </div>
        </Card>

        <Card title={c.list} bodyClassName="p-0">
          {items === null ? <Loading /> : items.length === 0 ? <p className="p-4 text-base text-muted">{c.empty}</p> : (
            <ul>
              {items.map((k) => (
                <li key={k.id} data-testid={'key-' + k.id} className={`${cardRow} flex flex-wrap items-start justify-between gap-3 text-base`}>
                  <span className="min-w-0">
                    <span className="block font-semibold">{k.name}</span>
                    <span className="block text-sm text-muted"><code>{k.prefix}</code> · {c.roles[k.role] ?? k.role}</span>
                    <span className="block text-sm text-muted">
                      {c.created(when(k.createdAt), k.createdBy?.displayName ?? null)}
                      {' · '}{k.lastUsedAt ? c.lastUsed(when(k.lastUsedAt)) : c.neverUsed}
                      {k.rotatedFrom && <> · {c.rotatedFrom}</>}
                    </span>
                    <span className="block text-sm text-muted" data-testid={'key-address-' + k.id}>{addressLine(k)}</span>
                    {k.revokedAt && <span className="block text-sm text-danger">{c.revoked(when(k.revokedAt))}</span>}
                    {editing === k.id && (
                      <span className="mt-3 block w-full max-w-md">
                        <TextField label={c.address} value={editUrl} onChange={(e) => setEditUrl(e.target.value)} hint={c.addressHint} maxLength={500} />
                        <span className="mt-2 flex flex-wrap gap-2">
                          <Button type="button" disabled={busy || !editUrl.trim()} onClick={() => void saveAddress(k)}>{c.addressSave}</Button>
                          {k.webhook && <Button type="button" variant="secondary" disabled={busy} onClick={() => void newAddressSecret(k)}>{c.addressSecret}</Button>}
                          {k.webhook && <Button type="button" variant="secondary" disabled={busy} onClick={() => void removeAddress(k)}>{c.addressRemove}</Button>}
                        </span>
                      </span>
                    )}
                  </span>
                  {!k.revokedAt && (
                    <span className="flex shrink-0 flex-wrap gap-2">
                      <Button type="button" variant="secondary" disabled={busy} onClick={() => openEditor(k)}>{c.addressButton}</Button>
                      <Button type="button" variant="secondary" disabled={busy} onClick={() => void rotate(k)}>{c.rotate}</Button>
                      <Button type="button" variant="secondary" disabled={busy} onClick={() => void revoke(k)}>{c.revoke}</Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
