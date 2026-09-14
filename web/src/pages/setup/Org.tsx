import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { TextField } from '../../components/TextField';
import { ErrorCard } from '../../components/ErrorCard';
import { Questionnaire } from '../../components/Questionnaire';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';

export function Org({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', nominatedNumber: '', notificationPhone: '' });
  const [err, setErr] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await api.post('/api/setup/org', f); toast.success(copy.settings.saved); onDone(); }
    catch (e2) { setErr(e2 instanceof ApiError ? e2 : new Error(copy.error.generic)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <Questionnaire doneLabel={copy.setup.next} busy={busy} onDone={() => void submit()} onCancel={onBack} steps={[
        { key: 'name', question: copy.setup.org.name, valid: f.name.trim().length > 0, render: () => <TextField label={copy.setup.org.name} labelHidden value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /> },
        { key: 'nominated', question: copy.setup.org.nominated, valid: /^254\d{9}$/.test(f.nominatedNumber), render: () => <TextField label={copy.setup.org.nominated} labelHidden inputMode="numeric" value={f.nominatedNumber} onChange={(e) => setF({ ...f, nominatedNumber: e.target.value })} autoFocus /> },
        { key: 'notify', question: copy.setup.org.notify, valid: /^254\d{9}$/.test(f.notificationPhone), render: () => <TextField label={copy.setup.org.notify} labelHidden inputMode="numeric" value={f.notificationPhone} onChange={(e) => setF({ ...f, notificationPhone: e.target.value })} autoFocus /> },
      ]} />
      <ErrorCard error={err} />
    </div>
  );
}
