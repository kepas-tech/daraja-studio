import { useState } from 'react';
import { api } from '../../api/client';
import type { CommandId, SendCategory } from '../../api/types';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { TextField } from '../../components/TextField';
import { Questionnaire } from '../../components/Questionnaire';
import { toastText } from '../../components/ErrorCard';
import { useToast } from '../../components/Toast';
import { copy } from '../../copy/en';
import type { StepUp } from './useStepUp';

const KINDS: CommandId[] = ['BusinessPayment', 'SalaryPayment', 'PromotionPayment'];
const control = 'min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink';

/** The business's own send categories: each a name of ours on top of one of Safaricom's three kinds. */
export function CategoriesSection({ items, reload, stepUp }: { items: SendCategory[]; reload: () => Promise<unknown>; stepUp: StepUp }) {
  const toast = useToast();
  const c = copy.settings.categories;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ name: string; commandId: CommandId }>({ name: '', commandId: 'BusinessPayment' });

  const save = (next: { id?: string; name: string; commandId: CommandId }[], after: () => void) => stepUp.ask(c.confirm, async (confirm) => {
    try {
      await api.put('/api/settings/send-categories', { items: next, ...confirm });
      toast.success(c.saved);
      after();
      await reload();
    } catch (e) { toast.error(toastText(e)); throw e; }
  });

  const form = (onSave: () => void, onCancel: () => void) => (
    <Questionnaire doneLabel={copy.settings.save} onDone={onSave} onCancel={onCancel} steps={[
      { key: 'name', question: c.name, valid: draft.name.trim().length > 0, render: () => <TextField label={c.name} labelHidden value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus /> },
      { key: 'kind', question: c.kind, valid: true, render: () => (
        <select aria-label={c.kind} className={control} value={draft.commandId} onChange={(e) => setDraft({ ...draft, commandId: e.target.value as CommandId })}>
          {KINDS.map((k) => <option key={k} value={k}>{copy.send.phone.kinds[k]}</option>)}
        </select>
      ) },
    ]} />
  );

  return (
    <Card id="categories" title={c.title} className="mb-6" bodyClassName="p-0" actions={<Button variant="secondary" onClick={() => { setEditing(null); setDraft({ name: '', commandId: 'BusinessPayment' }); setAdding((v) => !v); }}>{adding ? copy.confirm.cancel : c.add}</Button>}>
      <p className="px-4 pt-3 text-sm text-muted">{c.intro}</p>
      <ul>
        {items.map((cat) => (
          <li key={cat.id} data-testid={`category-${cat.id}`} className="border-t border-line">
            {editing === cat.id ? (
              <div className="p-4">{form(
                () => save(items.map((x) => (x.id === cat.id ? { id: cat.id, name: draft.name, commandId: draft.commandId } : x)), () => setEditing(null)),
                () => setEditing(null),
              )}</div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-base font-semibold">{cat.name}</div>
                  <div className="text-sm text-muted">{c.kind}: {copy.send.phone.kinds[cat.commandId]}</div>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => { setAdding(false); setDraft({ name: cat.name, commandId: cat.commandId }); setEditing(cat.id); }}>{c.edit}</Button>
                  <Button variant="danger" disabled={items.length <= 1} title={items.length <= 1 ? c.last : undefined} onClick={() => save(items.filter((x) => x.id !== cat.id), () => {})}>{c.remove}</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {adding && <div className="border-t border-line bg-page p-4">{form(
        () => save([...items, { name: draft.name, commandId: draft.commandId }], () => setAdding(false)),
        () => setAdding(false),
      )}</div>}
    </Card>
  );
}
