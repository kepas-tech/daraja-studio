/**
 * The keypad icons. The X on the Cancel key and the backspace arrow are kepas-pay's own paths; the
 * fingerprint is Studio's (item 6), drawn on the same 24 px box with the same 1.6 round stroke so it
 * sits with them.
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

/**
 * The fingerprint, on the same 24 px box and 1.6 round stroke as the two kepas-pay icons above.
 * Three concentric ridges wrap a core loop, the shape a fingerprint actually reads as. The colour is
 * the brand's own pair: the green token carries every ridge and the red one marks the core, the same
 * green-and-red the logo uses — so it reads as branded, never as a warning. It is decorative: the
 * control that shows it carries the label.
 */
export function FingerprintIcon() {
  return (
    <svg {...base} data-testid="fingerprint-icon">
      {/* The core loop, open at the bottom like the ridges around it. */}
      <path className="stroke-danger" d="M 10.27 13.05 A 2 2.3 0 1 1 13.73 13.05" />
      <path className="stroke-brand" d="M 8.91 15.29 A 4.8 4.3 0 1 1 15.09 15.29" />
      <path className="stroke-brand" d="M 8.53 17.92 A 7.4 6.7 0 1 1 15.47 17.92" />
      <path className="stroke-brand" d="M 8.97 20.46 A 9.8 8.9 0 1 1 15.03 20.46" />
    </svg>
  );
}

export function CloseIcon() {
  return <svg {...base}><path d="M18 6 6 18M6 6l12 12" /></svg>;
}

export function BackspaceIcon() {
  return <svg {...base}><path d="M21 5H8L2 12l6 7h13a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zM15 9l-5 6M10 9l5 6" /></svg>;
}
