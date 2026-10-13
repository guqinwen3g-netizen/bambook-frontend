import { Prisma } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';

/** A5: release the current source projection; preserve every prior invoice and confirmation audit. */
export async function releaseSupplierClaimInvoiceInTx(tx: any, invoice: any, actorId: string, now: bigint, reason?: string) {
  // Authority is the source's exact FK, never a CLM number or notes prefix.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MaterialReturn" WHERE "claimInvoiceId" = ${invoice.id} ORDER BY "id" FOR UPDATE`);
  const sources = await tx.materialReturn.findMany({ where: { claimInvoiceId: invoice.id, deletedAt: null } });
  if (!sources.length) return;
  if (sources.length !== 1) throw Object.assign(new Error('索赔单来源关联不唯一，请先对账后再作废'), { code: 'SOURCE_CLAIM_CONFLICT', statusCode: 409 });
  const row = sources[0];
  if (row.type !== 'claim' || !['confirmed', 'settled'].includes(row.status) || invoice.type !== 'Payable'
    || !new Prisma.Decimal(invoice.amount).lt(0) || row.amount == null || !new Prisma.Decimal(row.amount).abs().equals(new Prisma.Decimal(invoice.amount).abs())
    || row.currency !== invoice.currency || (row.supplierRelationId ?? null) !== (invoice.customerRelationId ?? null)) {
    throw Object.assign(new Error('索赔单与当前贷项的状态、客户、金额或币种不一致，请先对账'), { code: 'SOURCE_CLAIM_CONFLICT', statusCode: 409 });
  }
  // Physical return remains shipped. The financial confirmation can now be
  // issued again; neither the physical shipment nor old confirmation is erased.
  const changed = await tx.materialReturn.updateMany({ where: { id: row.id, claimInvoiceId: invoice.id, status: row.status, deletedAt: null },
    data: { status: 'shipped', claimInvoiceId: null, updatedAt: now } });
  if (changed.count !== 1) throw Object.assign(new Error('索赔单关联已变化，本次作废未提交'), { code: 'SOURCE_CLAIM_CONFLICT', statusCode: 409 });
  await writeRouteAuditLog({ prisma: tx, actorId, source: 'finance:claim-invoice-release',
    operation: 'cancel_invoice_release_supplier_claim', operationType: 'transition', targetType: 'MaterialReturn', targetId: row.id,
    transactionId: invoice.id, before: { status: row.status, claimInvoiceId: invoice.id },
    after: { status: 'shipped', claimInvoiceId: null, cancelledInvoiceId: invoice.id, reason: reason ?? null } });
}
