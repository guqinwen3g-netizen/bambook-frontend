import { describe, expect, it } from 'vitest';
import { internalMetres, normalizeGarmentFulfillment, assertAllocationCapacity } from '../internalFabricPolicy';

describe('internal fabric planning quantities', () => {
  it('keeps decimal metres exact and refuses implicit unit conversion or rounding', () => {
    expect(internalMetres('99999999999999.9999').toString()).toBe('99999999999999.9999');
    expect(internalMetres('0.0001').toString()).toBe('0.0001');
    for (const value of [0, '0', '-1', '1.00001', '100000000000000', 'NaN', '1e3']) {
      expect(() => internalMetres(value)).toThrow();
    }
  });

  it('requires an explicit garment mode and CMT scope instead of guessing a historical value', () => {
    expect(normalizeGarmentFulfillment({ fulfillmentMode: 'cmt', cmtIncludedItems: [] }))
      .toEqual({ fulfillmentMode: 'cmt', cmtIncludedItems: [] });
    expect(normalizeGarmentFulfillment({ fulfillmentMode: 'trims_cmt', cmtIncludedItems: [' sewing ', 'packing'] }))
      .toEqual({ fulfillmentMode: 'trims_cmt', cmtIncludedItems: ['sewing', 'packing'] });
    expect(normalizeGarmentFulfillment({ fulfillmentMode: 'full_package', cmtIncludedItems: [] }).fulfillmentMode).toBe('full_package');
    for (const input of [{}, { fulfillmentMode: 'CMT' }, { fulfillmentMode: 'cmt' }, { fulfillmentMode: 'cmt', cmtIncludedItems: ['x', 'x'] }])
      expect(() => normalizeGarmentFulfillment(input)).toThrow();
  });

  it('keeps cumulative planning conservative with precise fractions', () => {
    expect(assertAllocationCapacity('1.0001', ['0.5000', '0.5001']).toString()).toBe('0');
    expect(assertAllocationCapacity('1.0001', ['0.5']).toString()).toBe('0.5001');
    expect(() => assertAllocationCapacity('1', ['0.5000', '0.5001'])).toThrow();
  });
});
