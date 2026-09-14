// Source: Safaricom Daraja documentation, "Go-live / IP whitelisting" (checked 2026-09-06).
export const DEFAULT_ALLOWLIST = [
  '196.201.214.200', '196.201.214.206', '196.201.213.114', '196.201.214.207', '196.201.214.208',
  '196.201.213.44', '196.201.212.127', '196.201.212.138', '196.201.212.129', '196.201.212.136',
  '196.201.212.74', '196.201.212.69',
];
export function parseAllowlist(v: string | null): string[] {
  if (!v || !v.trim()) return DEFAULT_ALLOWLIST;
  return v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
export function inAllowlist(ip: string, list: string[]): boolean {
  return list.includes(ip);
}
