import { useId, type InputHTMLAttributes } from 'react';

/** Label, input, then hint or error. The hint sits outside the label so the field's name stays the label alone. */
export function TextField({ label, hint, error, className = '', labelHidden = false, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string; /** Keep the label for readers and tests, but do not print it (the question above already says it). */ labelHidden?: boolean }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const described = hint || error ? hintId : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className={labelHidden ? 'sr-only' : 'mb-1 block text-base font-semibold'}>{label}</label>
      <input id={id} {...p} aria-describedby={p['aria-describedby'] ?? described} className={`min-h-11 w-full rounded-md border bg-surface px-3 text-base text-ink shadow-inner placeholder:text-muted focus:outline-2 focus:-outline-offset-1 focus:outline-brand disabled:bg-page disabled:text-muted ${error ? 'border-danger' : 'border-line'}`} aria-invalid={p['aria-invalid'] ?? !!error} />
      {hint && !error && <p id={hintId} className="mt-1 text-sm text-muted">{hint}</p>}
      {error && <p id={hintId} className="mt-1 text-sm text-danger">{error}</p>}
    </div>
  );
}
