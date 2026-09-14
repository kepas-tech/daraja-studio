const KES = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const shillings = cents / 100;
  const s = cents % 100 === 0 ? KES.format(shillings) : shillings.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `KES ${s}`;
}

export function parseMoney(text: string): number | null {
  const t = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}

export function normalizeKe(input: string): string | null {
  const d = input.replace(/[\s()-]/g, '').replace(/^\+/, '');
  if (/^0[17]\d{8}$/.test(d)) return `254${d.slice(1)}`;
  if (/^254[17]\d{8}$/.test(d)) return d;
  return null;
}

export function phone(msisdn: string | null | undefined): string {
  if (!msisdn) return '—';
  const m = /^254([17]\d{8})$/.exec(msisdn);
  if (!m) return msisdn;
  const local = `0${m[1]}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

/** A calendar date without a time, for copy that reads "until 14 September". */
export function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-KE', { day: 'numeric', month: 'long' });
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}
