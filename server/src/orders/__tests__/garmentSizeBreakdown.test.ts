import { describe, expect, it } from 'vitest';
import { GarmentSizeBreakdownError, normalizeGarmentSizeBreakdown } from '../garmentSizeBreakdown';

describe('garment order-line size matrix', () => {
  it('trims size labels, preserves their mapping, and requires exact total quantity', () => {
    expect(normalizeGarmentSizeBreakdown({ ' S ': 20, M: 30, L: 50 }, '100.0000'))
      .toEqual({ S: 20, M: 30, L: 50 });
    expect(() => normalizeGarmentSizeBreakdown({ S: 20, M: 29, L: 50 }, '100'))
      .toThrow('尺码数量合计 99 必须等于订单条目数量 100');
  });

  it.each([
    ['fractional', { S: 1.5 }],
    ['negative', { S: -1 }],
    ['unsafe integer', { S: Number.MAX_SAFE_INTEGER + 1 }],
    ['blank size', { ' ': 1 }],
    ['non-object', [{ size: 'S', quantity: 1 }]],
  ])('rejects %s size data', (_case, value) => {
    expect(() => normalizeGarmentSizeBreakdown(value, '1')).toThrow(GarmentSizeBreakdownError);
  });

  it('allows an absent or empty matrix for explicitly unbroken legacy/one-size lines', () => {
    expect(normalizeGarmentSizeBreakdown(undefined, '25')).toBeNull();
    expect(normalizeGarmentSizeBreakdown({}, '25')).toBeNull();
  });
});
