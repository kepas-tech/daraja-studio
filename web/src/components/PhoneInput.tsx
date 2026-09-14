import { TextField } from './TextField';
import { normalizeKe, phone } from '../format';
import { copy } from '../copy/en';

export function PhoneInput({ label, value, onChange, error, autoFocus, labelHidden }: { label: string; value: string; onChange: (v: string) => void; error?: string; autoFocus?: boolean; labelHidden?: boolean }) {
  const normalised = value.trim() ? normalizeKe(value) : null;
  const bad = value.trim().length > 0 && !normalised;
  return (
    <TextField label={label} labelHidden={labelHidden} inputMode="tel" value={value} autoFocus={autoFocus} autoComplete="tel"
      hint={normalised ? phone(normalised) : undefined} error={error ?? (bad ? copy.send.phone.badPhone : undefined)}
      onChange={(e) => onChange(e.target.value)} />
  );
}
