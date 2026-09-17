import { normalizePhone } from '@kepas/daraja-js';

export interface InvoiceRow { line: number; customerName: string; customerPhone: string; invoiceName: string; accountReference: string; billedPeriod: string; dueDate: string; amountCents: number }
export interface InvoiceRowError { line: number; message: string }
export const INVOICE_MAX_ROWS = 500;

function fields(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : ',';
  const out: string[] = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isMoney = (s: string) => /^\d+(\.\d{1,2})?$/.test(s);

/** `name, phone, invoice name, account, period, due date (YYYY-MM-DD), amount` per line. */
export function parseInvoices(text: string): { rows: InvoiceRow[]; errors: InvoiceRowError[] } {
  const rows: InvoiceRow[] = []; const errors: InvoiceRowError[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let first = true;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const f = fields(raw);
    if (first) {
      first = false;
      let isPhone = false; try { normalizePhone(f[1] ?? ''); isPhone = true; } catch { /* header */ }
      if (!isPhone && !isMoney((f[6] ?? '').replace(/,/g, ''))) return;
    }
    if (rows.length + errors.length >= INVOICE_MAX_ROWS) { errors.push({ line, message: `More than ${INVOICE_MAX_ROWS} rows. Split the list.` }); return; }
    const [customerName, phoneText, invoiceName, accountReference, billedPeriod, dueDate, amountText] = [f[0] ?? '', f[1] ?? '', f[2] ?? '', f[3] ?? '', f[4] ?? '', f[5] ?? '', (f[6] ?? '').replace(/,/g, '')];
    if (!customerName) { errors.push({ line, message: 'The name is missing.' }); return; }
    let customerPhone: string;
    try { customerPhone = normalizePhone(phoneText); } catch { errors.push({ line, message: 'Not a Kenyan mobile number.' }); return; }
    if (!invoiceName) { errors.push({ line, message: 'The invoice name is missing.' }); return; }
    if (!accountReference || accountReference.length > 20) { errors.push({ line, message: 'The account reference is missing or longer than 20 characters.' }); return; }
    if (!billedPeriod) { errors.push({ line, message: 'The billed period is missing.' }); return; }
    if (!isDay(dueDate)) { errors.push({ line, message: 'The due date must be YYYY-MM-DD.' }); return; }
    if (!isMoney(amountText) || Number(amountText) <= 0) { errors.push({ line, message: 'Not an amount.' }); return; }
    rows.push({ line, customerName: customerName.slice(0, 80), customerPhone, invoiceName: invoiceName.slice(0, 80), accountReference, billedPeriod: billedPeriod.slice(0, 40), dueDate, amountCents: Math.round(Number(amountText) * 100) });
  });
  return { rows, errors };
}
