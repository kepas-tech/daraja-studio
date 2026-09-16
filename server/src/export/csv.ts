import type { Response } from 'express';

/**
 * Feature 3: the one CSV writer the History and Invoices exports share. Nothing here knows about
 * requests or invoices — each route maps its own view to a header and rows.
 */

/** An export is never paged, but it is bounded: the newest 50,000 rows, and no more. */
export const EXPORT_MAX = 50_000;

/** To a spreadsheet, a cell beginning with one of these is a formula to run, not words to show. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: always quoted, an inner quote doubled, so a comma, a quote or a newline inside a
 * customer's own text can never break the line. Text a spreadsheet would run as a formula gets a
 * leading apostrophe — a customer called `=cmd|...` lands as words, never as code. Numbers are
 * quoted like everything else: a spreadsheet still reads "300.00" as a number, and a receipt of
 * digits keeps its leading zeros.
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Header first, then one line per row; every line ends CRLF, so the file ends with one newline. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** The clock the owner reads: Africa/Nairobi, whatever the server's own timezone happens to be. */
const STAMP = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** `2026-09-16 21:04:05` in Nairobi time, from any ISO instant. */
export function nairobiStamp(iso: string): string {
  const p: Record<string, string> = {};
  for (const part of STAMP.formatToParts(new Date(iso))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Today in Nairobi, for the file name. */
export function todayNairobi(): string { return nairobiStamp(new Date().toISOString()).slice(0, 10); }

/** Cents as shillings with two decimals, the shape a spreadsheet adds up. */
export function shillings(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

/**
 * Send one finished file. The name is fixed by the caller and carries no user text, so it needs no
 * quoting; nothing here may be cached, because the rows behind it change with every payment.
 */
export function sendCsv(res: Response, filename: string, body: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
}
