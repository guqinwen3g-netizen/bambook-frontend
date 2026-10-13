import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import type { SupplierContractTx } from './supplierContractAccess';
import { supplierFingerprint } from './supplierContractPolicy';
import { verifyNativeSupplierReceiptPosting } from './supplierNativeReceipt';

function fixture() {
  const snapshot = { contractKind: 'purchase', schemaVersion: 1, businessOwnerId: 'business', supplierRelationId: 'raw-supplier', currency: 'CNY', paymentTerms: 'T/T', orderDate: '2026-10-07',
    lines: [{ id: 'PL', orderLineId: 'OL', kind: 'Material', category: 'Fabric', description: 'Actual raw fabric', quantity: '100', unit: 'M', unitPrice: '2', requestedDeliveryDate: '2026-11-01' }],
    sourceProofs: [{ orderId: 'ORDER', orderLineId: 'OL', businessLine: 'fabric', commercial: {}, commercialFingerprint: 'c', mainApprovalId: 'APP', mainApprovalFingerprint: 'a' }] };
  const revision = { id: 'REV', purchaseOrderId: 'PO', status: 'superseded', snapshot, contentFingerprint: supplierFingerprint(snapshot) };
  const fact = { id: 'F', kind: 'purchase_delivery', materialReceiptId: 'MR', commitmentRevisionId: 'REV', purchaseLineId: 'PL', orderLineId: 'OL',
    toKind: 'warehouse', toWarehouseId: 'WH', sourceStockMovementId: 'SM', unit: 'M', quantity: new Prisma.Decimal('60.125'), recordedBy: 'business' };
  const movement = { id: 'SM', type: 'Inbound', itemId: 'ITEM', referenceType: 'SupplierFulfillmentFact', referenceId: 'F', warehouseId: 'WH', unit: 'M',
    quantity: new Prisma.Decimal('60.125'), balanceBefore: new Prisma.Decimal(0), balanceAfter: new Prisma.Decimal('60.125'), operator: 'business' };
  const item = { id: 'ITEM', warehouseId: 'WH', orderId: 'ORDER', unit: 'M' };
  const tx = { supplierFulfillmentFact: { findMany: async () => [fact] }, supplierCommitmentRevision: { findUnique: async () => revision },
    stockMovement: { findUnique: async () => movement }, inventoryItem: { findUnique: async () => item } } as unknown as SupplierContractTx;
  return { tx, fact, revision, movement, item, po: { id: 'PO', businessOwnerId: 'business' },
    receipt: { id: 'MR', purchaseOrderId: 'PO', warehouseId: 'WH', totalReceived: new Prisma.Decimal('60.125') } };
}
describe('native supplier receipt protection from legacy stock-in', () => {
  it('verifies the exact already-posted physical fact, including a superseded approved version, without quality inference', async () => {
    const f = fixture(); expect(await verifyNativeSupplierReceiptPosting(f.tx, f.po, f.receipt, 'WH')).toBe(true);
    expect(await verifyNativeSupplierReceiptPosting(f.tx, { id: 'legacy' }, f.receipt)).toBe(false);
  });
  it.each(['quantity', 'destination', 'version', 'source', 'movement'] as const)('rejects a changed %s instead of creating substitute stock', async change => {
    const f = fixture(); if (change === 'quantity') f.movement.quantity = new Prisma.Decimal('61');
    else if (change === 'destination') f.fact.toWarehouseId = 'OTHER'; else if (change === 'version') f.revision.contentFingerprint = 'invalid';
    else if (change === 'source') f.item.orderId = 'OTHER'; else f.movement.referenceId = 'OTHER';
    await expect(verifyNativeSupplierReceiptPosting(f.tx, f.po, f.receipt)).rejects.toThrow();
  });
});
