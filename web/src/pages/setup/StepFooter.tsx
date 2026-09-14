import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { copy } from '../../copy/en';

/** Every step ends the same way: Back on the left, the step's own action on the right. */
export function StepFooter({ onBack, backDisabled, children }: { onBack?: () => void; backDisabled?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
      <div>{onBack && <Button type="button" variant="secondary" icon={<Icon name="arrow-left" className="size-4" />} onClick={onBack} disabled={backDisabled}>{copy.setup.back}</Button>}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
