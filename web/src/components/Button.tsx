import type { ButtonHTMLAttributes, ReactNode } from 'react';

const VARIANT = {
  primary: 'border-brand bg-brand text-surface hover:border-brand-dark hover:bg-brand-dark',
  secondary: 'border-line bg-page text-ink hover:bg-line/60',
  danger: 'border-line bg-page text-danger hover:border-danger hover:bg-danger hover:text-surface',
};

export function Button({ variant = 'primary', className = '', icon, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANT; icon?: ReactNode }) {
  return (
    <button {...p} className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border px-4 text-base font-semibold shadow-[0_1px_0_rgba(0,0,0,0.04)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}>
      {icon}{children}
    </button>
  );
}
