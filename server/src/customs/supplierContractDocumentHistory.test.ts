import { beforeEach, describe, expect, it, vi } from 'vitest';
const access = vi.hoisted(() => ({ actor: vi.fn(), scope: vi.fn(), native: vi.fn() }));
vi.mock('../shipping/shipmentDocumentSource', () => ({ currentDocumentActor: access.actor }));
vi.mock('../orders/orderLineWriteAccess', () => ({ freshOrderLineScope: access.scope }));
vi.mock('./supplierContractDocumentArchive', () => ({ readSupplierContractTradeDocumentInTx: access.native }));
import { readSupplierDocumentHistoryInTx } from './supplierContractDocumentHistory';
const actor = { userId: 'owner', permissions: ['orders:read', 'procurement:read'] } as any;
function db() {
  return { tradeDocument: { findFirst: vi.fn(async () => ({ id: 'TD', type: 'PurchaseOrder', domain: 'procurement', sourceRef: 'OLD-PO', orderId: 'O', deletedAt: null })) },
    purchaseOrder: { findFirst: vi.fn(async () => ({ id: 'OLD-PO', orderId: 'O', lines: [{ orderLineId: 'L' }] })) }, outsourcingOrder: { findFirst: vi.fn(async () => null) },
    orderLine: { findMany: vi.fn(async () => [{ id: 'L', orderId: 'O' }]) }, order: { findFirst: vi.fn(async () => ({ id: 'O' })) },
    documentVersion: { findMany: vi.fn(async () => [{ id: 'V', documentId: 'TD', version: 1, content: { source: 'domain', sourceRef: 'OLD-PO' } }]) } } as any;
}
describe('legacy supplier history stays readable without manufacturing approval', () => {
  beforeEach(() => { vi.clearAllMocks(); access.actor.mockResolvedValue(actor); access.scope.mockResolvedValue({ ownerId: actor.userId }); });
  it('returns the original historical header and version with explicit unknown approval proof', async () => {
    const tx = db(), result = await readSupplierDocumentHistoryInTx(tx, 'TD', actor);
    expect(result).toMatchObject({ native: false, orderIds: ['O'], proofState: 'legacy_approval_unknown', version: { id: 'V' } });
    expect(access.native).not.toHaveBeenCalled();
  });
  it('hides history if any accurate parent is no longer in the current order range', async () => {
    const tx = db(); tx.order.findFirst.mockResolvedValue(null);
    await expect(readSupplierDocumentHistoryInTx(tx, 'TD', actor)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('does not give unassigned legacy history to a restricted business reader', async () => {
    const tx = db(); tx.tradeDocument.findFirst.mockResolvedValue({ id: 'TD', type: 'PurchaseOrder', sourceRef: null, orderId: null }); tx.purchaseOrder.findFirst.mockResolvedValue(null);
    await expect(readSupplierDocumentHistoryInTx(tx, 'TD', actor)).rejects.toMatchObject({ statusCode: 404 });
    access.scope.mockResolvedValue({});
    expect(await readSupplierDocumentHistoryInTx(tx, 'TD', actor)).toMatchObject({ native: false, orderIds: [], proofState: 'legacy_approval_unknown' });
  });
  it('cannot downgrade native provenance to the legacy reader by removing its source reference', async () => {
    const tx = db(); tx.tradeDocument.findFirst.mockResolvedValue({ id: 'TD', type: 'Other', domain: 'customs', sourceRef: null, filePath: 'trade-documents/supplier-protected.pdf' });
    access.native.mockRejectedValue({ code: 'SOURCE_PROOF_UNKNOWN', statusCode: 409 });
    await expect(readSupplierDocumentHistoryInTx(tx, 'TD', actor)).rejects.toMatchObject({ statusCode: 409 });
  });
});
