import { Icon } from './Icon';
import { copy } from '../copy/en';

export function Loading({ full = false }: { full?: boolean }) {
  return (
    <div aria-busy="true" className={`flex items-center justify-center ${full ? 'min-h-screen bg-page' : 'py-16'}`}>
      <Icon name="loading-loop" className="size-8 text-brand" />
      <span className="sr-only">{copy.app.loading}</span>
    </div>
  );
}
