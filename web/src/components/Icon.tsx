import { Icon as Iconify } from '@iconify/react';
import { ICONS, type IconName } from '../icons/lineMd';

/** A line-md icon: draws itself in on mount. Size it with a Tailwind size-* class. */
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <Iconify icon={ICONS[name]} className={`inline-block shrink-0 ${className}`} aria-hidden />;
}
