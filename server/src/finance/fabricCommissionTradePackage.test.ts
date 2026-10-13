import { describe, expect, it } from 'vitest';
import { buildBusinessShipmentCiSnapshot } from '../customs/businessShipmentCi';
import type { ShipmentDocumentSource } from '../shipping/shipmentDocumentSource';

function source() {
  const order = { id: 'order', status: 'Confirmed', finalContractNumber: 'CONTRACT', currency: 'USD', customerRelationId: 'customer',
    billToName: 'Customer', billToRelationId: 'customer', billToAddress: 'Customer bill address', shipToName: 'Customer', shipToAddress1: 'Delivery',
    shipToAddress2: null, shipToCountry: 'GB', businessLine: 'fabric', paymentInstrument: 'T/T', paymentTerms: 'T/T 30 days', deliveryTerms: 'FOB' };
  const lines = ['normal', 'commission'].map(id => ({ id: `ship-${id}`, orderId: 'order', orderLineId: id, quantity: '100', unit: 'M', unitPrice: '2',
    productionBatchIds: [`batch-${id}`], originalOrderLine: { id, description: id, materialCode: id,
      fabricSupplyMode: id === 'commission' ? 'commission' : 'finished_purchase', fabricCommissionRate: id === 'commission' ? '5' : null,
      fabricCommissionSupplierId: id === 'commission' ? 'supplier' : null } }));
  return { order, source: { kind: 'physical', cartonCoverageComplete: true, shipment: { id: 'shipment' }, orders: [order], lines,
    allocations: lines.map(line => ({ id: `alloc-${line.id}`, orderLineId: line.orderLineId, actualQty: '100', status: 'Confirmed' })) } as unknown as ShipmentDocumentSource };
}
describe('mixed fabric responsibility trade CI package', () => {
  it('makes complete normal and commission trade subpackages with distinct exact keys', () => {
    const { source: s } = source(), normal = buildBusinessShipmentCiSnapshot(s, { lineIds: ['ship-normal'] }, []);
    const commission = buildBusinessShipmentCiSnapshot(s, { lineIds: ['ship-commission'] }, []);
    expect(normal.lines).toMatchObject([{ orderLineId: 'normal', fabricSupplyMode: 'finished_purchase', amount: '200' }]);
    expect(commission.lines).toMatchObject([{ orderLineId: 'commission', fabricSupplyMode: 'commission', fabricCommissionRate: '5', fabricCommissionSupplierId: 'supplier' }]);
    expect(normal.packageKey).not.toBe(commission.packageKey);
    expect(() => buildBusinessShipmentCiSnapshot(s, { lineIds: ['ship-normal', 'ship-commission'] }, [])).toThrow(/责任/);
  });
  it('refuses an incomplete responsibility package', () => {
    const { source: s } = source(); s.lines.push({ ...s.lines[0], id: 'ship-normal-2' }); s.allocations[0].actualQty = '200';
    expect(() => buildBusinessShipmentCiSnapshot(s, { lineIds: ['ship-normal'] }, [])).toThrow(/全部/);
  });
  it('does not assume that a real LC permits splitting the full contract CI', () => {
    const { source: s, order } = source(); order.paymentInstrument = 'L/C';
    const lc = [{ id: 'LC', orderId: 'order', status: 'Issued', lcNumber: 'ACTUAL-LC' }];
    expect(() => buildBusinessShipmentCiSnapshot(s, { lineIds: ['ship-normal'] }, lc)).toThrow(/全部/);
    const all = buildBusinessShipmentCiSnapshot(s, { lineIds: ['ship-normal', 'ship-commission'] }, lc);
    expect(all.lines).toHaveLength(2); expect(all.letterOfCredit.lcNumber).toBe('ACTUAL-LC'); expect(all.totalAmount).toBe('400');
  });
});
