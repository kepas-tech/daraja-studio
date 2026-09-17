/**
 * The three keypad icons kepas-pay draws inline on its lock screen, ported path for path: the
 * fingerprint arc set, the X on the Cancel key, and the backspace arrow. 24 px, stroke-width 1.6,
 * currentColor, so they take the colour of the key they sit on.
 */
const base = {
  viewBox: '0 0 24 24',
  width: 24,
  height: 24,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function FingerprintIcon() {
  return (
    <svg {...base}>
      <path d="M12 11a3 3 0 0 0-3 3v2M12 11a3 3 0 0 1 3 3v1M7 8a7 7 0 0 1 10 0M5 12a9 9 0 0 1 1.6-5M19 12a9 9 0 0 0-1.6-5M9 20a12 12 0 0 1-1-8M15 20a12 12 0 0 0 1-6" />
    </svg>
  );
}

export function CloseIcon() {
  return <svg {...base}><path d="M18 6 6 18M6 6l12 12" /></svg>;
}

export function BackspaceIcon() {
  return <svg {...base}><path d="M21 5H8L2 12l6 7h13a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zM15 9l-5 6M10 9l5 6" /></svg>;
}
