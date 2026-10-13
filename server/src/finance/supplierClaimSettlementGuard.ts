import { Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';

type SupplierClaimRefusal = Readonly<{ code: string; statusCode: number; message: string }>;
const supplierClaimRefusals = new WeakMap<object, SupplierClaimRefusal>();
export const readSupplierClaimRefusal = (error: unknown): SupplierClaimRefusal | undefined =>
  typeof error === 'object' && error !== null ? supplierClaimRefusals.get(error) : undefined;

const sourceConflict = (message: string): never => {
  const error = Object.assign(new Error(message), { code: 'SOURCE_CLAIM_CONFLICT', statusCode: 409 });
  supplierClaimRefusals.set(error, Object.freeze({ code: error.code, statusCode: error.statusCode, message }));
  throw error;
};

/** Supplier claim invoices are linked by the persisted claimInvoiceId, including
 * historical invoices whose generic sourceType/sourceId were never filled.
 * Every mutation shares MaterialReceipt -> MaterialReturn -> Invoice -> Voucher
 * lock order with the native confirmation/settlement transaction. */
export async function lockSupplierClaimInvoice(tx: any, invoiceId: string): Promise<any | null> {
  const rows = await tx.$queryRawUnsafe('SELECT * FROM "MaterialReturn" WHERE "claimInvoiceId" = $1 AND "deletedAt" IS NULL ORDER BY id', invoiceId);
  if (!rows.length) {
    await tx.$queryRawUnsafe('SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', invoiceId);
    return null;
  }
  if (rows.length !== 1 || rows[0].type !== 'claim') sourceConflict('索赔贷项的退料来源不唯一或类型不一致，请先核对来源。');
  const observed = rows[0];
  await tx.$queryRawUnsafe('SELECT id FROM "MaterialReceipt" WHERE id = $1 FOR UPDATE', observed.receiptId);
  await tx.$queryRawUnsafe('SELECT id FROM "MaterialReturn" WHERE id = $1 FOR UPDATE', observed.id);
  const current = await tx.materialReturn.findUnique({ where: { id: observed.id } });
  if (!current || current.deletedAt || current.type !== 'claim' || current.receiptId !== observed.receiptId
      || current.claimInvoiceId !== invoiceId || !['confirmed', 'settled'].includes(current.status)) {
    sourceConflict('索赔贷项来源已变化，不能继续核销，请刷新后核对。');
  }
  await tx.$queryRawUnsafe('SELECT id FROM "Invoice" WHERE id = $1 FOR UPDATE', invoiceId);
  return current;
}

/** Preserve the settlement history; loss of its factual basis reopens the
 * current projection in the SAME transaction as the financial correction. */
export async function invalidateSupplierClaimSettlement(tx: any, source: any | null, params: {
  invoiceId: string; triggerId: string; actorId: string; operation: string; ip?: string | null;
}) {
  if (!source || source.status !== 'settled') return;
  const invoice = await tx.invoice.findUnique({ where: { id: params.invoiceId } });
  const allocations = await tx.invoiceAllocation.findMany({ where: { invoiceId: params.invoiceId } });
  const total = allocations.reduce((sum: Prisma.Decimal, row: any) => sum.plus(row.appliedAmount), new Prisma.Decimal(0));
  if (invoice && !invoice.deletedAt && invoice.status === 'Paid' && total.equals(new Prisma.Decimal(invoice.amount).abs())) return;
  const changed = await tx.materialReturn.updateMany({ where: { id: source.id, status: 'settled', claimInvoiceId: params.invoiceId, deletedAt: null }, data: { status: 'confirmed', updatedAt: BigInt(Date.now()) } });
  if (changed.count !== 1) sourceConflict('索赔结算状态发生并发变化，本次更正已回滚，请刷新后重试。');
  await writeRouteAuditLog({ prisma: tx, actorId: params.actorId, source: params.operation,
    operation: 'invalidate_material_return_settlement', operationType: 'transition', targetType: 'MaterialReturn', targetId: source.id,
    before: { status: 'settled', claimInvoiceId: params.invoiceId },
    after: { status: 'confirmed', claimInvoiceId: params.invoiceId, reason: 'allocation_basis_changed', triggerId: params.triggerId, appliedAmount: total.toString() },
    ip: params.ip ?? null,
  });
}
