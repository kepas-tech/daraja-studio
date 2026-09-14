import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AssignableRole, PersonView } from '../api/types';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/StatusPill';
import { PasswordConfirmDialog } from '../components/PasswordConfirmDialog';
import { ErrorCard, explainApiError, type Explained } from '../components/ErrorCard';
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
  if (!people) return <p>{copy.app.loading}</p>;

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
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">{copy.people.intro}</p>
      <ErrorCard error={err} />

      {handOver && (
        <div role="status" className="mb-6 space-y-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4 dark:bg-emerald-950/30">
          <p>{copy.people.tellThem}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">{copy.people.shownOnce}</p>
          <p><strong>{handOver.username}</strong></p>
          <code className="block break-all rounded bg-white p-2 text-lg dark:bg-gray-900">{handOver.password}</code>
          <Button variant="secondary" onClick={() => setHandOver(null)}>{copy.people.gotIt}</Button>
        </div>
      )}

      {adding && (
        <form className="mb-6 space-y-3 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950" onSubmit={(e) => { e.preventDefault(); addPerson(); }}>
          <h2 className="text-lg font-semibold">{copy.people.addTitle}</h2>
          <TextField label={copy.people.displayName} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoFocus />
          <TextField
            label={copy.people.usernameSingle}
            type="text"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            autoComplete="off"
          />
          <label className="block">
            <span className="mb-1 block text-base">{copy.people.role}</span>
            <select className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base dark:border-gray-700 dark:bg-gray-900" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AssignableRole })}>
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

      {people.length <= 1 && !adding && <p className="mb-4">{copy.people.empty}</p>}
      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-950">
        {people.map((p) => (
          <li key={p.id} data-testid={`person-${p.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="flex flex-col">
              <span className="text-base font-medium">{p.displayName}</span>
              <span className="text-sm text-gray-500">{p.username}</span>
              <span className="text-sm text-gray-500">{p.lastLoginAt ? copy.people.lastLogin(when(p.lastLoginAt)) : copy.people.neverLoggedIn}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {p.status === 'suspended' && <StatusPill kind="muted">{copy.people.suspended}</StatusPill>}
              {p.mustChangePassword && <StatusPill kind="warn">{copy.people.mustChange}</StatusPill>}
              {p.isOwner ? (
                <>
                  <StatusPill kind="ok">{copy.people.roles.owner}</StatusPill>
                  <span className="text-sm text-gray-500">{copy.people.ownerNote}</span>
                </>
              ) : (
                <>
                  <select
                    aria-label={copy.people.roleFor(p.displayName)}
                    className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
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

      <PasswordConfirmDialog {...stepUp.dialogProps} />
    </>
  );
}
