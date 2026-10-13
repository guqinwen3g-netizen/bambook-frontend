import { Prisma } from '@prisma/client';
import { httpStatusOfCode } from '../shared/errorCodes';

/** The receipt command chooses its physical destination before any business
 * write. An explicit destination never falls back to another warehouse. */
export class ReceiptDomainError extends Error {
  readonly status: number;
  readonly statusCode: number;
  constructor(message: string, readonly code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' = 'VALIDATION_FAILED') {
    super(message); this.status = httpStatusOfCode(code); this.statusCode = this.status;
  }
}
export class ReceiptWarehouseError extends ReceiptDomainError {
  constructor(message: string) { super(message, 'CONFLICT'); }
}

export async function resolveReceiptWarehouse(tx: any, suppliedId: string | null | undefined): Promise<{ id: string; name: string }> {
  const explicitId = typeof suppliedId === 'string' && suppliedId.trim() ? suppliedId.trim() : null;
  const usable = { isActive: true, deletedAt: null };
  let warehouse = explicitId
    ? await tx.warehouse.findFirst({ where: { id: explicitId, ...usable } })
    : await tx.warehouse.findFirst({ where: { type: 'Main', ...usable }, orderBy: { sortOrder: 'asc' } });
  if (!warehouse && !explicitId) warehouse = await tx.warehouse.findFirst({ where: usable, orderBy: { sortOrder: 'asc' } });
  if (!warehouse) throw new ReceiptWarehouseError(explicitId
    ? '指定收货仓库不存在、已停用或已删除。请核对并选择实际可用仓库后重新确认收料。'
    : '没有可用的收货仓库，本次收料尚未提交。请先启用或建立实际仓库，再重新确认收料。');
  // Keep current usability stable through receipt/outbox commit. A concurrent
  // warehouse change must finish before this lock or wait until after commit.
  const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Warehouse" WHERE "id" = ${warehouse.id} FOR UPDATE`);
  const current = rows.length ? await tx.warehouse.findFirst({ where: { id: warehouse.id, ...usable } }) : null;
  if (!current) throw new ReceiptWarehouseError('收货仓库状态已变化。请刷新并选择实际可用仓库后重新确认收料。');
  return { id: current.id, name: current.name };
}
