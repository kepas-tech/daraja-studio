import { useState } from 'react';
import { api } from '../../api/client';
import type { SettingsView } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { MoneyInput } from '../../components/MoneyInput';
import { SettingRow } from '../../components/SettingRow';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import { money } from '../../format';
import type { StepUp } from './useStepUp';

/** M4: one number. Zero turns the hold off. */
export function ApprovalsSection({ view, reload, stepUp }: { view: SettingsView; reload: () => Promise<unknown>; stepUp: StepUp }) {
  const toast = useToast();
  const c = copy.settings.approvals;
  const [cents, setCents] = useState<number | null>(view.approvalThresholdCents || null);
  const on = view.approvalThresholdCents > 0;
  return (
    <Card title={c.title} bodyClassName="p-0">
      <SettingRow testId="setting-approvals" label={c.label} value={on ? c.holdFrom(money(view.approvalThresholdCents)) : c.off}>
        {(close) => (
          <>
            <MoneyInput label={c.field} valueCents={cents} onChange={setCents} wholeShillings hint={c.hint} />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => stepUp.ask(c.confirm, async (password) => {
                await api.put('/api/settings/approval-threshold', { cents: cents ?? 0, password });
                toast.success(copy.settings.saved);
                await reload();
                close();
              })}>{copy.settings.save}</Button>
              <Button variant="secondary" onClick={close}>{copy.confirm.cancel}</Button>
            </div>
          </>
        )}
      </SettingRow>
      <p className="px-4 py-3 text-sm text-muted">{c.note}</p>
    </Card>
  );
}
