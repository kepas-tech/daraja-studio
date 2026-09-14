/** Safaricom reports money in shillings; the studio stores cents. One place converts. */
export const toCents = (n: number | undefined): number | null => (n === undefined ? null : Math.round(n * 100));
