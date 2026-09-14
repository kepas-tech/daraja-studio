import { useState, type ReactNode } from 'react';
import { Button } from './Button';
import { copy } from '../copy/en';

/**
 * A setting shown as label + current value, with its edit form folded behind one button. The
 * form gets a `close` callback so a save can put the row back to read-only.
 */
export function SettingRow({ label, value, changeLabel = copy.settings.change, children, testId }: { label: ReactNode; value: ReactNode; changeLabel?: string; children?: (close: () => void) => ReactNode; testId?: string }) {
  const [editing, setEditing] = useState(false);
  const close = () => setEditing(false);
  return (
    <div data-testid={testId} className="border-t border-line first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm text-muted">{label}</div>
          {!editing && <div className="text-base">{value}</div>}
        </div>
        {children && <Button type="button" variant="secondary" onClick={() => setEditing((v) => !v)}>{editing ? copy.confirm.cancel : changeLabel}</Button>}
      </div>
      {editing && children && <div className="space-y-4 px-4 pb-4">{children(close)}</div>}
    </div>
  );
}
