import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { createOrderShipmentBatchService, serializeOrderShipmentBatch, type OrderShipmentBatchResult } from './orderShipmentBatchService';
import { currentShipmentFinancialActor, visibleFinancialOrder, lockFinancialShipmentSources,
  lockFinancialBatchRows, verifyFinancialShipmentSource, financialFailure } from './shipmentFinancialAuthority';
import { physicalShipmentJson } from './shipmentPhysicalCommand';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { businessError } from '../shared/errorCodes';
import { todayLocalKey } from '../shared/localDate';

const source = 'route:order-shipment-batch:physical-command', operation = 'mark_physical_financial_batch';
const same = (a: unknown, b: unknown) => qcReportSourceFingerprint(a) === qcReportSourceFingerprint(b);
function requireSuccess<T>(result: OrderShipmentBatchResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, statusCode: result.error.status,
    ...(result.error.details === undefined ? {} : { details: result.error.details }),
    ...(result.error.gateDetails === undefined ? {} : { gateDetails: result.error.gateDetails }) });
  return result.data;
}
/** Existing producer runs inside this one source-locked transaction. A failure
 * result is rethrown by requireSuccess so no settlement prewrite can escape. */
function transactionalClient(tx: any) {
  return new Proxy(tx, { get(target, key) {
    if (key === '$transaction') return async (work: any) => work(tx);
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const exact = (view: any, row: any) => ({ ...view, ...physicalShipmentJson(row) });
function assertPlanInput(input: any) {
  for (const key of ['plannedQty', 'amount']) {
    if (input[key] !== undefined && input[key] !== null && !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(String(input[key])))
      throw businessError('INVALID_INPUT', '批次计划数量与金额须为非负精确十进制，最多四位小数。');
    if (typeof input[key] === 'number' && !Number.isSafeInteger(input[key]) && Math.abs(input[key]) >= 1e10)
      throw businessError('INVALID_INPUT', '较大计划数量与金额须以精确字符串提交。');
  }
  if (input.plannedRatio !== undefined && input.plannedRatio !== null &&
    (!Number.isFinite(Number(input.plannedRatio)) || Number(input.plannedRatio) < 0 || Number(input.plannedRatio) > 100))
    throw businessError('INVALID_INPUT', '计划占比须在0到100之间。');
  if (input.finalPaymentDueDays !== undefined && input.finalPaymentDueDays !== null &&
    (!Number.isSafeInteger(input.finalPaymentDueDays) || input.finalPaymentDueDays < 0 || input.finalPaymentDueDays > 365))
    throw businessError('INVALID_INPUT', '尾款账期须为0到365的整数天数。');
}
function privilegedInput(input: any, actor: TokenPayload) {
  if (Object.prototype.hasOwnProperty.call(input, 'autoLinkage')) throw businessError('INVALID_INPUT', '系统联动标记不能由人工请求设置。');
  if (input.skipGate === true || input.gateCoverRatio !== undefined) {
    if (!actor.roles.some(role => role === 'owner' || role === 'admin')) throw businessError('FORBIDDEN', '收款门禁豁免须由当前管理员办理并留痕。');
    if (input.gateCoverRatio !== undefined && (typeof input.gateCoverRatio !== 'number'
      || !Number.isFinite(input.gateCoverRatio) || input.gateCoverRatio < 0 || input.gateCoverRatio > 1))
      throw businessError('INVALID_INPUT', '收款门禁覆盖率须在0到1之间。');
  }
  if (input.shippedAt !== undefined && (!(typeof input.shippedAt === 'string' && /^(?:0|[1-9]\d*)$/.test(input.shippedAt)
    || typeof input.shippedAt === 'number' && Number.isSafeInteger(input.shippedAt) && input.shippedAt >= 0)
    || BigInt(input.shippedAt) > BigInt('8640000000000000')))
    throw businessError('INVALID_INPUT', '发运时间须为可精确核验的有效时间戳。');
}
async function lockBatchSource(tx: any, id: string, input: any, prior: TokenPayload) {
  await currentShipmentFinancialActor(tx, prior, 'write');
  const hint = await tx.orderShipmentBatch.findFirst({ where: { id, deletedAt: null } });
  if (!hint) throw businessError('NOT_FOUND', '结算批次不存在或不可查看。');
  const shipmentId = input.shipmentId !== undefined ? input.shipmentId : hint.shipmentId;
  const contexts = await lockFinancialShipmentSources(tx, { orderIds: [hint.orderId], shipmentIds: shipmentId ? [shipmentId] : [], actor: prior, action: 'write' });
  const siblings = await tx.orderShipmentBatch.findMany({ where: { orderId: hint.orderId, deletedAt: null }, orderBy: { id: 'asc' } });
  await lockFinancialBatchRows(tx, siblings.map((row: any) => row.id));
  const batch = await tx.orderShipmentBatch.findFirst({ where: { id, deletedAt: null } });
  if (!batch || batch.orderId !== hint.orderId || input.shipmentId === undefined && batch.shipmentId !== hint.shipmentId)
    throw businessError('CONFLICT', '结算批次来源在取得锁时变化，请刷新后重试原请求。');
  const actor = await currentShipmentFinancialActor(tx, prior, 'write');
  const order = await visibleFinancialOrder(tx, batch.orderId, actor);
  const context = shipmentId ? contexts.get(shipmentId)! : null;
  if (context && !context.allocations.some(row => row.orderId === batch.orderId && row.status !== 'Cancelled') && context.shipment.orderId !== batch.orderId)
    throw businessError('CONFLICT', '所选运单没有本订单来源，不能改绑结算批次。');
  return { batch, context, actor, order };
}
function publicAck(command: any, commandHash: string, batch: any) {
  return { schemaVersion: 1, command, commandHash, batchHash: qcReportSourceFingerprint(batch) };
}
async function beginCommand(tx: any, batch: any, context: any, actor: TokenPayload, input: any) {
  if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey !== input.requestKey.trim() || input.requestKey.length > 200)
    throw businessError('INVALID_INPUT', '实际批次结算确认须保留原请求键，不能退回旧发运登记。');
  for (const key of ['expectedBatchUpdatedAt', 'expectedShipmentUpdatedAt'])
    if (typeof input[key] !== 'string' || !/^(?:0|[1-9]\d*)$/.test(input[key])) throw businessError('INVALID_INPUT', '须读取结算批次和运单的精确版本。');
  if (typeof input.expectedPhysicalAllocationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedPhysicalAllocationFingerprint))
    throw businessError('INVALID_INPUT', '须读取本票当前实际分配范围。');
  const command = { schemaVersion: 1, actorId: actor.userId, batchId: batch.id, shipmentId: context.shipment.id, input: physicalShipmentJson(input) };
  const commandHash = qcReportSourceFingerprint(command), transactionId = 'physical_financial_' + qcReportSourceFingerprint({ actorId: actor.userId, batchId: batch.id, requestKey: input.requestKey });
  const logs = await tx.auditLog.findMany({ where: { transactionId } });
  if (logs.length) {
    const log = logs[0], after = log?.detail?.after, ack = after?.ack;
    if (logs.length !== 1 || log.action !== operation || log.targetType !== 'OrderShipmentBatch' || log.targetId !== batch.id
      || log.actorId !== actor.userId || log.detail?.source !== source || !ack || after.ackHash !== qcReportSourceFingerprint(ack)
      || ack.commandHash !== qcReportSourceFingerprint(ack.command) || !same(ack.command, command) || ack.commandHash !== commandHash
      || !ack.result?.id || ack.result.id !== batch.id || !ack.dispatchCommandHash)
      throw businessError('CONFLICT', '原结算请求键已绑定其他参数或缺少完整凭据。');
    return { command, commandHash, transactionId, replay: { ...ack.result, acknowledgement: publicAck(command, commandHash, ack.result) } };
  }
  if (String(batch.updatedAt) !== input.expectedBatchUpdatedAt || String(context.shipment.updatedAt) !== input.expectedShipmentUpdatedAt
    || context.allocationFingerprint !== input.expectedPhysicalAllocationFingerprint)
    throw businessError('CONFLICT', '结算批次或本票实际范围已变化，请核对当前记录后提交。');
  return { command, commandHash, transactionId, replay: null };
}
export function createNativeOrderShipmentBatchService(prisma: PrismaClient) {
  const execute = async (work: (tx: any) => Promise<any>, fallback: string): Promise<OrderShipmentBatchResult<any>> => {
    try { return { ok: true, data: await prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000 }) }; }
    catch (error) { return financialFailure(error, fallback); }
  };
  return {
    createBatch: (input: any, prior: TokenPayload | null) => execute(async tx => {
      assertPlanInput(input); await currentShipmentFinancialActor(tx, prior, 'write');
      const contexts = await lockFinancialShipmentSources(tx, { orderIds: [input.orderId], shipmentIds: input.shipmentId ? [input.shipmentId] : [], actor: prior!, action: 'write' });
      const actor = await currentShipmentFinancialActor(tx, prior, 'write');
      await visibleFinancialOrder(tx, input.orderId, actor);
      const context = input.shipmentId ? contexts.get(input.shipmentId)! : null;
      if (context && (!context.orderIds.includes(input.orderId) || context.shipment.status === 'Cancelled'))
        throw businessError('CONFLICT', '所选运单没有本订单的有效来源。');
      const result = requireSuccess(await createOrderShipmentBatchService(transactionalClient(tx)).createBatch(input, actor.userId));
      const row = await tx.orderShipmentBatch.findUnique({ where: { id: result.id } });
      return exact(result, row);
    }, 'CREATE_FAILED'),
    updateBatch: (id: string, input: any, prior: TokenPayload | null) => execute(async tx => {
      assertPlanInput(input); const { batch, context, actor } = await lockBatchSource(tx, id, input, prior!);
      if (context?.shipment.status === 'Cancelled' && input.shipmentId) throw businessError('CONFLICT', '已取消的运单不能重新绑定为有效结算来源。');
      if (batch.status !== 'planned' && (input.shipmentId !== undefined || input.unit !== undefined))
        throw businessError('CONFLICT', '已发运或已取消的结算批次来源和数量单位须保留原历史。');
      const result = requireSuccess(await createOrderShipmentBatchService(transactionalClient(tx)).updateBatch(id, input, actor.userId));
      return exact(result, await tx.orderShipmentBatch.findUnique({ where: { id } }));
    }, 'UPDATE_FAILED'),
    markShipped: (id: string, raw: any, prior: TokenPayload | null) => execute(async tx => {
      const input = physicalShipmentJson(raw || {}), { batch, context, actor, order } = await lockBatchSource(tx, id, input, prior!);
      privilegedInput(input, actor);
      if (!context) throw businessError('INVALID_INPUT', '须先选择本订单实际出运单。');
      const lease = context.kind === 'physical' ? await beginCommand(tx, batch, context, actor, input) : null;
      if (lease?.replay) return lease.replay;
      const dispatch = await verifyFinancialShipmentSource(tx, context, batch.orderId);
      const result = requireSuccess(await createOrderShipmentBatchService(transactionalClient(tx)).markShipped(id, input, actor.userId));
      const freshActor = await currentShipmentFinancialActor(tx, prior, 'write');
      await visibleFinancialOrder(tx, order.id, freshActor);
      const full = exact(result, await tx.orderShipmentBatch.findUnique({ where: { id } }));
      if (!lease) return full;
      const ack = physicalShipmentJson({ schemaVersion: 1, command: lease.command, commandHash: lease.commandHash, result: full,
        dispatchCommandHash: dispatch.commandHash, dispatchRequestKey: dispatch.command.requestKey,
        actualSource: { shipmentId: context.shipment.id, orderId: batch.orderId, allocations: context.allocations.filter(row => row.orderId === batch.orderId),
          physicalAllocationIds: context.physical.filter(row => row.orderId === batch.orderId).map(row => row.id) } });
      await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source, operation, targetType: 'OrderShipmentBatch', targetId: id,
        transactionId: lease.transactionId, operationType: 'transition', after: { commandHash: lease.commandHash, ack, ackHash: qcReportSourceFingerprint(ack) } });
      return { ...full, acknowledgement: publicAck(lease.command, lease.commandHash, full) };
    }, 'SHIP_FAILED'),
    readMarkContext: (id: string, shipmentId: string | undefined, prior: TokenPayload | null) => execute(async tx => {
      const { batch, context } = await lockBatchSource(tx, id, shipmentId === undefined ? {} : { shipmentId }, prior!);
      return { kind: context?.kind ?? 'legacy', batchId: batch.id, orderId: batch.orderId, shipmentId: context?.shipment.id ?? null,
        expectedBatchUpdatedAt: String(batch.updatedAt), expectedShipmentUpdatedAt: context ? String(context.shipment.updatedAt) : null,
        expectedPhysicalAllocationFingerprint: context?.allocationFingerprint ?? null };
    }, 'LIST_FAILED'),
    recalc: (id: string, prior: TokenPayload | null) => execute(async tx => {
      const { actor } = await lockBatchSource(tx, id, {}, prior!);
      const result = requireSuccess(await createOrderShipmentBatchService(transactionalClient(tx)).recalcSettlement(id, tx));
      await currentShipmentFinancialActor(tx, actor, 'write');
      return exact(result, await tx.orderShipmentBatch.findUnique({ where: { id } }));
    }, 'RECALC_FAILED'),
    listOverdueFinal: (limit: number, prior: TokenPayload | null) => execute(async tx => {
      const actor = await currentShipmentFinancialActor(tx, prior, 'read');
      const scope = await freshOrderLineScope(tx, actor);
      const orders = await tx.order.findMany({ where: { deletedAt: null, AND: [scope] } });
      const rows = await tx.orderShipmentBatch.findMany({ where: { deletedAt: null, orderId: { in: orders.map((order: any) => order.id) },
        isFinalBatch: true, status: 'shipped', settleStatus: { not: 'settled' }, finalPaymentDueDate: { lt: todayLocalKey() } },
        orderBy: { finalPaymentDueDate: 'asc' }, take: Math.min(Math.max(1, limit), 500) });
      const orderMap = new Map(orders.map((order: any) => [order.id, order]));
      return rows.map((row: any) => exact(serializeOrderShipmentBatch(row, orderMap.get(row.orderId)), row));
    }, 'LIST_FAILED'),
    listByOrder: (orderId: string, prior: TokenPayload | null) => execute(async tx => {
      const actor = await currentShipmentFinancialActor(tx, prior, 'read'); await visibleFinancialOrder(tx, orderId, actor);
      const result = requireSuccess(await createOrderShipmentBatchService(transactionalClient(tx)).listByOrder(orderId));
      const rows = await tx.orderShipmentBatch.findMany({ where: { orderId, deletedAt: null }, orderBy: { batchNo: 'asc' } });
      return { ...result, batches: result.batches.map((view: any) => exact(view, rows.find((row: any) => row.id === view.id))) };
    }, 'LIST_FAILED'),
  };
}
