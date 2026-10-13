import { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createInventoryService, InventoryItemInput, StockMovementInput } from './inventoryService';
import { isValidLocalDateKey } from '../shared/localDate';

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
/** Serialize retries and commit the receipt/movement with its request receipt in the same transaction. */
export async function manualStockCommand(db: PrismaClient, kind: 'receipt' | 'movement', input: any, actorId: string) {
  if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 100) throw new Error('库存操作缺少有效请求标识');
  const key = `stock:${actorId}:${input.requestKey}`;
  const signature = createHash('sha256').update(JSON.stringify(canonical({ kind, input }))).digest('hex');
  return db.$transaction(async tx => {
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`);
    const prior = await tx.auditLog.findFirst({ where: { transactionId: key, action: 'manual_stock_command' } });
    if (prior) {
      if ((prior.detail as any)?.signature !== signature) throw new Error('同一请求不能更换库存操作内容');
      const result = kind === 'receipt'
        ? await tx.inventoryItem.findUnique({ where: { id: prior.targetId! }, include: { warehouse: true } })
        : await tx.stockMovement.findUnique({ where: { id: prior.targetId! } });
      if (!result) throw new Error('原库存操作记录无法读取，请核查');
      return result;
    }
    const service = createInventoryService(db);
    let result: any;
    if (kind === 'receipt') {
      if (!isValidLocalDateKey(input.receiptDate)) throw new Error('请填写实际收货日期');
      result = await service.createInventoryItem(input as InventoryItemInput, actorId, { tx });
    } else {
      if (!['Inbound', 'Outbound', 'Adjustment'].includes(input.type) || input.referenceType !== 'Manual') throw new Error('请选择实际收货、其他用途出库或盘点');
      if (!isValidLocalDateKey(input.movementDate) || !String(input.reason || '').trim()) throw new Error('请填写实际日期和操作依据');
      const quantity = new Prisma.Decimal(String(input.quantity));
      if (!quantity.isFinite() || quantity.lt(0) || quantity.gte('100000000000000') || quantity.decimalPlaces() > 4 || (input.type !== 'Adjustment' && quantity.eq(0))) throw new Error('实际数量无效，最多四位小数');
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryItem" WHERE "id"=${input.itemId} FOR UPDATE`);
      const original = await tx.inventoryItem.findUnique({ where: { id: input.itemId }, include: { warehouse: true } });
      if (!original || original.deletedAt || !original.warehouse.isActive || original.warehouse.deletedAt) throw new Error('库存或仓库不存在或已停用');
      if(input.type==='Adjustment'&&quantity.lt(original.lockedQuantity))throw new Error('实盘数量低于已预留数量，请先核对并处理原预留');
      if (input.type === 'Outbound' && original.orderId) throw new Error('订单库存请从原出运或生产业务办理出库');
      result = await service.createStockMovement(input as StockMovementInput, actorId, { tx, ...(input.type === 'Adjustment' ? {} : { exactQuantity: quantity }) });
    }
    await tx.auditLog.create({ data: { id: 'alog_' + randomUUID(), actorId, action: 'manual_stock_command', targetType: kind === 'receipt' ? 'InventoryItem' : 'StockMovement', targetId: result.id, transactionId: key, operationType: 'create', detail: { signature, kind } } });
    return result;
  });
}
