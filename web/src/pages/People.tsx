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
import { Questionnaire } from '../components/Questionnaire';
import { Segmented } from '../components/Segmented';
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
        <div className="mb-6">
          <Questionnaire doneLabel={copy.people.addButton} onDone={addPerson} onCancel={() => setAdding(false)} intro={copy.people.addTitle} steps={[
            { key: 'name', question: copy.people.displayName, valid: form.displayName.trim().length > 0, render: () => <TextField label={copy.people.displayName} labelHidden value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} autoFocus /> },
            { key: 'username', question: copy.people.usernameSingle, valid: form.username.trim().length > 0, render: () => <TextField label={copy.people.usernameSingle} labelHidden type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" autoFocus /> },
            { key: 'role', question: copy.people.role, valid: true, render: () => <Segmented name="role" label={copy.people.role} value={form.role} options={(['operator', 'viewer'] as AssignableRole[]).map((r) => ({ value: r, label: copy.people.roles[r] }))} onChange={(r) => setForm({ ...form, role: r })} /> },
            { key: 'password', question: copy.people.temporaryPassword, hint: copy.people.tellThem, valid: form.temporaryPassword.length >= 12, render: () => (
              <div className="space-y-2">
                <TextField label={copy.people.temporaryPassword} labelHidden value={form.temporaryPassword} onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })} autoComplete="off" autoFocus />
                <Button type="button" variant="secondary" onClick={() => setForm({ ...form, temporaryPassword: suggestPassword() })}>{copy.people.regenerate}</Button>
              </div>
            ) },
          ]} />
        </div>
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
