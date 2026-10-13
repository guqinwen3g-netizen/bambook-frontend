import { describe, it, expect } from 'vitest';
import { parseEuropeanNumber } from '../utils/numbers';

describe('parseEuropeanNumber', () => {
  it.each([
    ['3.600,00', 3600],
    ['103.680,00', 103680],
    ['8,10', 8.1],
    ['0,00', 0],
    ['1.000.000,5', 1000000.5],
    ['42930', 42930],
  ] as const)('%s -> %s', (input, expected) => {
    expect(parseEuropeanNumber(input)).toBeCloseTo(expected, 6);
  });

  it('returns NaN for non-numeric input', () => {
    expect(Number.isNaN(parseEuropeanNumber('abc'))).toBe(true);
    expect(Number.isNaN(parseEuropeanNumber(''))).toBe(true);
  });
});
