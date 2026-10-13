import { describe, expect, it } from 'vitest';
import { calculateExchange } from './exchangeCalculation';

describe('Independent exact currency estimate', () => {
  it('preserves large values without Number and converts via the same CNY base', () => {
    expect(calculateExchange('90071992547409.1234', '7.2', '1')).toBe('648518346341345.6885');
    expect(calculateExchange('100', '7.2', '8')).toBe('90.0000');
    expect(calculateExchange('100', '1', '7.2')).toBe('13.8889');
  });
  it('preserves zero, identity and exact eight-place rates with explicit half-up rounding', () => {
    expect(calculateExchange('0', '7.2', '8')).toBe('0.0000');
    expect(calculateExchange('12.9999', '1', '1')).toBe('12.9999');
    expect(calculateExchange('1', '0.00000001', '0.00000003')).toBe('0.3333');
    expect(calculateExchange('0.0001', '1', '2')).toBe('0.0001');
  });
  it.each(['', '0', '-1', '1e3', '7.123456789', '10000000000'])('refuses missing or invalid supplied rate %s', rate => {
    expect(() => calculateExchange('1', rate, '1')).toThrow();
    expect(() => calculateExchange('1', '1', rate)).toThrow();
  });
  it.each(['', '-1', '1.00001', '100000000000000', 'NaN'])('refuses invalid amount %s rather than substituting zero', amount => {
    expect(() => calculateExchange(amount, '1', '1')).toThrow();
  });
});
