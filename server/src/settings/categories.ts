import { HttpError } from '../util/errors.js';

/**
 * A payment category is the business's own name for a send, sitting on top of one of the three
 * kinds Safaricom's B2C API accepts. The name is what people see in History; the command is what
 * goes to Safaricom.
 */
export type CommandId = 'BusinessPayment' | 'SalaryPayment' | 'PromotionPayment';
export const COMMAND_IDS: readonly CommandId[] = ['BusinessPayment', 'SalaryPayment', 'PromotionPayment'];
export interface SendCategory { id: string; name: string; commandId: CommandId }

export const DEFAULT_CATEGORIES: readonly SendCategory[] = [
  { id: 'business', name: 'Business payment', commandId: 'BusinessPayment' },
  { id: 'salary', name: 'Salary', commandId: 'SalaryPayment' },
  { id: 'promotion', name: 'Promotion', commandId: 'PromotionPayment' },
];
export const MAX_CATEGORIES = 20;

export function slugOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'category';
}

/** The stored JSON, or the defaults when nothing has been saved or the value is unreadable. */
export function parseCategories(raw: string | null): SendCategory[] {
  if (!raw) return [...DEFAULT_CATEGORIES];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [...DEFAULT_CATEGORIES];
    const out = v.filter((c): c is SendCategory => !!c && typeof c === 'object' && typeof (c as SendCategory).name === 'string' && COMMAND_IDS.includes((c as SendCategory).commandId))
      .map((c) => ({ id: typeof c.id === 'string' && c.id ? c.id : slugOf(c.name), name: c.name, commandId: c.commandId }));
    return out.length ? out : [...DEFAULT_CATEGORIES];
  } catch { return [...DEFAULT_CATEGORIES]; }
}

/** Refuses an empty, oversized or ambiguous list; returns the cleaned list to store. */
export function validateCategories(items: { id?: string; name: string; commandId: string }[]): SendCategory[] {
  if (items.length === 0) throw new HttpError(400, 'categories_empty', 'Keep at least one category.');
  if (items.length > MAX_CATEGORIES) throw new HttpError(400, 'categories_too_many', `Up to ${MAX_CATEGORIES} categories.`);
  const seen = new Set<string>(); const ids = new Set<string>();
  return items.map((c) => {
    const name = c.name.trim();
    if (!name || name.length > 40) throw new HttpError(400, 'category_name', 'A category name is 1 to 40 characters.');
    const key = name.toLowerCase();
    if (seen.has(key)) throw new HttpError(400, 'category_duplicate', `"${name}" is listed twice.`);
    seen.add(key);
    if (!COMMAND_IDS.includes(c.commandId as CommandId)) throw new HttpError(400, 'category_kind', 'Choose one of the three Safaricom payment kinds.');
    let id = c.id && /^[a-z0-9-]{1,40}$/.test(c.id) ? c.id : slugOf(name);
    while (ids.has(id)) id = `${id}-2`;
    ids.add(id);
    return { id, name, commandId: c.commandId as CommandId };
  });
}
