import type { ReactNode } from 'react';

/** Joined choices, the chosen one filled. Real radio inputs stay in the document for keyboards and tests. */
export function Segmented<T extends string>({ name, value, options, onChange, label }: { name: string; value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex">
      {options.map((o, i) => (
        <label key={o.value} className={`flex min-h-11 flex-1 cursor-pointer items-center justify-center border px-4 text-center text-base font-semibold focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-brand ${i === 0 ? 'rounded-l-md' : '-ml-px'} ${i === options.length - 1 ? 'rounded-r-md' : ''} ${value === o.value ? 'z-10 border-brand bg-brand text-surface' : 'border-line bg-page text-ink hover:bg-line/60'}`}>
          <input type="radio" name={name} className="sr-only" checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}
