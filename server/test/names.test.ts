import { describe, it, expect } from 'vitest';
import { joinPersonName, personName } from '../src/util/names.js';

describe('personName', () => {
  it('drops the phone Safaricom repeats in front of the name', () => {
    expect(personName('254712345678 - JANE DOE')).toBe('JANE DOE');
    expect(personName('0700123456 - Jane Doe')).toBe('Jane Doe');
    expect(personName('600999 - ACME')).toBe('ACME');
  });

  it('keeps a name that has no phone in front of it', () => {
    expect(personName('Jane Doe')).toBe('Jane Doe');
  });

  it('reads the Pull API placeholder as no name at all', () => {
    expect(personName('MPESA')).toBeNull();
    expect(personName(' mpesa ')).toBeNull();
  });

  it('does not call a bare number a name', () => {
    expect(personName('254712345678')).toBeNull();
    expect(personName('   ')).toBeNull();
    expect(personName('')).toBeNull();
    expect(personName(null)).toBeNull();
    expect(personName(undefined)).toBeNull();
  });

  it('tidies the spacing without touching the words', () => {
    expect(personName('  Jane   Wanjiru  ')).toBe('Jane Wanjiru');
  });

  it('splits on the first separator only', () => {
    expect(personName('254712345678 - JANE - DOE')).toBe('JANE - DOE');
  });
});

describe('joinPersonName', () => {
  it('joins the three parts Safaricom sends', () => {
    expect(joinPersonName('Jane', 'Wanjiru', 'Doe')).toBe('Jane Wanjiru Doe');
    expect(joinPersonName('Jane', '', 'Doe')).toBe('Jane Doe');
    expect(joinPersonName('Jane', undefined, null)).toBe('Jane');
    expect(joinPersonName()).toBeNull();
  });

  it('cleans the joined value the same way', () => {
    expect(joinPersonName('254712345678 - JANE', 'WANJIRU', 'DOE')).toBe('JANE WANJIRU DOE');
    expect(joinPersonName('', 'MPESA', '')).toBeNull();
  });
});
