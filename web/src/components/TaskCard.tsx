import type { ReactNode } from 'react';

/** One task in one box: intro, the form, and a footer that holds the page's single primary action. */
export function TaskCard({ intro, footer, footerStart, children, className = '' }: { intro?: ReactNode; footer?: ReactNode; footerStart?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`max-w-xl rounded-md border border-line bg-surface ${className}`}>
      <div className="space-y-4 p-4 md:p-5">
        {intro && <p className="text-base text-muted">{intro}</p>}
        {children}
      </div>
      {(footer || footerStart) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-page px-4 py-3 md:px-5">
          <div className="text-sm text-muted">{footerStart}</div>
          <div className="flex flex-wrap gap-2">{footer}</div>
        </div>
      )}
    </section>
  );
}
