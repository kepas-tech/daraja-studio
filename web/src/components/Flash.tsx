import type { HTMLAttributes } from 'react';
import { Icon } from './Icon';

const TONE = {
  success: { box: 'border-brand bg-brand-tint', icon: 'confirm-circle', tint: 'text-brand-dark' },
  danger: { box: 'border-danger bg-danger-tint', icon: 'alert-circle', tint: 'text-danger' },
  neutral: { box: 'border-line bg-page', icon: 'lightbulb', tint: 'text-muted' },
} as const;

/** A bordered, tinted banner with a leading icon — for a result, a warning, or a note. */
export function Flash({ tone, children, className = '', ...p }: HTMLAttributes<HTMLDivElement> & { tone: keyof typeof TONE }) {
  const t = TONE[tone];
  return (
    <div {...p} className={`flex gap-3 rounded-md border p-4 text-base text-ink ${t.box} ${className}`}>
      <Icon name={t.icon} className={`mt-0.5 size-5 ${t.tint}`} />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}
