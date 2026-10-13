import {TRANSFER_RECEIPT_OPERATION} from '../inventory/inventoryTransferReceiptService';
import { exactJsonValue } from '../lib/exactJsonValue';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope, isOrderLineStorageConflict } from '../orders/orderLineWriteAccess';
import { lockOrderReleaseSources } from './releaseService';
import { resolveCurrentProductionBatchFacts } from './productionBatchService';
import { resolveQcCoverage } from '../qc/qcPhysicalCoverage';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { createInventoryService } from '../inventory/inventoryService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { businessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { isValidLocalDateKey } from '../shared/localDate';

const operation = 'receive_production_batch_stock';
const json = (v: unknown): any => JSON.parse(JSON.stringify(exactJsonValue(v)));
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
type Command = { expectedBatchRevision: number; expectedScopeFingerprint: string; warehouseId: string; quantity: string;
  unit: string; movementDate: string; receiptReference: string; ownership: 'Owned' | 'Transferred'; unitCost: string | null; currency: string; requestKey: string };
function text(value: unknown, label: string, limit = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) return invalid(`${label}须明确填写。`);
  return value.trim();
}
function decimal(value: unknown, positive: boolean): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value)) return invalid('数量和成本须为最多四位小数的十进制字符串；未知成本请明确提交 null。');
  const number = new Prisma.Decimal(value);
  if (positive ? number.lte(0) : number.lt(0)) return invalid('入库数量必须为正数，已知成本不可为负数。');
  return number.toString();
}
function command(input: unknown): Command {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('请提交完整的实物入库记录。');
  const value = input as Record<string, unknown>;
  const fields = ['expectedBatchRevision', 'expectedScopeFingerprint', 'warehouseId', 'quantity', 'unit', 'movementDate', 'receiptReference', 'ownership', 'unitCost', 'currency', 'requestKey'];
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return invalid('入库命令有缺失或不可提交的字段。');
  if (!Number.isSafeInteger(value.expectedBatchRevision) || (value.expectedBatchRevision as number) < 1) return invalid('须提交实际批次修订。');
  if (typeof value.expectedScopeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedScopeFingerprint)) return invalid('请先读取本批次当前范围。');
  const movementDate = text(value.movementDate, '实际登记日期', 10);
  if (!isValidLocalDateKey(movementDate)) return invalid('实际登记日期无效。');
  if (value.ownership !== 'Owned' && value.ownership !== 'Transferred') return invalid('须明确实际货权。');
  const currency = text(value.currency, '成本币种', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return invalid('成本币种无效。');
  return { expectedBatchRevision: value.expectedBatchRevision as number, expectedScopeFingerprint: value.expectedScopeFingerprint,
    warehouseId: text(value.warehouseId, '仓库'), quantity: decimal(value.quantity, true), unit: text(value.unit, '单位', 24),
    movementDate, receiptReference: text(value.receiptReference, '实物登记凭据说明', 500), ownership: value.ownership,
    unitCost: value.unitCost === null ? null : decimal(value.unitCost, false), currency, requestKey: text(value.requestKey, '原请求键') };
}
async function currentActor(tx: any, prior: TokenPayload | null, write: boolean) {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请使用当前账号登记实物入库。');
  let user: any, actor: TokenPayload;
  try {
    user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    actor = await buildLoadedAuthTokenPayload(tx, user);
  } catch (error) {
    if ((error as any)?.code === 'ACCOUNT_DISABLED') throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前入库权限，请稍后重试。');
  }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (!hasScope({ ...actor, roles: [] }, 'orders:read') || (write && !hasScope({ ...actor, roles: [] }, 'inventory:write'))) throw businessError('FORBIDDEN', '当前账号没有本次实物入库权限。');
  return actor;
}
async function scopedOrder(tx: any, orderId: string, actor: TokenPayload) {
  const scope = await freshOrderLineScope(tx, actor);
  const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } });
  if (!order) throw businessError('ORDER_NOT_FOUND', '订单不存在或不可查看。');
  return order;
}
async function lockedBatch(tx: any, batchId: string, prior: TokenPayload | null) {
  const initialActor = await currentActor(tx, prior, true);
  const hint = await tx.productionBatch.findUnique({ where: { id: batchId } });
  if (!hint) throw businessError('NOT_FOUND', '实际批次不存在或不可查看。');
  await scopedOrder(tx, hint.orderId, initialActor);
  await lockOrderReleaseSources(tx, hint.orderId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id"=${hint.orderId} FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "orderId"=${hint.orderId} ORDER BY "id" FOR UPDATE`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductionBatch" WHERE "id"=${batchId} FOR UPDATE`);
  const actor = await currentActor(tx, prior, true), order = await scopedOrder(tx, hint.orderId, actor);
  const batch = await tx.productionBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.orderId !== order.id || batch.orderLineId !== hint.orderLineId) return conflict('批次来源身份已变化，请核对原请求。');
  return { actor, order, batch };
}
async function result<T>(work: () => Promise<T>) {
  try { return { ok: true as const, data: await work() }; }
  catch (error) {
    logger.error('[ProductionStockReceipt] 入库记录操作未确认', { error });
    const safe = safeRouteError(isOrderLineStorageConflict(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      ? businessError('CONFLICT', '入库范围或原请求正在变化，请保留原键核对。') : error, { fallbackCode: 'INTERNAL_ERROR' });
    return { ok: false as const, error: { code: safe.code, message: safe.message, status: safe.status } };
  }
}
export async function listProductionStockReceipts(params: { prisma: PrismaClient; batchId: string; actor: TokenPayload | null }) {
  return result(() => params.prisma.$transaction(async (tx: any) => {
    const actor = await currentActor(tx, params.actor, false);
    const batch = await tx.productionBatch.findUnique({ where: { id: params.batchId } });
    if (!batch) throw businessError('NOT_FOUND', '实际批次不存在或不可查看。');
    await scopedOrder(tx, batch.orderId, actor);
    await resolveCurrentProductionBatchFacts(tx, batch);
    const scope = await resolveQcCoverage(tx, batch.orderId, { scopeType: 'production_batch', productionBatchId: batch.id });
    const receipts = await tx.productionStockReceipt.findMany({ where: { productionBatchId: batch.id }, orderBy: { createdAt: 'asc' } });
    const rows = [];
    for (const receipt of receipts) {
      const item = await tx.inventoryItem.findUnique({ where: { id: receipt.inventoryItemId } });
      // Current stock is distinct from the frozen original receipt. Sales can
      // read scope/quantity; cost remains governed by existing inventory:read.
      const { commandSnapshot: _command, receiptSnapshot: _ack, ...publicReceipt } = receipt;
      const stock = item ? { id: item.id, warehouseId: item.warehouseId, quantity: String(item.quantity), lockedQuantity: String(item.lockedQuantity),
        unit: item.unit, ownership: item.ownership, orderId: item.orderId, deletedAt: item.deletedAt,
        ...(hasScope(actor, 'inventory:read') ? { unitCost: item.unitCost == null ? null : String(item.unitCost), currency: item.currency } : {}) } : null;
      rows.push({ receipt: json(publicReceipt), inventoryItem: json(stock) });
    }
    return { batch: json(batch), scopeFingerprint: scope.scopeFingerprint,
      receivedQuantity: receipts.filter((r:any)=>r.commandSnapshot?.operation!==TRANSFER_RECEIPT_OPERATION).reduce((total: Prisma.Decimal, receipt: any) => total.plus(receipt.quantity), new Prisma.Decimal(0)).toString(), receipts: rows };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
}
export async function receiveProductionBatchStock(params: { prisma: PrismaClient; batchId: string; actor: TokenPayload | null; input: unknown }) {
  return result(async () => {
    const raw = params.input as Record<string, unknown> | null;
    const requestKey = text(raw?.requestKey, '原请求键');
    return params.prisma.$transaction(async (tx: any) => {
      const { actor, order, batch } = await lockedBatch(tx, params.batchId, params.actor);
      const original = await tx.productionStockReceipt.findUnique({ where: { productionBatchId_createdBy_requestKey: { productionBatchId: batch.id, createdBy: actor.userId, requestKey } } });
      let input: Command;
      try { input = command(raw); } catch (error) { if (original) return conflict('原请求键已登记其他参数，请核对原回执。'); throw error; }
      const commandHash = qcReportSourceFingerprint({ operation, batchId: batch.id, actorId: actor.userId, command: input });
      if (original) {
        if (original.commandHash !== commandHash || !original.receiptSnapshot || qcReportSourceFingerprint(original.commandSnapshot) !== qcReportSourceFingerprint(input)) return conflict('原请求键已登记其他参数或回执不完整，请核对原记录。');
        return { ...original.receiptSnapshot, replayed: true };
      }
      const facts = await resolveCurrentProductionBatchFacts(tx, batch);
      const scope = await resolveQcCoverage(tx, order.id, { scopeType: 'production_batch', productionBatchId: batch.id });
      if (batch.revision !== input.expectedBatchRevision || scope.scopeFingerprint !== input.expectedScopeFingerprint) return conflict('批次范围已变化，请读取当前范围后核对。');
      if (batch.unit !== input.unit) return invalid('实物入库单位须与本批次实际单位一致，不隐式换算。');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Warehouse" WHERE "id"=${input.warehouseId} FOR UPDATE`);
      const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId } });
      if (!warehouse || warehouse.deletedAt != null || !warehouse.isActive) throw businessError('NOT_FOUND', '所选仓库不存在或已停用。');
      const current = await currentActor(tx, params.actor, true); await scopedOrder(tx, order.id, current);
      const previous = await tx.productionStockReceipt.findMany({ where: { productionBatchId: batch.id } });
      const cumulative = previous.filter((r:any)=>r.commandSnapshot?.operation!==TRANSFER_RECEIPT_OPERATION).reduce((total: Prisma.Decimal, row: any) => total.plus(row.quantity), new Prisma.Decimal(0)).plus(input.quantity);
      if (cumulative.gt(batch.quantity)) return conflict('本批次累计实际入库已超过受控数量，请核对原收货记录。');
      const now = BigInt(Date.now()), receiptId = `PSR_${randomUUID()}`, itemId = `INV_${randomUUID()}`;
      await tx.inventoryItem.create({ data: { id: itemId, warehouseId: warehouse.id, materialCode: facts.line.materialCode ?? facts.line.itemNo ?? null,
        description: facts.line.description || order.product || batch.batchCode, category: String(order.type).toLowerCase() === 'garment' ? 'Garment' : 'Fabric',
        batchNumber: batch.batchCode, quantity: '0', lockedQuantity: '0', unit: batch.unit,
        unitCost: input.unitCost, currency: input.currency, ownership: input.ownership, orderId: order.id, stockPrep: false,
        notes: input.receiptReference, createdAt: now, updatedAt: now } });
      const movement = await createInventoryService(params.prisma).createStockMovement({ itemId, type: 'Inbound', quantity: Number(input.quantity),
        unit: batch.unit, referenceType: 'ProductionBatch', referenceId: batch.id, movementDate: input.movementDate,
        reason: input.receiptReference }, actor.userId, { tx, exactQuantity: new Prisma.Decimal(input.quantity) });
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
      const receipt = await tx.productionStockReceipt.create({ data: { id: receiptId, productionBatchId: batch.id, productionBatchRevision: batch.revision,
        orderId: order.id, orderLineId: batch.orderLineId, warehouseId: warehouse.id, inventoryItemId: item.id, stockMovementId: movement.id,
        quantity: input.quantity, unit: batch.unit, scopeFingerprint: scope.scopeFingerprint, scopeSnapshot: scope.scopeSnapshot,
        movementDate: input.movementDate, receiptReference: input.receiptReference, requestKey, commandHash, commandSnapshot: input,
        receiptSnapshot: {}, createdBy: actor.userId, createdAt: now } });
      const ack = { receipt: json(receipt), inventoryItem: json(item), movement: json(movement), replayed: false };
      // Freeze the original ACK once in its creating transaction. Subsequent
      // retries return it, never a changed current balance or a new stock fact.
      await tx.productionStockReceipt.update({ where: { id: receipt.id }, data: { receiptSnapshot: ack } });
      await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'route:production:physical-stock-receipt', operation,
        targetType: 'ProductionStockReceipt', targetId: receipt.id, after: { productionBatchId: batch.id, orderLineId: batch.orderLineId,
          requestKey, commandHash, command: input, receipt: ack }, operationType: 'create' });
      return ack;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
  });
}
