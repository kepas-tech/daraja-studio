import { useId, type InputHTMLAttributes } from 'react';
export function TextField({ label, hint, error, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-base">{label}</span>
      <input id={id} {...p} className={`w-full rounded-lg border px-3 py-2.5 text-base dark:bg-gray-900 ${error ? 'border-red-500' : 'border-gray-300 dark:border-gray-700'}`} aria-invalid={p['aria-invalid'] ?? !!error} />
      {hint && !error && <span className="mt-1 block text-sm text-gray-500">{hint}</span>}
      {error && <span className="mt-1 block text-sm text-red-700">{error}</span>}
    </label>
  );
}
