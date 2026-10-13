import { describe, expect, it } from 'vitest';
import { submittedOrderLinePatchRejection } from '../orderLineMutationService';

describe('submitted order line write policy', () => {
  it('allows commercial edits while the order is still a draft', () => {
    expect(submittedOrderLinePatchRejection('Pending', { unitPrice: 12, sizeBreakdown: [{ size: 'M', quantity: 10 }] })).toBeNull();
  });

  it.each([
    ['product identity', { materialCode: 'FAB-2' }],
    ['unit price', { unitPrice: 12 }],
    ['specification', { sizeBreakdown: [{ size: 'M', quantity: 10 }] }],
    ['delivery commitment', { deliveryDate: '2026-12-01' }],
    ['split shipment commitment', { partialShipmentAllowed: true }],
    ['manual quantity tolerance', { tolerancePercent: '5', toleranceSource: 'line_override' }],
    ['fulfillment state', { status: 'Shipped' }],
    ['mixed note and commercial change', { notes: 'note', unitPrice: 12 }],
  ])('rejects %s after submission', (_name, patch) => {
    expect(submittedOrderLinePatchRejection('Confirmed', patch)).toContain('订单变更审批');
  });

  it('allows a harmless note after submission but rejects direct fulfillment data', () => {
    expect(submittedOrderLinePatchRejection('Confirmed', { notes: 'customer follow-up' })).toBeNull();
    expect(submittedOrderLinePatchRejection('Confirmed', { notes: 'note', shipmentQuantity: 10 })).toContain('对应业务模块');
  });
});
