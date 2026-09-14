import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AssignableRole, PersonView } from '../api/types';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
import { Card, cardRow } from '../components/Card';
import { Flash } from '../components/Flash';
import { Loading } from '../components/Loading';
import { useToast } from '../components/Toast';
import { useStepUp } from './settings/useStepUp';
import { copy } from '../copy/en';
import { when } from '../format';

/** No 0/O/1/l/i: this gets read out over the phone (spec 5.3). */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const LENGTH = 16;

export function suggestPassword(): string {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const ROLES: AssignableRole[] = ['operator', 'viewer', 'custom'];

export function People() {
  const toast = useToast();
  const stepUp = useStepUp();
  const [people, setPeople] = useState<PersonView[] | null>(null);
  const [err, setErr] = useState<Error | Explained | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ displayName: '', username: '', role: 'viewer' as AssignableRole, temporaryPassword: suggestPassword() });
  // Shown once, then dropped. Nothing re-fetches it: the server never returns it again.
  const [handOver, setHandOver] = useState<{ username: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try { setPeople(await api.get<PersonView[]>('/api/people')); setErr(null); }
    catch (e) { setErr(explainApiError(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (err && !people) return <><PageHeader title={copy.people.title} safaricom={copy.people.safaricom} /><ErrorCard error={err} /></>;
  if (!people) return <Loading />;

  const addPerson = () => stepUp.ask(copy.people.confirm.add(form.displayName || form.username), async (password) => {
    await api.post<PersonView>('/api/people', {
      displayName: form.displayName.trim(),
      username: form.username.trim().toLowerCase(),
      role: form.role,
      temporaryPassword: form.temporaryPassword,
      password,
    });
    setHandOver({ username: form.username.trim().toLowerCase(), password: form.temporaryPassword });
    setAdding(false);
    setForm({ displayName: '', username: '', role: 'viewer', temporaryPassword: suggestPassword() });
    await load();
  });

  const changeRole = (p: PersonView, role: AssignableRole) => stepUp.ask(copy.people.confirm.role(p.displayName), async (password) => {
    await api.put(`/api/people/${p.id}/role`, { role, password });
    toast.success(copy.settings.saved);
    await load();
  });

  const reset = (p: PersonView) => {
    const temporaryPassword = suggestPassword();
    stepUp.ask(copy.people.confirm.reset(p.displayName), async (password) => {
      await api.post(`/api/people/${p.id}/reset-password`, { temporaryPassword, password });
      setHandOver({ username: p.username, password: temporaryPassword });
      await load();
    });
  };

  const setActive = (p: PersonView, on: boolean) => stepUp.ask(
    on ? copy.people.confirm.resume(p.displayName) : copy.people.confirm.suspend(p.displayName),
    async (password) => {
      await api.post(`/api/people/${p.id}/${on ? 'resume' : 'suspend'}`, { password });
      await load();
    },
  );

  return (
    <>
      <PageHeader title={copy.people.title} safaricom={copy.people.safaricom}>
        {!adding && <Button onClick={() => setAdding(true)}>{copy.people.add}</Button>}
      </PageHeader>
      <ErrorCard error={err} />

      {handOver && (
        <Flash tone="success" role="status" className="mb-6">
          <p className="font-semibold">{handOver.username}</p>
          <code className="block break-all rounded-md bg-surface p-2 text-lg">{handOver.password}</code>
          <p className="text-sm text-muted">{copy.people.tellThem} {copy.people.shownOnce}</p>
          <div className="pt-1"><Button variant="secondary" onClick={() => setHandOver(null)}>{copy.people.gotIt}</Button></div>
        </Flash>
      )}

      {adding && (
        <form className="mb-6 space-y-3 rounded-md border border-line bg-surface p-5" onSubmit={(e) => { e.preventDefault(); addPerson(); }}>
          <h2 className="text-base font-semibold">{copy.people.addTitle}</h2>
          <TextField label={copy.people.displayName} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoFocus />
          <TextField
            label={copy.people.usernameSingle}
            type="text"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            autoComplete="off"
          />
          <label className="block">
            <span className="mb-1 block text-base font-semibold">{copy.people.role}</span>
            <select className="min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AssignableRole })}>
              {ROLES.map((r) => <option key={r} value={r} disabled={r === 'custom'}>{copy.people.roles[r]}</option>)}
            </select>
          </label>
          <TextField label={copy.people.temporaryPassword} value={form.temporaryPassword} onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })} autoComplete="off" />
          <div className="flex gap-2">
            <Button type="submit" disabled={!form.displayName.trim() || !form.username.trim() || form.temporaryPassword.length < 12}>{copy.people.addButton}</Button>
            <Button type="button" variant="secondary" onClick={() => setForm({ ...form, temporaryPassword: suggestPassword() })}>{copy.people.regenerate}</Button>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>{copy.people.cancel}</Button>
          </div>
        </form>
      )}

      {people.length <= 1 && !adding && <p className="mb-4 text-sm text-muted">{copy.people.empty}</p>}
      <Card bodyClassName="p-0">
      <ul>
        {people.map((p) => (
          <li key={p.id} data-testid={`person-${p.id}`} className={`${cardRow} flex flex-wrap items-center justify-between gap-3`}>
            <span className="flex flex-col">
              <span className="text-base font-medium">{p.displayName}</span>
              <span className="text-sm text-muted">{p.username}</span>
              <span className="text-sm text-muted">{p.lastLoginAt ? copy.people.lastLogin(when(p.lastLoginAt)) : copy.people.neverLoggedIn}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {p.status === 'suspended' && <StatusPill kind="muted">{copy.people.suspended}</StatusPill>}
              {p.mustChangePassword && <StatusPill kind="warn">{copy.people.mustChange}</StatusPill>}
              {p.isOwner ? (
                <>
                  <StatusPill kind="ok">{copy.people.roles.owner}</StatusPill>
                  <span className="text-sm text-muted">{copy.people.ownerNote}</span>
                </>
              ) : (
                <>
                  <select
                    aria-label={copy.people.roleFor(p.displayName)}
                    className="min-h-10 rounded-md border border-line bg-surface px-2 text-sm text-ink"
                    value={p.role}
                    onChange={(e) => changeRole(p, e.target.value as AssignableRole)}
                  >
                    {ROLES.map((r) => <option key={r} value={r} disabled={r === 'custom'}>{copy.people.roles[r]}</option>)}
                  </select>
                  <Button variant="secondary" onClick={() => reset(p)}>{copy.people.reset}</Button>
                  {p.status === 'active'
                    ? <Button variant="secondary" onClick={() => setActive(p, false)}>{copy.people.suspend}</Button>
                    : <Button onClick={() => setActive(p, true)}>{copy.people.resume}</Button>}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      </Card>

      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
