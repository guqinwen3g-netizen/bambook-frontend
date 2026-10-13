import { describe, expect, it } from 'vitest';
import { normalizeFabricSupplyTerms, calculateFabricCommission, fabricCommissionFinancialLine } from './fabricCommissionPolicy';

const commission = (id = 'L1', supplier = 'SUP-1', rate = '5') => ({ id, orderId: 'O1', description: id,
  quantity: '100', unit: 'M', unitPrice: '2.5', fabricSupplyMode: 'commission',
  fabricCommissionRate: rate, fabricCommissionSupplierId: supplier });
const branch = (lineId = 'L1', quantity = '100') => ({ id: `B-${lineId}`, orderLineId: lineId,
  revision: 1, actualQuantity: quantity, shippedQuantity: quantity, unit: 'M' });
const shipment = (lineId = 'L1', quantity = '100', shipmentId = 'S1') => ({ shipmentId, shipmentLineId: `${shipmentId}-${lineId}`,
  orderLineId: lineId, quantity, unit: 'M', atd: '2026-10-08', state: 'shipped' });

describe('fabric commission terms and actual whole-order calculation', () => {
  it('keeps absent legacy terms unknown without inferring purchase or commission', () => {
    expect(normalizeFabricSupplyTerms({})).toEqual({ fabricSupplyMode: null, fabricCommissionRate: null, fabricCommissionSupplierId: null });
  });
  it('normalizes explicit percentage and exact paying supplier', () => {
    expect(normalizeFabricSupplyTerms({ fabricSupplyMode: 'commission', fabricCommissionRate: '5.2500', fabricCommissionSupplierId: 'SUP-1' }))
      .toEqual({ fabricSupplyMode: 'commission', fabricCommissionRate: '5.25', fabricCommissionSupplierId: 'SUP-1' });
  });
  it.each(['0', '-1', '100.0001', '5.00001', '5%', 'NaN'])('rejects ambiguous or out-of-range rate %s', rate => {
    expect(() => normalizeFabricSupplyTerms({ ...commission(), fabricCommissionRate: rate })).toThrow();
  });
  it('does not retain commission details on a different or unknown supply mode', () => {
    expect(() => normalizeFabricSupplyTerms({ ...commission(), fabricSupplyMode: 'finished_purchase' })).toThrow();
    expect(() => normalizeFabricSupplyTerms({ fabricCommissionRate: '5' })).toThrow();
    expect(() => normalizeFabricSupplyTerms({ ...commission(), fabricCommissionSupplierId: null })).toThrow();
  });
  it('calculates only the earned commission and groups one settlement by actual supplier', () => {
    const result = calculateFabricCommission([commission(), commission('L2', 'SUP-2', '7.5')],
      [branch(), branch('L2')], [shipment(), shipment('L2')]);
    expect(result.groups).toEqual([
      { supplierId: 'SUP-1', goodsAmount: '250.0000', commissionAmount: '12.5000', lines: [expect.objectContaining({ orderLineId: 'L1', rate: '5', actualGoodsAmount: '250.0000', commissionAmount: '12.5000' })] },
      { supplierId: 'SUP-2', goodsAmount: '250.0000', commissionAmount: '18.7500', lines: [expect.objectContaining({ orderLineId: 'L2', rate: '7.5', commissionAmount: '18.7500' })] },
    ]);
  });
  it('accumulates real partial shipments before applying the approved per-line rate', () => {
    const result = calculateFabricCommission([commission()], [branch()], [shipment('L1', '40', 'S1'), shipment('L1', '60', 'S2')]);
    expect(result.groups[0]).toMatchObject({ goodsAmount: '250.0000', commissionAmount: '12.5000' });
    expect(result.groups[0].lines[0].shipmentLineIds).toEqual(['S1-L1', 'S2-L1']);
  });
  it('requires every normal and commission row to have actually shipped before the one order settlement', () => {
    const normal = { ...commission('NORMAL'), fabricSupplyMode: 'finished_purchase', fabricCommissionRate: null, fabricCommissionSupplierId: null };
    expect(() => calculateFabricCommission([commission(), normal], [branch(), branch('NORMAL')], [shipment()])).toThrow();
    const result = calculateFabricCommission([commission(), normal], [branch(), branch('NORMAL')], [shipment(), shipment('NORMAL')]);
    expect(result.groups).toHaveLength(1); expect(result.groups[0].goodsAmount).toBe('250.0000');
  });
  it('rejects pending departure, unshipped real remainder and unknown completion', () => {
    expect(() => calculateFabricCommission([commission()], [branch()], [{ ...shipment(), atd: null }])).toThrow();
    expect(() => calculateFabricCommission([commission()], [{ ...branch(), shippedQuantity: '40' }], [shipment('L1', '40')])).toThrow();
    expect(() => calculateFabricCommission([commission()], [], [shipment()])).toThrow();
    expect(() => calculateFabricCommission([commission()], [branch()], [{ ...shipment(), state: 'reserved' }])).toThrow();
  });
  it('does not guess missing unit/price or duplicate a physical shipment line', () => {
    expect(() => calculateFabricCommission([{ ...commission(), unitPrice: null }], [branch()], [shipment()])).toThrow();
    expect(() => calculateFabricCommission([commission()], [branch()], [{ ...shipment(), unit: 'YD' }])).toThrow();
    expect(() => calculateFabricCommission([commission()], [branch()], [shipment(), shipment()])).toThrow();
  });
  it('uses exact Decimal arithmetic and explicit four-place currency rounding', () => {
    const result = calculateFabricCommission([{ ...commission(), quantity: '0.1', unitPrice: '0.2', fabricCommissionRate: '12.5' }],
      [branch('L1', '0.1')], [shipment('L1', '0.1')]);
    expect(result.groups[0]).toMatchObject({ goodsAmount: '0.0200', commissionAmount: '0.0025' });
  });
  it('financial basis excludes fulfillment projections but detects an actual rate or price change', () => {
    const source = commission();
    expect(fabricCommissionFinancialLine({ ...source, status: 'Delivered', shipmentAmount: '999', notes: 'later note' }))
      .toEqual(fabricCommissionFinancialLine(source));
    expect(fabricCommissionFinancialLine({ ...source, unitPrice: '3' })).not.toEqual(fabricCommissionFinancialLine(source));
    expect(fabricCommissionFinancialLine({ ...source, fabricCommissionRate: '6' })).not.toEqual(fabricCommissionFinancialLine(source));
  });
});
