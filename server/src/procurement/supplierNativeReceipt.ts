import { Prisma } from '@prisma/client';
import type { SupplierContractTx } from './supplierContractAccess';
import { supplierFingerprint } from './supplierContractPolicy';
import { supplierSnapshot } from './supplierContractStore';

/** Native physical receipts are posted with their exact fulfillment command.
 * An old MaterialReceived replay may verify that posting, never repeat it or
 * reinterpret a point count as a professional quality acceptance. */
export async function verifyNativeSupplierReceiptPosting(tx: SupplierContractTx, po: {
  id: string; businessOwnerId?: string | null; approvedCommitmentRevisionId?: string | null;
}, receipt: { id: string; purchaseOrderId: string; warehouseId: string | null; totalReceived: Prisma.Decimal },
payloadWarehouseId?: string | null): Promise<boolean> {
  if (!po.businessOwnerId && !po.approvedCommitmentRevisionId) return false;
  const facts = await tx.supplierFulfillmentFact.findMany({ where: { materialReceiptId: receipt.id } });
  if (!facts.length || receipt.purchaseOrderId !== po.id || !receipt.warehouseId
    || payloadWarehouseId && payloadWarehouseId !== receipt.warehouseId)
    throw new Error('原生收料缺少准确实际交接或仓库身份，禁止由旧入库联动补造。');
  let received = new Prisma.Decimal(0);
  for (const fact of facts) {
    const revision = await tx.supplierCommitmentRevision.findUnique({ where: { id: fact.commitmentRevisionId } });
    if (fact.kind !== 'purchase_delivery' || fact.toKind !== 'warehouse' || fact.toWarehouseId !== receipt.warehouseId
      || !fact.purchaseLineId || !fact.sourceStockMovementId || !revision || revision.purchaseOrderId !== po.id
      || !['approved', 'superseded'].includes(revision.status) || supplierFingerprint(revision.snapshot) !== revision.contentFingerprint)
      throw new Error('原生收料的准确合同批准版或实际到仓证据不一致。');
    const snapshot = supplierSnapshot(revision.snapshot, 'purchase'), line = snapshot.lines.find(row => row.id === fact.purchaseLineId);
    const source = snapshot.sourceProofs.find(row => row.orderLineId === fact.orderLineId);
    const movement = await tx.stockMovement.findUnique({ where: { id: fact.sourceStockMovementId } });
    const item = movement ? await tx.inventoryItem.findUnique({ where: { id: movement.itemId } }) : null;
    if (!line || !source || line.orderLineId !== fact.orderLineId || line.unit !== fact.unit || !movement || !item
      || movement.type !== 'Inbound' || movement.referenceType !== 'SupplierFulfillmentFact' || movement.referenceId !== fact.id
      || movement.warehouseId !== receipt.warehouseId || item.warehouseId !== receipt.warehouseId || item.orderId !== source.orderId
      || movement.unit !== fact.unit || item.unit !== fact.unit || movement.operator !== fact.recordedBy
      || !new Prisma.Decimal(movement.quantity).eq(fact.quantity)
      || !new Prisma.Decimal(movement.balanceAfter).minus(movement.balanceBefore).eq(fact.quantity))
      throw new Error('原生收料与已原子提交的准确实物流水不一致，禁止重复入库。');
    received = received.plus(fact.quantity);
  }
  if (!received.eq(receipt.totalReceived)) throw new Error('原生收料实际总量与准确交接事实不一致。');
  return true;
}
