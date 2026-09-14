import type { ButtonHTMLAttributes } from 'react';
export function Button({ variant = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const v = variant === 'primary' ? 'bg-emerald-700 text-white hover:bg-emerald-800' : variant === 'danger' ? 'bg-red-700 text-white hover:bg-red-800' : 'border border-gray-300 bg-white text-gray-900 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-100 dark:border-gray-700';
  return <button {...p} className={`rounded-lg px-4 py-2.5 text-base font-medium disabled:opacity-50 ${v} ${className}`} />;
}
