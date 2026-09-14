const tone: Record<string, string> = { ok: 'bg-emerald-100 text-emerald-900', warn: 'bg-amber-100 text-amber-900', bad: 'bg-red-100 text-red-900', muted: 'bg-gray-100 text-gray-800' };
export function StatusPill({ kind, children }: { kind: 'ok' | 'warn' | 'bad' | 'muted'; children: React.ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-sm ${tone[kind]}`}>{children}</span>;
}
