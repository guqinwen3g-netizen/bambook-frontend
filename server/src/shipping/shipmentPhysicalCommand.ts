import { Prisma } from '@prisma/client';
import { exactJsonValue } from '../lib/exactJsonValue';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { businessError } from '../shared/errorCodes';
import { writeRouteAuditLog } from '../audit/routeAudit';
import type { ShipmentPhysicalContext } from './shipmentPhysicalConsumerService';

const source = 'route:shipping:physical-consumer', action = 'update_physical_shipment';
export const physicalShipmentJson = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const same = (left: any, right: any) => left !== undefined && right !== undefined
  && qcReportSourceFingerprint(left) === qcReportSourceFingerprint(right);
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
export type PhysicalShipmentCommandInput = { requestKey?: unknown; expectedShipmentUpdatedAt?: unknown;
  expectedPhysicalAllocationFingerprint?: unknown };
export type PhysicalShipmentCommand = { requestKey: string; expectedShipmentUpdatedAt: string;
  expectedPhysicalAllocationFingerprint: string; patch: any; actorId: string; shipmentId: string };
export type PhysicalShipmentCommandLease = { command: PhysicalShipmentCommand; commandHash: string;
  transactionId: string; replay: any | null };
function originalAck(log: any): any {
  const after = log?.detail?.after, ack = after?.ack;
  if (log?.action !== action || log?.targetType !== 'Shipment' || log?.detail?.source !== source
    || !ack || after.commandHash !== ack.commandHash || after.requestKey !== ack.command.requestKey
    || ack.commandHash !== qcReportSourceFingerprint({ schemaVersion: 1, command: ack.command })
    || !same(after.command, ack.command) || !same(after.ackHash, qcReportSourceFingerprint(ack))
    || log.actorId !== ack.command.actorId || log.targetId !== ack.command.shipmentId)
    return conflict('原运单操作缺少完整冻结凭据，请核对原请求。');
  return ack;
}
/** Public acknowledgement identifies the exact original intent and result.
 * Warehouse cost and internal stock/audit proof remain in the private ledger. */
function publicAcknowledgement(ack: any) {
  return { schemaVersion: 1, command: ack.command, commandHash: ack.commandHash,
    shipmentHash: qcReportSourceFingerprint(ack.result.shipment) };
}
export async function beginPhysicalShipmentCommand(tx: any, context: ShipmentPhysicalContext, patch: any,
  input: PhysicalShipmentCommandInput | undefined): Promise<PhysicalShipmentCommandLease> {
  if (!context.actor) throw businessError('UNAUTHORIZED', '须以当前账号执行实际批次运单操作。');
  if (typeof input?.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.trim().length > 200)
    return conflict('实际批次运单须保留原请求键，不能退回旧物流写入路径。');
  if (typeof input.expectedShipmentUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(input.expectedShipmentUpdatedAt))
    throw businessError('INVALID_INPUT', '须读取运单当前版本后再保存。');
  if (typeof input.expectedPhysicalAllocationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedPhysicalAllocationFingerprint))
    throw businessError('INVALID_INPUT', '须先读取当前实际批次分配范围。');
  const command: PhysicalShipmentCommand = { requestKey: input.requestKey.trim(), expectedShipmentUpdatedAt: input.expectedShipmentUpdatedAt,
    expectedPhysicalAllocationFingerprint: input.expectedPhysicalAllocationFingerprint, patch: physicalShipmentJson(patch),
    actorId: context.actor.userId, shipmentId: context.shipment.id };
  const commandHash = qcReportSourceFingerprint({ schemaVersion: 1, command });
  const transactionId = 'physical_shipment_' + qcReportSourceFingerprint({ shipmentId: command.shipmentId,
    actorId: command.actorId, requestKey: command.requestKey });
  const logs = await tx.auditLog.findMany({ where: { transactionId } });
  if (logs.length) {
    if (logs.length !== 1) return conflict('原运单请求键存在不完整历史，请核对原记录。');
    const ack = originalAck(logs[0]);
    if (ack.commandHash !== commandHash || !same(ack.command, command)) return conflict('原请求键已绑定其他运单参数。');
    return { command, commandHash, transactionId, replay: { ...ack.result, acknowledgement: publicAcknowledgement(ack), replayed: true } };
  }
  if (String(context.shipment.updatedAt) !== command.expectedShipmentUpdatedAt
    || context.allocationFingerprint !== command.expectedPhysicalAllocationFingerprint)
    return conflict('运单或实际批次分配已变化，请核对当前记录后提交新命令。');
  return { command, commandHash, transactionId, replay: null };
}
export async function finishPhysicalShipmentCommand(tx: any, lease: PhysicalShipmentCommandLease, result: any,
  proof: { stockMovements: any[]; factoryLoadings?: any[]; physicalAllocations: any[]; allocations: any[];
    shipmentBefore: any; shipmentAfter: any; releaseGate: any }, ip?: string | null): Promise<any> {
  const ack = physicalShipmentJson({ schemaVersion: 1, command: lease.command, commandHash: lease.commandHash, result, ...proof });
  await writeRouteAuditLog({ prisma: tx, actorId: lease.command.actorId, source, operation: action,
    targetType: 'Shipment', targetId: lease.command.shipmentId, transactionId: lease.transactionId,
    operationType: 'transition', after: { requestKey: lease.command.requestKey, commandHash: lease.commandHash,
      command: lease.command, ack, ackHash: qcReportSourceFingerprint(ack) }, ip: ip ?? null });
  return publicAcknowledgement(ack);
}
/** Cancellation consumes the immutable successful dispatch, even when a
 * later production revision has invalidated eligibility for new dispatches. */
export async function originalPhysicalShipmentDispatch(tx: any, context: ShipmentPhysicalContext): Promise<any> {
  const logs = await tx.auditLog.findMany({ where: { targetType: 'Shipment', targetId: context.shipment.id, action } });
  const shipped = logs.map(originalAck).filter((ack: any) => ack.shipmentAfter?.status === 'Shipped'
    && ack.shipmentBefore?.status !== 'Shipped');
  if (shipped.length !== 1) return conflict('本票没有唯一完整的原出库执行凭据，不能凭任一流水回冲。');
  const ack = shipped[0];
  if (!same(ack.physicalAllocations, physicalShipmentJson(context.physical))
    || !same(ack.allocations, physicalShipmentJson(context.allocations))) return conflict('本票原出库分配投影已变化，请核对原执行历史。');
  if (!Array.isArray(ack.stockMovements) || !ack.stockMovements.length && !ack.factoryLoadings?.length
    || context.physical.some(row => row.state !== 'shipped' && row.state !== 'released'))
    return conflict('原出库物理范围不完整，不能推测回冲。');
  return ack;
}
/** Packing is documentary and may be incomplete before dispatch, but cannot
 * introduce a foreign line, a unit conversion, unknown or excess quantity. */
export function validatePhysicalPackingQuantities(context: ShipmentPhysicalContext, lines: any[], requireComplete = false): void {
  const totals = new Map<string, Prisma.Decimal>();
  for (const allocation of context.allocations.filter(row => row.status !== 'Cancelled')) {
    if (allocation.actualQty == null) return conflict('实际数量尚未明确，请先核对原分配，不能用合同或计划量生成装箱。');
    if (!allocation.orderLineId) {
      if (new Prisma.Decimal(allocation.actualQty).isZero() && allocation.plannedQty != null && new Prisma.Decimal(allocation.plannedQty).isZero()) continue;
      return conflict('装箱缺少真实订单行来源。');
    }
    totals.set(allocation.orderLineId, (totals.get(allocation.orderLineId) ?? new Prisma.Decimal(0)).plus(allocation.actualQty));
  }
  const packed = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    if (!line.orderLineId || !totals.has(line.orderLineId) || line.quantity == null) return conflict('装箱行须明确关联本票实际分配的原订单行和数量。');
    if (typeof line.quantity !== 'string' && !(line.quantity instanceof Prisma.Decimal)) return conflict('实际批次装箱数量须以精确十进制字符串提交。');
    const quantity = new Prisma.Decimal(String(line.quantity));
    if (!quantity.isFinite() || quantity.lt(0) || quantity.decimalPlaces() > 4 || quantity.gte('100000000000000')) return conflict('装箱数量须为可精确核验的非负数量。');
    const sources = context.allocations.filter(row => row.orderLineId === line.orderLineId && row.status !== 'Cancelled');
    if (!line.unit || sources.some(row => row.unit !== line.unit)) return conflict('装箱单位须与原实际分配一致。');
    packed.set(line.orderLineId, (packed.get(line.orderLineId) ?? new Prisma.Decimal(0)).plus(quantity));
  }
  for (const [id, qty] of packed) if (qty.gt(totals.get(id)!)) return conflict('装箱数量超过本票实际分配数量，请核对原范围。');
  if (requireComplete && [...totals].some(([id, qty]) => qty.gt(0) && !(packed.get(id)?.equals(qty))))
    return conflict('本票装箱数量尚未完整对应实际出运分配，请核对后发运。');
}
