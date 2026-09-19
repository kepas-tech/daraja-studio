/**
 * What is kept from one sweep, worked out to the shilling.
 *
 * The rule is set per business: a percentage, a flat amount, or both, with a floor and a ceiling.
 * The percentage is rounded to a whole shilling before the flat amount is added, so the fee is
 * always a whole number of shillings and the net is too — Safaricom sends whole shillings to a
 * phone, and a fee that produced half a shilling would have nowhere to put it.
 *
 * The floor is applied after the sum and the ceiling after the floor, and neither may take more
 * than the money itself: a fee larger than what arrived would mean sending the business a negative
 * amount, so it is capped at the gross.
 */
export interface FeeRule {
  percentBp: number;
  flatCents: number;
  floorCents: number | null;
  ceilingCents: number | null;
}

export const NO_FEE: FeeRule = { percentBp: 0, flatCents: 0, floorCents: null, ceilingCents: null };

/** 100 basis points is one per cent. */
export const BP = 10_000;

/** The nearest whole shilling, halves up, which is how a person rounds money. */
const toShilling = (cents: number): number => Math.round(cents / 100) * 100;

/** What is kept from this gross. Never negative, never more than the gross. */
export function feeFor(grossCents: number, rule: FeeRule): number {
  if (!Number.isFinite(grossCents) || grossCents <= 0) return 0;
  let fee = toShilling((grossCents * rule.percentBp) / BP) + rule.flatCents;
  if (rule.floorCents !== null) fee = Math.max(fee, rule.floorCents);
  if (rule.ceilingCents !== null) fee = Math.min(fee, rule.ceilingCents);
  return Math.max(0, Math.min(fee, grossCents));
}

/** What the business's phone gets: the gross less the fee. */
export function netOf(grossCents: number, rule: FeeRule): number {
  return Math.max(0, grossCents - feeFor(grossCents, rule));
}
