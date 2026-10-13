import { describe, expect, it } from 'vitest';
import { normalizeDevelopmentQcMeasurements } from '../developmentQcMeasurements';
describe('actual per-piece measurement values', () => {
 it('retains precision and units without converting unknown size or defaulting values', () => { expect(normalizeDevelopmentQcMeasurements([{ piece: '衣1', position: '胸宽', size: null, value: '040.00', unit: 'cm' }, { piece: '衣2', position: '胸宽', value: '16.000', unit: 'inch' }])).toEqual([{ piece: '衣1', position: '胸宽', size: null, value: '040.00', unit: 'cm' }, { piece: '衣2', position: '胸宽', size: null, value: '16.000', unit: 'inch' }]); });
 it.each(['Infinity','NaN','1e999','40cm','', '  '])('rejects nonfinite/non-numeric original value %s', value => { expect(() => normalizeDevelopmentQcMeasurements([{ piece: '衣1', position: '胸宽', value, unit: 'cm' }])).toThrow(); });
 it('does not guess piece, position or unit and does not attach per-row opinion/photo fields', () => { for (const patch of [{ piece: '' }, { position: '' }, { unit: '' }, { opinion: 'photo issue' }]) expect(() => normalizeDevelopmentQcMeasurements([{ piece: '衣1', position: '胸宽', value: '40.0', unit: 'cm', ...patch }])).toThrow(); });
});
