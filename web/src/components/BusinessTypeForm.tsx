import { useState } from 'react';
import type { BusinessTypeView, TypeTemplate } from '../api/types';
import { Button } from './Button';
import { ErrorCard, type Explained } from './ErrorCard';
import { TextField } from './TextField';
import { copy } from '../copy/en';
import { blankTemplate } from '../businessTypes';

/**
 * Round 3, phase B: the words of one kind of business, editable.
 *
 * The two nouns, the statement name and the categories are free text the owner types. The four
 * fields that are behaviour — how often money is expected, whether an account stands for a set
 * amount, what happens with invoices and reminders, and what Home leads with — are chosen from a
 * fixed set, because each one is wired to something Studio does.
 */
export function BusinessTypeForm({ existing, error, onSave, onCancel }: {
  existing: BusinessTypeView | null;
  error: Error | Explained | null;
  onSave: (value: { name: string; template: TypeTemplate }) => Promise<void>;
  onCancel: () => void;
}) {
  const c = copy.typeWords;
  const [name, setName] = useState(existing?.name ?? '');
  const [t, setT] = useState<TypeTemplate>(existing?.template ?? blankTemplate());
  const [categories, setCategories] = useState((existing?.template.categories ?? []).join(', '));
  const control = 'min-h-11 w-full rounded-md border border-line bg-surface px-3 text-base text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-brand';
  const set = <K extends keyof TypeTemplate>(key: K, value: TypeTemplate[K]) => setT((prev) => ({ ...prev, [key]: value }));
  const parsed = categories.split(',').map((s) => s.trim()).filter(Boolean);

  return (
    <div className="space-y-3">
      <TextField label={c.name} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
      <label className="block">
        <span className="mb-1 block text-base font-medium">{c.accountNoun}</span>
        <span className="mb-1 block text-sm text-muted">{c.accountNounHint}</span>
        <input aria-label={c.accountNoun} className={control} value={t.accountNoun} maxLength={30} onChange={(e) => set('accountNoun', e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-base font-medium">{c.subAccountNoun}</span>
        <span className="mb-1 block text-sm text-muted">{c.subAccountNounHint}</span>
        <input aria-label={c.subAccountNoun} className={control} value={t.subAccountNoun ?? ''} maxLength={30} onChange={(e) => set('subAccountNoun', e.target.value.trim() ? e.target.value : null)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-base font-medium">{c.regular}</span>
        <select aria-label={c.regular} className={control} value={t.regular} onChange={(e) => set('regular', e.target.value as TypeTemplate['regular'])}>
          {Object.entries(c.regularWords).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-base font-medium">{c.standing}</span>
        <select aria-label={c.standing} className={control} value={t.standingAmount} onChange={(e) => set('standingAmount', e.target.value as TypeTemplate['standingAmount'])}>
          {Object.entries(c.standingWords).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-base font-medium">{c.categories}</span>
        <span className="mb-1 block text-sm text-muted">{c.categoriesHint}</span>
        <input aria-label={c.categories} className={control} value={categories} onChange={(e) => setCategories(e.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-base font-medium">{c.invoices}</span>
        <select aria-label={c.invoices} className={control} value={t.invoices} onChange={(e) => set('invoices', e.target.value as TypeTemplate['invoices'])}>
          {Object.entries(c.invoicesWords).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-base">
        <input type="checkbox" className="size-5 accent-brand" checked={t.reminders} onChange={(e) => set('reminders', e.target.checked)} />
        {c.reminders}
      </label>
      <label className="block">
        <span className="mb-1 block text-base font-medium">{c.homeLead}</span>
        <select aria-label={c.homeLead} className={control} value={t.homeLead} onChange={(e) => set('homeLead', e.target.value as TypeTemplate['homeLead'])}>
          {Object.entries(c.homeLeadWords).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-base font-medium">{c.statementNoun}</span>
        <span className="mb-1 block text-sm text-muted">{c.statementNounHint}</span>
        <input aria-label={c.statementNoun} className={control} value={t.statementNoun} maxLength={40} onChange={(e) => set('statementNoun', e.target.value)} />
      </label>
      <ErrorCard error={error} />
      <div className="flex gap-2">
        <Button type="button" disabled={name.trim().length === 0 || t.accountNoun.trim().length === 0 || t.statementNoun.trim().length === 0} onClick={() => void onSave({ name: name.trim(), template: { ...t, categories: parsed } })}>{c.save}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{copy.businesses.cancel}</Button>
      </div>
    </div>
  );
}
