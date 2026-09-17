import type { HTMLAttributes, ReactNode } from 'react';

/** A bordered box with an optional muted header row; lists inside use `cardRow` on each item.
 *  `title` is a node, not the DOM attribute the HTML props also call `title`, so an icon can sit
 *  beside the heading text (item 6). */
export function Card({ title, actions, children, className = '', bodyClassName = 'p-4', ...p }: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; actions?: ReactNode; bodyClassName?: string }) {
  return (
    <section {...p} className={`rounded-md border border-line bg-surface ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line bg-page px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>{actions}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export const cardRow = 'border-t border-line px-4 py-3 first:border-t-0';
