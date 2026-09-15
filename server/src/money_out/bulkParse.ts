import { normalizePhone } from '@kepas/daraja-js';

export interface BulkRow { line: number; phone: string; amountCents: number; name: string | null; note: string | null }
export interface BulkError { line: number; message: string }

export const BULK_MAX_ROWS = 500;

/** One CSV or tab-separated line into fields; quotes wrap a field that holds the separator. */
function fields(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : ',';
  const out: string[] = [];
  let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const looksLikePhone = (s: string) => { try { normalizePhone(s); return true; } catch { return false; } };
const isMoney = (s: string) => /^\d+(\.\d{1,2})?$/.test(s.replace(/,/g, ''));

/**
 * `phone, amount, name, note` per line; the first two required. A first line that is neither a
 * phone nor an amount is a header and skipped. Blank lines are skipped. Errors name the line as
 * the person sees it in their file (1-based, blank lines counted), so they can find it.
 */
export function parseBulk(text: string): { rows: BulkRow[]; errors: BulkError[] } {
  const rows: BulkRow[] = []; const errors: BulkError[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const seen = new Map<string, number>();
  let first = true;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const f = fields(raw);
    if (first) {
      first = false;
      if (!looksLikePhone(f[0] ?? '') && !isMoney(f[1] ?? '')) return; // header
    }
    if (rows.length + errors.length >= BULK_MAX_ROWS) { errors.push({ line, message: `More than ${BULK_MAX_ROWS} rows. Split the list.` }); return; }
    let phone: string;
    try { phone = normalizePhone(f[0] ?? ''); } catch { errors.push({ line, message: 'Not a Kenyan mobile number.' }); return; }
    const amountText = (f[1] ?? '').replace(/,/g, '');
    if (!isMoney(amountText)) { errors.push({ line, message: 'Not an amount.' }); return; }
    const amountCents = Math.round(Number(amountText) * 100);
    if (amountCents <= 0) { errors.push({ line, message: 'The amount must be more than zero.' }); return; }
    if (amountCents % 100 !== 0) { errors.push({ line, message: 'Whole shillings only. Safaricom does not send cents to phones.' }); return; }
    const key = `${phone}|${amountCents}`;
    const dup = seen.get(key);
    if (dup !== undefined) { errors.push({ line, message: `Same phone and amount as line ${dup}.` }); return; }
    seen.set(key, line);
    rows.push({ line, phone, amountCents, name: (f[2] ?? '').slice(0, 80) || null, note: (f[3] ?? '').slice(0, 100) || null });
  });
  return { rows, errors };
}
