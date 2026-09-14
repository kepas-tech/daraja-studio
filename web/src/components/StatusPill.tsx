const tone: Record<string, string> = {
  ok: 'border-brand bg-brand-tint text-brand-dark',
  warn: 'border-line bg-page text-muted',
  bad: 'border-danger bg-danger-tint text-danger',
  muted: 'border-line bg-page text-muted',
};
export function StatusPill({ kind, children }: { kind: 'ok' | 'warn' | 'bad' | 'muted'; children: React.ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2 text-xs font-semibold leading-[18px] ${tone[kind]}`}>{children}</span>;
}
