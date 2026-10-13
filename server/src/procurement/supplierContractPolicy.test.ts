import { describe, expect, it } from 'vitest';
import { normalizeSupplierContractDraft, assertSupplierContractsCompatible } from './supplierContractPolicy';

const purchase = (overrides: Record<string, unknown> = {}) => ({
  requestKey: 'create-first-purchase', supplierRelationId: 'supplier-1', currency: 'CNY', paymentTerms: 'T/T 30 days',
  mainDeliveryLocation: { kind: 'supplier', relationId: 'processor-1', address: 'Actual processor receiving address' },
  orderDate: '2026-10-07',
  lines: [{ orderLineId: 'line-1', kind: 'Material', category: 'Fabric', description: 'Raw fabric', specification: '100% cotton', quantity: '12.1250', unit: 'M', unitPrice: '2.5000', requestedDeliveryDate: '2026-11-01' }],
  ...overrides,
});

describe('supplier contract commercial compatibility', () => {
  it('combines same-type demands on the four common terms while preserving independent line dates and exact decimal prices', () => {
    const first = normalizeSupplierContractDraft('purchase', purchase());
    const second = normalizeSupplierContractDraft('purchase', purchase({ lines: [
      { orderLineId: 'line-2', kind: 'FinishedGoods', description: 'Finished fabric', specification: 'Other specification', quantity: '1', unit: 'M', unitPrice: '4', requestedDeliveryDate: '2026-12-01' },
    ] }));
    expect(() => assertSupplierContractsCompatible(first, second)).not.toThrow();
    expect(first.lines[0]).toMatchObject({ quantity: '12.125', unitPrice: '2.5', amount: '30.3125', requestedDeliveryDate: '2026-11-01' });
    expect(second.lines[0].requestedDeliveryDate).toBe('2026-12-01');
  });
});
