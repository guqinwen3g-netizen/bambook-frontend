import { describe, expect, it, vi } from 'vitest';
vi.mock('../shipmentPhysicalAllocationService', () => ({ lockLegacyShipmentAllocationWrite: vi.fn(async () => undefined) }));
import { createAllocationService } from '../allocationService';

function fixture() {
  const shipment = { id: 'S1', orderId: 'O1', status: 'Draft', deletedAt: null };
  const order = { id: 'O1', deletedAt: null, customerRelationId: 'C1', businessLine: 'garment', customer: 'Customer' };
  const legacy = { id: 'A1', shipmentId: 'S1', orderId: 'O1', orderLineId: null, plannedQty: '10', actualQty: null,
    unit: 'pcs', status: 'Planned', createdAt: 1n, updatedAt: 1n };
  const tx: any = {
    shipment: { findUnique: vi.fn(async () => shipment) },
    order: { findUnique: vi.fn(async () => order) },
    shipmentOrderAllocation: {
      findMany: vi.fn(async () => [legacy]),
      findUnique: vi.fn(async () => legacy),
    },
    productionBatch: { count: vi.fn(async () => 0) },
    shipmentProductionAllocation: { count: vi.fn(async () => 0) },
    $queryRaw: vi.fn(async () => []),
  };
  const transaction = vi.fn(async (run: any) => run(tx));
  return { service: createAllocationService({ $transaction: transaction } as any), tx, transaction, legacy };
}

describe('legacy shipment allocation is exact-order-line only', () => {
  it('rejects creating a null-line allocation before opening a transaction', async () => {
    const { service, transaction } = fixture();
    const result = await service.createAllocation('S1', { orderId: 'O1', actualQty: 10 }, 'actor');
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(['update', 'delete'] as const)('keeps historical null-line allocation read-only for %s', async (action) => {
    const { service } = fixture();
    const result = action === 'update'
      ? await service.updateAllocation('S1', 'A1', { plannedQty: 20 }, 'actor')
      : await service.deleteAllocation('S1', 'A1', 'actor');
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });
});
