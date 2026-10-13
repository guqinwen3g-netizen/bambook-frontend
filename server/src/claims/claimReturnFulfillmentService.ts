import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { createInventoryService } from '../inventory/inventoryService';
import { convertLength } from '../lib/unitConversion';
import { localDateKey } from '../shared/localDate';
import { parsePositiveDecimal } from '../shared/moneyInput';
import type { ClaimResult } from './claimCaseService';
import { canonicalClaimJson, ClaimTransactionError, claimRefusal, lockClaimRows, readClaimApprovedFact } from './claimApprovalFact';

export const RETURN_RECEIVED_ACTION = 'CLAIM_RETURN_RECEIVED';
export const RETURN_DISPOSED_ACTION = 'CLAIM_RETURN_DISPOSED';
export interface ReceiveClaimReturnInput {
  clientRequestId: string; itemId: string; quantity: number | string; unit: string;
  receivedAt?: string | null; notes?: string | null;
}
export interface ScrapClaimReturnInput { clientRequestId: string; receivedEventId: string; reason: string }
const hash = (value: any) => createHash('sha256').update(canonicalClaimJson(value)).digest('hex');
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
function invalid(message: string): never { throw new ClaimTransactionError({ code: 'VALIDATION_FAILED', message }); }
function requestId(value: any) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) invalid('clientRequestId 须为 1–200 字符的稳定请求标识');
  return value;
}
function receiveParameters(input: ReceiveClaimReturnInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('收货参数须为对象');
  if (Object.keys(input).some(key => !['clientRequestId', 'itemId', 'quantity', 'unit', 'receivedAt', 'notes'].includes(key))) invalid('收货只接受库存项、实收数量、单位、日期和备注');
  requestId(input.clientRequestId);
  if (typeof input.itemId !== 'string' || !input.itemId.trim() || typeof input.unit !== 'string' || !input.unit.trim()) invalid('实际库存项和批准单位必填');
  const qty = parsePositiveDecimal(input.quantity, '实收数量');
  if (!qty.ok) invalid(qty.message);
  if (input.notes != null && typeof input.notes !== 'string') invalid('收货备注须为文本');
  if (input.receivedAt != null && (typeof input.receivedAt !== 'string' || !isValidLocalDateKey(input.receivedAt))) invalid('实际收货日期须为有效 YYYY-MM-DD');
  return { itemId: input.itemId, quantity: new Prisma.Decimal(qty.value).toString(), unit: input.unit,
    receivedAt: input.receivedAt ?? null, notes: input.notes ?? null };
}

/** Same lock order as execution/approval: case → disposition → approval → receipt → line. */
export async function lockClaimReturnContext(tx: any, lineId: string) {
  const hint = await tx.returnReceiptLine.findUnique({ where: { id: lineId } });
  if (!hint) throw new ClaimTransactionError({ code: 'NOT_FOUND', message: '退货明细不存在' });
  const { disposition, claimCase } = await lockClaimRows(tx, hint.claimDispositionId);
  const fact = await readClaimApprovedFact(tx, disposition, claimCase);
  await tx.$queryRawUnsafe('SELECT id FROM "ReturnReceipt" WHERE id = $1 FOR UPDATE', hint.returnReceiptId);
  await tx.$queryRawUnsafe('SELECT id FROM "ReturnReceiptLine" WHERE id = $1 FOR UPDATE', lineId);
  const line = await tx.returnReceiptLine.findUnique({ where: { id: lineId } });
  const receipt = await tx.returnReceipt.findUnique({ where: { id: hint.returnReceiptId } });
  if (!line || !receipt || receipt.deletedAt || receipt.status === 'Cancelled' || disposition.status !== 'Executed'
      || ['Cancelled', 'Closed'].includes(claimCase.status) || line.claimDispositionId !== disposition.id
      || line.returnReceiptId !== receipt.id || disposition.returnReceiptId !== receipt.id || receipt.claimCaseId !== claimCase.id
      || line.materialCode !== disposition.materialCode || line.unit !== disposition.unit || line.disposition !== disposition.returnDisposition
      || !new Prisma.Decimal(line.expectedQuantity).equals(disposition.quantity)
      || disposition.approverId !== fact.decisionActorId || disposition.approvedAt !== localDateKey(fact.approval.decidedAt)) claimRefusal('退货明细、案件、批准事实或执行产出不一致，请人工核对');
  return { line, receipt, disposition, claimCase, fact };
}

export async function refreshClaimReturnHeader(tx: any, receiptId: string) {
  const lines = await tx.returnReceiptLine.findMany({ where: { returnReceiptId: receiptId } });
  if (!lines.length) claimRefusal('退货单没有实际明细');
  const full = lines.every((line: any) => new Prisma.Decimal(line.receivedQuantity).equals(line.expectedQuantity));
  const status = full && lines.every((line: any) => line.status === 'Dispositioned') ? 'Dispositioned'
    : full ? 'Received' : lines.some((line: any) => new Prisma.Decimal(line.receivedQuantity).gt(0)) ? 'PartiallyReceived' : 'Draft';
  return { ...(await tx.returnReceipt.update({ where: { id: receiptId }, data: { status, updatedAt: BigInt(Date.now()) } })), lines };
}

async function priorRequest(tx: any, lineId: string, action: string, key: string, actorId: string, parameters: any) {
  const rows = await tx.auditLog.findMany({ where: { targetType: 'ReturnReceiptLine', targetId: lineId, action } });
  const matches = rows.filter((row: any) => row.detail?.claimReturn?.requestId === key);
  if (!matches.length) return null;
  const row = matches[0], fact = row.detail?.claimReturn;
  if (matches.length !== 1 || row.actorId !== actorId || fact.actorId !== actorId || fact.schemaVersion !== 1
      || fact.parametersHash !== hash(parameters) || canonicalClaimJson(fact.parameters) !== canonicalClaimJson(parameters)) claimRefusal('相同请求标识的调用者或完整参数不同，不可重复办理');
  return row;
}

/** Verify immutable batch facts; missing/damaged ledger or audit never falls back to a header date. */
export async function loadClaimReturnBatch(tx: any, line: any, receivedEventId: string, fingerprint: string) {
  const row = await tx.auditLog.findUnique({ where: { id: receivedEventId } });
  const fact = row?.detail?.claimReturn;
  if (!row || row.action !== RETURN_RECEIVED_ACTION || row.targetType !== 'ReturnReceiptLine' || row.targetId !== line.id
      || fact?.schemaVersion !== 1 || fact.actorId !== row.actorId || fact.contentFingerprint !== fingerprint
      || fact.lineId !== line.id || fact.receiptId !== line.returnReceiptId || fact.claimDispositionId !== line.claimDispositionId
      || fact.parametersHash !== hash(fact.parameters) || fact.parameters?.unit !== line.unit
      || !new Prisma.Decimal(fact.parameters.quantity).isPositive()) claimRefusal('实际退货批次缺少完整的服务端收货审计事实');
  const inbound = await tx.stockMovement.findUnique({ where: { id: fact.inboundMovementId } });
  const hold = await tx.stockMovement.findUnique({ where: { id: fact.holdMovementId } });
  for (const [movement, type] of [[inbound, 'Inbound'], [hold, 'Lock']] as const) {
    if (!movement || movement.type !== type || movement.itemId !== fact.parameters.itemId || movement.operator !== row.actorId
        || movement.referenceType !== 'ReturnReceiptLine' || movement.referenceId !== line.id
        || movement.warehouseId !== fact.batch?.warehouseId || movement.unit !== fact.batch?.unit
        || !new Prisma.Decimal(movement.quantity).equals(fact.batch?.quantity)) claimRefusal('退货批次真实入库/锁定流水与审计不一致');
  }
  const item = await tx.inventoryItem.findUnique({ where: { id: fact.parameters.itemId } });
  if (!item || item.deletedAt || item.warehouseId !== fact.batch.warehouseId || item.materialCode !== line.materialCode
      || item.unit !== fact.batch.unit || (item.batchNumber ?? null) !== fact.batch.batchNumber
      || item.ownership !== fact.batch.ownership) claimRefusal('退货批次的库存身份、批号或货权已变化，请先对账');
  const stockQuantity = item.unit === line.unit ? Number(fact.parameters.quantity) : convertLength(Number(fact.parameters.quantity), line.unit, item.unit);
  if (stockQuantity == null || !new Prisma.Decimal(inbound.quantity).equals(stockQuantity)) claimRefusal('实收批准单位数量与库存换算流水不一致');
  return { audit: row, fact, inbound, hold, item };
}

export async function loadAllClaimReturnBatches(tx: any, line: any, fingerprint: string) {
  const rows = await tx.auditLog.findMany({ where: { targetType: 'ReturnReceiptLine', targetId: line.id, action: RETURN_RECEIVED_ACTION } });
  const batches = [];
  let received = new Prisma.Decimal(0);
  for (const row of rows) { const batch = await loadClaimReturnBatch(tx, line, row.id, fingerprint); batches.push(batch); received = received.plus(batch.fact.parameters.quantity); }
  if (!received.equals(line.receivedQuantity) || received.gt(line.expectedQuantity)) claimRefusal('退货实收汇总与全部真实批次审计不一致');
  const movements = await tx.stockMovement.findMany({ where: { referenceType: 'ReturnReceiptLine', referenceId: line.id, type: { in: ['Inbound', 'Lock'] } } });
  const ids = new Set(batches.flatMap(batch => [batch.inbound.id, batch.hold.id]));
  if (ids.size !== batches.length * 2 || movements.length !== ids.size || movements.some((movement: any) => !ids.has(movement.id))) claimRefusal('退货存在未绑定收货审计的入库或锁定流水');
  return batches;
}

async function currentHeader(tx: any, receipt: any) { return { ...receipt, lines: await tx.returnReceiptLine.findMany({ where: { returnReceiptId: receipt.id } }) }; }

export async function receiveClaimReturn(prisma: PrismaClient, lineId: string, input: ReceiveClaimReturnInput,
  actorId: string): Promise<ClaimResult<{ returnReceipt: any; line: any; receivedEventId: string; movements: any[]; replayed: boolean }>> {
  try {
    const parameters = receiveParameters(input);
    return await prisma.$transaction(async (tx: any) => {
      const { line, receipt, disposition, fact } = await lockClaimReturnContext(tx, lineId);
      const previous = await priorRequest(tx, lineId, RETURN_RECEIVED_ACTION, input.clientRequestId, actorId, parameters);
      await loadAllClaimReturnBatches(tx, line, fact.contentFingerprint);
      if (previous) {
        const batch = await loadClaimReturnBatch(tx, line, previous.id, fact.contentFingerprint);
        return { ok: true, data: { returnReceipt: await currentHeader(tx, receipt), line,
          receivedEventId: previous.id, movements: [batch.inbound, batch.hold], replayed: true } };
      }
      if (parameters.unit !== line.unit) invalid('实收单位须为该批准退货明细的原单位');
      const quantity = new Prisma.Decimal(parameters.quantity);
      if (!new Prisma.Decimal(Number(quantity)).equals(quantity)) invalid('实收数量超出现有库存接口的精确表示范围');
      const total = new Prisma.Decimal(line.receivedQuantity).plus(quantity);
      if (total.gt(line.expectedQuantity)) claimRefusal('累计实收超过已批准的退货数量');
      await tx.$queryRawUnsafe('SELECT id FROM "InventoryItem" WHERE id = $1 FOR UPDATE', parameters.itemId);
      const item = await tx.inventoryItem.findUnique({ where: { id: parameters.itemId } });
      const warehouse = await tx.warehouse.findUnique({ where: { id: receipt.warehouseId } });
      if (!item || item.deletedAt || item.materialCode !== line.materialCode || item.warehouseId !== receipt.warehouseId
          || !['Owned', 'Transferred'].includes(item.ownership) || !warehouse || warehouse.deletedAt || !warehouse.isActive) claimRefusal('实际库存项物料、单据仓库、货权或仓库状态不一致');
      const itemQuantity = item.unit === parameters.unit ? Number(quantity) : convertLength(Number(quantity), parameters.unit, item.unit);
      if (itemQuantity == null || !Number.isFinite(itemQuantity) || itemQuantity <= 0) invalid('实收单位无法换算到该真实库存项单位');
      const movementDate = parameters.receivedAt ?? todayLocalKey();
      const inventory = createInventoryService(prisma);
      const base = { itemId: item.id, quantity: Number(quantity), unit: parameters.unit, movementDate,
        referenceType: 'ReturnReceiptLine', referenceId: line.id, notes: parameters.notes ?? undefined };
      const inbound = await inventory.createStockMovement({ ...base, type: 'Inbound', reason: `客诉退货入库 ${receipt.receiptNumber}` }, actorId, { tx });
      const hold = await inventory.createStockMovement({ ...base, type: 'Lock', reason: `退回待处置隔离 ${receipt.receiptNumber}` }, actorId, { tx });
      const updated = await tx.returnReceiptLine.update({ where: { id: line.id }, data: { receivedQuantity: total,
        status: total.equals(line.expectedQuantity) ? 'Received' : 'PartiallyReceived', updatedAt: BigInt(Date.now()) } });
      await tx.returnReceipt.update({ where: { id: receipt.id }, data: { receivedAt: movementDate,
        stockMovementId: receipt.stockMovementId ?? inbound.id, updatedAt: BigInt(Date.now()) } });
      const receivedEventId = id('alog');
      await tx.auditLog.create({ data: { id: receivedEventId, actorId, action: RETURN_RECEIVED_ACTION,
        targetType: 'ReturnReceiptLine', targetId: line.id, operationType: 'transition', fieldPath: 'receivedQuantity',
        beforeValue: String(line.receivedQuantity), afterValue: total.toString(),
        detail: { source: 'claim', claimReturn: { schemaVersion: 1, actorId, requestId: input.clientRequestId, parameters,
          parametersHash: hash(parameters), lineId: line.id, receiptId: receipt.id, claimDispositionId: disposition.id,
          approvalRequestId: fact.approval.id, contentFingerprint: fact.contentFingerprint,
          inboundMovementId: inbound.id, holdMovementId: hold.id,
          batch: { itemId: item.id, warehouseId: item.warehouseId, materialCode: item.materialCode, quantity: String(inbound.quantity),
            unit: item.unit, batchNumber: item.batchNumber ?? null, ownership: item.ownership } } } } });
      return { ok: true, data: { returnReceipt: await refreshClaimReturnHeader(tx, receipt.id), line: updated,
        receivedEventId, movements: [inbound, hold], replayed: false } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}

export async function scrapClaimReturn(prisma: PrismaClient, lineId: string, input: ScrapClaimReturnInput,
  actorId: string): Promise<ClaimResult<{ returnReceipt: any; line: any; disposedEventId: string; movements: any[]; replayed: boolean }>> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['clientRequestId', 'receivedEventId', 'reason'].includes(key))) invalid('报废只接受真实收货批次、理由和稳定请求标识');
    requestId(input.clientRequestId);
    if (typeof input.receivedEventId !== 'string' || !input.receivedEventId || typeof input.reason !== 'string' || !input.reason.trim()) invalid('报废须有真实收货批次和明确理由');
    const parameters = { receivedEventId: input.receivedEventId, reason: input.reason.trim() };
    return await prisma.$transaction(async (tx: any) => {
      const { line, receipt, fact } = await lockClaimReturnContext(tx, lineId);
      if (line.disposition !== 'Scrap') claimRefusal('批准的退货去向不是报废，不能用理由或备注代替处置审批');
      const batch = await loadClaimReturnBatch(tx, line, input.receivedEventId, fact.contentFingerprint);
      const batches = await loadAllClaimReturnBatches(tx, line, fact.contentFingerprint);
      const prior = await priorRequest(tx, line.id, RETURN_DISPOSED_ACTION, input.clientRequestId, actorId, parameters);
      if (prior) {
        const execution = prior.detail.claimReturn;
        if (execution.contentFingerprint !== fact.contentFingerprint || execution.lineId !== line.id || execution.outcome !== 'Scrapped'
            || execution.inboundMovementId !== batch.inbound.id || execution.holdMovementId !== batch.hold.id) claimRefusal('原报废批准范围与收货批次不一致');
        const unlock = await tx.stockMovement.findUnique({ where: { id: execution.unlockMovementId } });
        const outbound = await tx.stockMovement.findUnique({ where: { id: execution.outboundMovementId } });
        for (const [movement, type] of [[unlock, 'Unlock'], [outbound, 'Outbound']] as const) {
          if (!movement || movement.type !== type || movement.itemId !== batch.item.id || movement.referenceType !== 'ReturnReceiptLine'
              || movement.referenceId !== line.id || movement.operator !== actorId || movement.unit !== batch.item.unit
              || !new Prisma.Decimal(movement.quantity).equals(batch.inbound.quantity)) claimRefusal('原报废流水不完整，不能返回虚假成功');
        }
        return { ok: true, data: { returnReceipt: await currentHeader(tx, receipt), line,
          disposedEventId: prior.id, movements: [unlock, outbound], replayed: true } };
      }
      const actions = await tx.auditLog.findMany({ where: { targetType: 'ReturnReceiptLine', targetId: line.id, action: RETURN_DISPOSED_ACTION } });
      if (actions.some((row: any) => row.detail?.claimReturn?.parameters?.receivedEventId === batch.audit.id)) claimRefusal('该真实收货批次已处置，不能重复解锁或报废');
      await tx.$queryRawUnsafe('SELECT id FROM "InventoryItem" WHERE id = $1 FOR UPDATE', batch.item.id);
      const inventory = createInventoryService(prisma);
      const base = { itemId: batch.item.id, quantity: Number(batch.inbound.quantity), unit: batch.item.unit,
        referenceType: 'ReturnReceiptLine', referenceId: line.id, reason: `批准报废：${parameters.reason}`, movementDate: todayLocalKey() };
      const unlock = await inventory.createStockMovement({ ...base, type: 'Unlock' }, actorId, { tx });
      const outbound = await inventory.createStockMovement({ ...base, type: 'Outbound' }, actorId, { tx });
      const disposedEventId = id('alog');
      await tx.auditLog.create({ data: { id: disposedEventId, actorId, action: RETURN_DISPOSED_ACTION,
        targetType: 'ReturnReceiptLine', targetId: line.id, operationType: 'transition',
        detail: { source: 'claim', claimReturn: { schemaVersion: 1, actorId, requestId: input.clientRequestId, parameters,
          parametersHash: hash(parameters), contentFingerprint: fact.contentFingerprint, lineId: line.id, outcome: 'Scrapped',
          inboundMovementId: batch.inbound.id, holdMovementId: batch.hold.id, unlockMovementId: unlock.id, outboundMovementId: outbound.id,
          batch: batch.fact.batch } } } });
      const done = new Set([...actions.map((row: any) => row.detail?.claimReturn?.parameters?.receivedEventId), batch.audit.id]);
      const complete = new Prisma.Decimal(line.receivedQuantity).equals(line.expectedQuantity) && batches.every(batch => done.has(batch.audit.id));
      const updated = await tx.returnReceiptLine.update({ where: { id: line.id }, data: { status: complete ? 'Dispositioned' : 'PartiallyDispositioned', updatedAt: BigInt(Date.now()) } });
      return { ok: true, data: { returnReceipt: await refreshClaimReturnHeader(tx, receipt.id), line: updated,
        disposedEventId, movements: [unlock, outbound], replayed: false } };
    });
  } catch (error) { if (error instanceof ClaimTransactionError) return { ok: false, error: error.claimError }; throw error; }
}
