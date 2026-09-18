import type { BusinessTypeView, TypeTemplate } from '../api/types';
import { copy } from '../copy/en';

/**
 * Round 3, phase B test fixtures: a kind of business, and the two most useful ones. The shipped
 * list lives on the server; a test that only needs the words builds the row it needs here.
 */
export function template(over: Partial<TypeTemplate> = {}): TypeTemplate {
  return { accountNoun: 'Account', subAccountNoun: null, regular: 'no', standingAmount: 'none', categories: [], invoices: 'off', reminders: false, homeLead: 'nothing', statementNoun: 'Account', ...over };
}

export const RENTAL: BusinessTypeView = {
  key: 'rental', name: 'Rental or property',
  template: template({ accountNoun: 'Tenant', subAccountNoun: 'Room or unit', regular: 'monthly', standingAmount: 'fixed', categories: ['Rent', 'Deposit'], invoices: 'on', reminders: true, homeLead: 'behind', statementNoun: 'Rent statement' }),
};

export const SCHOOL: BusinessTypeView = {
  key: 'school', name: 'School',
  template: template({ accountNoun: 'Student', subAccountNoun: 'Class', regular: 'each_term', standingAmount: 'fixed', categories: ['Tuition'], invoices: 'each_term', reminders: true, homeLead: 'outstanding', statementNoun: 'Fee statement' }),
};

export const OTHER: BusinessTypeView = { key: 'other', name: 'Other', template: template() };

/** The nine the server seeds, for a test that renders the picker or the kinds card. */
export const SHIPPED_FIXTURES: BusinessTypeView[] = [RENTAL, SCHOOL, OTHER];

/** Sentence helpers a test can assert against without repeating the copy. */
export const nouns = {
  tenant: copy.businesses.accountCount(1, RENTAL.template.accountNoun, 'Tenants'),
};
