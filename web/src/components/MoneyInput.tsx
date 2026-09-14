import { useEffect, useState } from 'react';
import { TextField } from './TextField';
import { parseMoney } from '../format';
import { copy } from '../copy/en';

export function MoneyInput({ label, valueCents, onChange, wholeShillings, hint, error, autoFocus }: {
  label: string; valueCents: number | null; onChange: (cents: number | null) => void; wholeShillings?: boolean; hint?: string; error?: string; autoFocus?: boolean;
}) {
  const [text, setText] = useState(valueCents === null ? '' : String(valueCents / 100));
  useEffect(() => {
    if (valueCents === null) { if (text !== '' && parseMoney(text) !== null) setText(''); return; }
    if (parseMoney(text) !== valueCents) setText(String(valueCents / 100));
  }, [valueCents]);
  const cents = parseMoney(text);
  const centsError = wholeShillings && cents !== null && cents % 100 !== 0 ? copy.send.phone.centsNotAllowed : undefined;
  return (
    <TextField label={label} inputMode="decimal" value={text} autoFocus={autoFocus} autoComplete="off"
      hint={hint ?? (wholeShillings ? copy.send.phone.wholeShillings : undefined)} error={error ?? centsError}
      onChange={(e) => { setText(e.target.value); onChange(parseMoney(e.target.value)); }} />
  );
}
