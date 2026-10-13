import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import type { SupplierContractTx } from './supplierContractAccess';
import { supplierContractMemoryFixture } from './supplierContractMemoryFixture';
import { normalizeSupplierContractDraft } from './supplierContractPolicy';
import { reconcileSupplierDemandPlan } from './supplierDemandAllocation';

function fixture(kind: 'purchase' | 'processing') {
  const f = supplierContractMemoryFixture();
  f.put('procurementDemand', { id: 'D', status: 'Ready', orderId: 'order-1', orderLineId: 'line-1', assigneeId: 'business', revision: 1,
    kind: kind === 'purchase' ? 'Material' : 'ProcessingService', requiredQuantity: new Prisma.Decimal('100'), unit: 'M' });
  const draft = normalizeSupplierContractDraft(kind, { supplierRelationId: 'supplier-1', currency: 'CNY', paymentTerms: 'T/T', orderDate: '2026-10-07',
    lines: [{ id: 'L', demandId: 'D', orderLineId: 'line-1', kind: 'Material', category: 'Fabric', processType: 'Dyeing', description: 'Actual requirement', quantity: '60.125', unit: 'M', unitPrice: '2' }] });
  return { f, tx: f.db as unknown as SupplierContractTx, draft };
}
describe('exact supplier demand planning allocations', () => {
  it.each(['purchase', 'processing'] as const)('links %s to its own exact line and preserves planned allocations until a changed promise is approved', async kind => {
    const { f, tx, draft } = fixture(kind);
    const first = await reconcileSupplierDemandPlan(tx, kind, 'CONTRACT', draft, 'business', { apply: true });
    expect(first.lines[0].demandRevision).toBe(2);
    expect(f.all('purchaseDemandAllocation')[0]).toMatchObject(kind === 'purchase' ? { purchaseOrderId: 'CONTRACT', purchaseLineId: 'L', outsourcingOrderId: null }
      : { outsourcingOrderId: 'CONTRACT', outsourcingLineId: 'L', purchaseOrderId: null });
    const proposed = await reconcileSupplierDemandPlan(tx, kind, 'CONTRACT', { ...first, lines: [{ ...first.lines[0], quantity: '70' }] }, 'business');
    expect(f.all('purchaseDemandAllocation')[0].quantity.toString()).toBe('60.125');
    await reconcileSupplierDemandPlan(tx, kind, 'CONTRACT', proposed, 'business', { frozen: true, apply: true });
    expect(f.all('purchaseDemandAllocation')[0].quantity.toString()).toBe('70');
    expect(f.all('purchaseDemandAllocation')).toHaveLength(1);
  });
  it('rejects stale frozen demand, incompatible kind, wrong assignee and total over-allocation', async () => {
    const { f, tx, draft } = fixture('purchase');
    const first = await reconcileSupplierDemandPlan(tx, 'purchase', 'A', draft, 'business', { apply: true });
    await expect(reconcileSupplierDemandPlan(tx, 'purchase', 'A', { ...first, lines: [{ ...first.lines[0], demandRevision: 1 }] }, 'business', { frozen: true })).rejects.toMatchObject({ code: 'DEMAND_CHANGED' });
    await expect(reconcileSupplierDemandPlan(tx, 'purchase', 'A', first, 'other')).rejects.toMatchObject({ code: 'DEMAND_NOT_ASSIGNEE' });
    await expect(reconcileSupplierDemandPlan(tx, 'processing', 'B', first, 'business')).rejects.toMatchObject({ code: 'DEMAND_SOURCE_MISMATCH' });
    await expect(reconcileSupplierDemandPlan(tx, 'purchase', 'B', { ...draft, lines: [{ ...draft.lines[0], id: 'L2', quantity: '40' }] }, 'business', { apply: true })).rejects.toMatchObject({ code: 'DEMAND_OVER_ALLOCATED' });
    f.put('supplierFulfillmentFact', { id: 'FACT', purchaseLineId: 'L', kind: 'purchase_delivery' });
    await expect(reconcileSupplierDemandPlan(tx, 'purchase', 'A', { ...first, lines: [{ ...first.lines[0], quantity: '50' }] }, 'business', { apply: true })).rejects.toMatchObject({ code: 'FULFILLED_ALLOCATION_REVIEW_REQUIRED' });
    expect(f.all('purchaseDemandAllocation')[0].quantity.toString()).toBe('60.125');
  });
});
