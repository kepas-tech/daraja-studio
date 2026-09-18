import type { BusinessTypeView, TypeTemplate } from './api/types';
import { copy } from './copy/en';

/**
 * Round 3, phase B: the words a kind of business brings with it.
 *
 * The type is data, so every page that used to hard-code "account" reads the noun from the type
 * instead. The neutral type is the fallback for a server that predates types, or a row with none.
 */
export const NEUTRAL_TYPE: BusinessTypeView = {
  key: 'other',
  name: 'Other',
  template: {
    accountNoun: 'Account', subAccountNoun: null, regular: 'no', standingAmount: 'none',
    categories: [], invoices: 'off', reminders: false, homeLead: 'nothing', statementNoun: 'Account',
  },
};

export function typeOf(business: { type?: BusinessTypeView } | null | undefined): BusinessTypeView {
  return business?.type ?? NEUTRAL_TYPE;
}

/** One more of a single word: Tenant → Tenants, Class → Classes, Unit → Units. */
function pluralWord(word: string): string {
  return /(s|x|z|ch|sh)$/i.test(word) ? word + 'es' : /[^aeiou]y$/i.test(word) ? word.slice(0, -1) + 'ies' : word + 's';
}

/**
 * One more of something, in the owner's own word. Each half of an "or"/"and" name pluralises:
 * Tenant → Tenants, Class → Classes, Room or unit → Rooms or units.
 */
export function plural(noun: string): string {
  // The capturing group keeps the joiners in the result, so every other part is a word to pluralise.
  return noun.trim().split(/\s+(or|and)\s+/i)
    .map((part, i) => (i % 2 === 1 || !part ? part : part.split(/\s+/).map((w, j, all) => (j === all.length - 1 ? pluralWord(w) : w)).join(' ')))
    .join(' ');
}

/** "a tenant", "an attendant": the article the noun needs. */
export function withArticle(noun: string): string {
  return (/^[aeiou]/i.test(noun.trim()) ? 'an ' : 'a ') + noun.trim().toLowerCase();
}

/** The lower-case noun as it reads inside a sentence, keeping the owner's own capitalisation off. */
export function lower(noun: string): string {
  return noun.trim().toLowerCase();
}

export interface TypeWords {
  /** "Tenant" — one account. */
  one: string;
  /** "Tenants" — more than one. */
  many: string;
  /** "Room or unit", or null when this kind has nothing under an account. */
  sub: string | null;
  /** "Rooms or units", or null. */
  subs: string | null;
  /** "a tenant" / "an attendant". */
  a: string;
}

export function wordsOf(type: BusinessTypeView): TypeWords {
  const one = type.template.accountNoun;
  const sub = type.template.subAccountNoun;
  return { one, many: plural(one), sub, subs: sub ? plural(sub) : null, a: withArticle(one) };
}

/** What this kind of business expects, in plain lines, for the business card and the account page. */
export function expectationLines(t: TypeTemplate): string[] {
  const lines: string[] = [];
  if (t.regular !== 'no') lines.push(copy.typeWords.regularLine[t.regular]);
  if (t.standingAmount !== 'none') lines.push(copy.typeWords.standingLine[t.standingAmount]);
  lines.push(t.reminders ? copy.typeWords.invoicesLineWithReminders[t.invoices] : copy.typeWords.invoicesLine[t.invoices]);
  return lines;
}

/** The template a fresh "add a kind" form starts from. */
export function blankTemplate(noun = 'Account'): TypeTemplate {
  return { accountNoun: noun, subAccountNoun: null, regular: 'no', standingAmount: 'none', categories: [], invoices: 'off', reminders: false, homeLead: 'nothing', statementNoun: 'Account' };
}
