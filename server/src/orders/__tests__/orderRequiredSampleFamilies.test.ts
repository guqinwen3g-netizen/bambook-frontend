import { describe, expect, it } from 'vitest';
import { normalizeRequiredSampleFamilies, readRequiredSampleFamilies } from '../orderRequiredSampleFamilies';

describe('frozen required order sample families', () => {
  it('freezes mandatory garment and fabric families with optional fabric RC only when selected', () => {
    expect(normalizeRequiredSampleFamilies({ type: 'garment' })).toEqual(['garment_pp', 'garment_ship']);
    expect(normalizeRequiredSampleFamilies({ businessLine: 'fabric' })).toEqual(['fabric_eps', 'fabric_ss']);
    expect(normalizeRequiredSampleFamilies({ type: 'fabric' }, ['fabric_rc', 'fabric_ss', 'fabric_eps']))
      .toEqual(['fabric_eps', 'fabric_ss', 'fabric_rc']);
  });

  it.each([
    ['missing mandatory', { type: 'garment' }, ['garment_pp']],
    ['wrong domain', { type: 'fabric' }, ['fabric_eps', 'fabric_ss', 'garment_pp']],
    ['duplicate family', { type: 'fabric' }, ['fabric_eps', 'fabric_ss', 'fabric_ss']],
    ['unknown family', { type: 'fabric' }, ['fabric_eps', 'fabric_ss', 'fabric_top']],
  ])('rejects %s instead of creating an incomplete gate', (_label, order, families) => {
    expect(() => normalizeRequiredSampleFamilies(order, families)).toThrow();
  });

  it('keeps historical null/empty/corrupt snapshots unknown instead of defaulting them', () => {
    expect(readRequiredSampleFamilies(null, { type: 'garment' })).toBeNull();
    expect(readRequiredSampleFamilies([], { type: 'garment' })).toBeNull();
    expect(readRequiredSampleFamilies(['fabric_eps'], { type: 'garment' })).toBeNull();
  });
});
