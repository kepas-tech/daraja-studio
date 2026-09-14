import { describe, it, expect } from 'vitest';
import { money, parseMoney, phone, normalizeKe, when } from '../format';

describe('format', () => {
  it('money shows whole shillings without cents and cents when present', () => {
    expect(money(123400)).toBe('KES 1,234');
    expect(money(123450)).toBe('KES 1,234.50');
    expect(money(100)).toBe('KES 1');
    expect(money(null)).toBe('—');
  });
  it('parseMoney accepts plain, grouped and decimal input', () => {
    expect(parseMoney('1234')).toBe(123400);
    expect(parseMoney('1,234')).toBe(123400);
    expect(parseMoney('1234.50')).toBe(123450);
    expect(parseMoney('1,234.5')).toBe(123450);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
  });
  it('phone displays a Kenyan msisdn the way people write it', () => {
    expect(phone('254700123456')).toBe('0700 123 456');
    expect(phone('254110000000')).toBe('0110 000 000');
    expect(phone(null)).toBe('—');
    expect(phone('RI6BZTPXNM')).toBe('RI6BZTPXNM');
  });
  it('normalizeKe accepts the four forms and rejects the rest', () => {
    for (const s of ['0700123456', '+254700123456', '254700123456', '0700 123 456', '+254 700 123456']) expect(normalizeKe(s)).toBe('254700123456');
    expect(normalizeKe('0110000000')).toBe('254110000000');
    expect(normalizeKe('12345')).toBeNull();
    expect(normalizeKe('255700123456')).toBeNull();
    expect(normalizeKe('')).toBeNull();
  });
  it('when formats or dashes', () => {
    expect(when(null)).toBe('—');
    expect(when('2026-09-06T11:00:00.000Z')).toMatch(/2026/);
  });
});
