import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { InvoicesSettingsView } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { PhoneInput } from '../../components/PhoneInput';
import { Segmented } from '../../components/Segmented';
import { SettingRow } from '../../components/SettingRow';
import { StatusPill } from '../../components/StatusPill';
import { TextField } from '../../components/TextField';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { normalizeKe, phone } from '../../format';
import type { StepUp } from './useStepUp';

/** M7: the Bill Manager opt-in details, changeable once opted in. */
export function InvoicesSection({ stepUp }: { stepUp: StepUp }) {
  const c = copy.settings.invoices;
  const toast = useToast();
  const [v, setV] = useState<InvoicesSettingsView | null>(null);
  const [email, setEmail] = useState(''); const [contact, setContact] = useState(''); const [reminders, setReminders] = useState<'yes' | 'no'>('yes');
  const load = useCallback(() => api.get<InvoicesSettingsView>('/api/invoices/settings').then((s) => { setV(s); setEmail(s.email ?? ''); setContact(s.phone ?? ''); setReminders(s.reminders ? 'yes' : 'no'); }), []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  if (!v) return null;
  return (
    <Card title={c.title} bodyClassName="p-0">
      <SettingRow testId="setting-invoices" label={c.label} value={v.optedIn ? <span className="flex flex-wrap items-center gap-2"><span>{v.email} · {phone(v.phone)}</span><StatusPill kind="ok">{v.reminders ? c.remindersOn : c.remindersOff}</StatusPill></span> : <StatusPill kind="muted">{c.notYet}</StatusPill>}>
        {v.optedIn ? (close) => (
          <>
            <TextField label={copy.invoices.optIn.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <PhoneInput label={copy.invoices.optIn.contact} value={contact} onChange={setContact} />
            <Segmented name="invoice-reminders" label={copy.invoices.optIn.reminders} value={reminders} options={[{ value: 'yes', label: copy.confirm.yes }, { value: 'no', label: copy.confirm.no }]} onChange={setReminders} />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => stepUp.ask(copy.invoices.optIn.confirm, async (password) => {
                await api.post('/api/invoices/opt-in', { email: email.trim(), officialContact: normalizeKe(contact) ?? contact, sendReminders: reminders === 'yes', password });
                toast.success(copy.settings.saved); await load(); close();
              })}>{copy.settings.save}</Button>
              <Button variant="secondary" onClick={close}>{copy.confirm.cancel}</Button>
            </div>
          </>
        ) : undefined}
      </SettingRow>
      {v.registering && <p className="px-4 py-3 text-sm text-muted" role="status">{copy.invoices.optIn.registering}</p>}
      {!v.registering && v.lastError && <p className="px-4 py-3 text-sm text-danger">{copy.invoices.optIn.failed} {v.lastError.split('\n')[0]}</p>}
      {!v.optedIn && !v.registering && <p className="px-4 py-3 text-sm text-muted">{c.hint}</p>}
    </Card>
  );
}
