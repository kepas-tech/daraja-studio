import { useId, type InputHTMLAttributes } from 'react';
export function TextField({ label, hint, error, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-base font-semibold">{label}</span>
      <input id={id} {...p} className={`min-h-11 w-full rounded-md border bg-surface px-3 text-base text-ink shadow-inner placeholder:text-muted focus:outline-2 focus:-outline-offset-1 focus:outline-brand disabled:bg-page disabled:text-muted ${error ? 'border-danger' : 'border-line'}`} aria-invalid={p['aria-invalid'] ?? !!error} />
      {hint && !error && <span className="mt-1 block text-sm text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-sm text-danger">{error}</span>}
    </label>
  );
}
