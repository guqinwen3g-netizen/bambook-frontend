import { Prisma } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { SYSTEM_ROLE_IDS } from '../_shared/rolePermissionMatrix';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { resolveQcCoverage } from '../qc/qcPhysicalCoverage';
import { qcReportSourceFingerprint as hash } from '../qc/qcReportAuthority';
import { exactJsonValue } from '../lib/exactJsonValue';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { businessError } from '../shared/errorCodes';
import { isValidLocalDateKey } from '../shared/localDate';

const operation = 'record_factory_loading_receipt', source = 'service:shipping:factory-loading';
const json = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const same = (a: any, b: any) => a !== undefined && b !== undefined && hash(a) === hash(b);
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
export type FactoryLoadingFact = { actualQty: string; loadingDate: string; reference: string };
export type FactoryLoadingReceiptIdentity = { sourceKind: 'factory_direct'; factoryLoadingReceiptId: string;
  handoffId: string; shipmentId: string; productionBatchRevision: number; factoryRelationId: string;
  loadedQuantity: string; unit: string; loadingScopeFingerprint: string; loadingCommandHash: string };

/** Internal producer. The handoff command already holds Handoff -> release
 * sources -> Batch -> Shipment/SOA/SPA locks. This immutable fact does not
 * receive goods into a warehouse and does not reserve the batch a second time. */
export async function createFactoryLoadingReceiptInTx(tx: any, params: { handoffId: string; allocationId: string;
  batchId: string; actor: TokenPayload; requestKey: string; expectedHandoffUpdatedAt: string;
  fact: FactoryLoadingFact; previousFactoryLoadingReceiptIds: string[]; ip?: string | null }): Promise<any> {
  const user = await loadUserWithRoles(tx, params.actor.userId);
  if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前核量账号不可用。');
  const actor = await buildLoadedAuthTokenPayload(tx, user);
  if (params.actor.permissionCeiling !== undefined) actor.permissionCeiling = [...params.actor.permissionCeiling];
  if (!hasScope({ ...actor, roles: [] }, 'orders:read') || !hasScope({ ...actor, roles: [] }, 'shipments:write')
    || !actor.roleIds?.some((role: string) => [SYSTEM_ROLE_IDS.LOGISTICS, SYSTEM_ROLE_IDS.ADMIN, SYSTEM_ROLE_IDS.SUPER_ADMIN].includes(role as any)))
    throw businessError('FORBIDDEN', '请由当前具有后勤专业能力及来源权限的账号核验工厂实装。');
  const handoff = await tx.shipmentHandoff.findUnique({ where: { id: params.handoffId } });
  const allocation = await tx.shipmentOrderAllocation.findUnique({ where: { id: params.allocationId } });
  const batch = await tx.productionBatch.findUnique({ where: { id: params.batchId } });
  const line = await tx.shipmentHandoffLine.findFirst({ where: { handoffId: params.handoffId, allocationId: params.allocationId, productionBatchId: params.batchId } });
  if (!handoff || handoff.status !== 'Processing' || String(handoff.updatedAt) !== params.expectedHandoffUpdatedAt)
    return conflict('只有当前已接手的后勤交接可以建立工厂实装凭据。');
  if (!allocation || !batch || !line || allocation.shipmentId !== handoff.shipmentId || allocation.status === 'Cancelled'
    || line.orderId !== allocation.orderId || line.orderLineId !== allocation.orderLineId || batch.orderId !== line.orderId
    || batch.orderLineId !== line.orderLineId || batch.revision !== line.productionBatchRevision || batch.state !== 'active'
    || batch.factoryRelationId !== line.factoryRelationId || !batch.factoryRelationId || batch.unit !== line.unit || allocation.unit !== line.unit)
    return conflict('工厂实装须准确对应原交接工厂、订单行、批次修订及单位。');
  const visible = await tx.order.findFirst({ where: { id: line.orderId, deletedAt: null, AND: [await freshOrderLineScope(tx, actor)] } });
  if (!visible) throw businessError('ORDER_NOT_FOUND', '工厂实装来源订单不存在或不可查看。');
  const coverage = await resolveQcCoverage(tx, batch.orderId, { scopeType: 'production_batch', productionBatchId: batch.id });
  if (coverage.scopeFingerprint !== line.scopeFingerprint || coverage.scopeFingerprint !== hash(coverage.scopeSnapshot))
    return conflict('工厂实装的物理范围已变化，请重新核对原交接。');
  const { actualQty, loadingDate, reference } = params.fact;
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(actualQty) || new Prisma.Decimal(actualQty).gt(batch.quantity)
    || !isValidLocalDateKey(loadingDate) || !reference.trim() || reference.length > 2000)
    throw businessError('INVALID_INPUT', '请填写准确的工厂实装数量、实际装运日期和核验依据。');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(params.requestKey))
    throw businessError('INVALID_INPUT', '工厂实装须保留原核量 UUID 请求键。');
  const command = json({ schemaVersion: 1, requestKey: params.requestKey, handoffId: handoff.id, shipmentId: handoff.shipmentId,
    allocationId: allocation.id, orderId: batch.orderId, orderLineId: batch.orderLineId, productionBatchId: batch.id,
    productionBatchRevision: batch.revision, factoryRelationId: batch.factoryRelationId, scopeFingerprint: coverage.scopeFingerprint,
    quantity: new Prisma.Decimal(actualQty).toString(), unit: batch.unit, loadingDate, reference: reference.trim(),
    expectedHandoffUpdatedAt: params.expectedHandoffUpdatedAt, previousFactoryLoadingReceiptIds: [...new Set(params.previousFactoryLoadingReceiptIds)].sort() });
  const commandHash = hash({ schemaVersion: 1, operation, actorId: actor.userId, command });
  const id = `FLR_${hash([handoff.id, batch.id, actor.userId, params.requestKey])}`;
  const existing = await tx.factoryLoadingReceipt.findUnique({ where: { id } });
  if (existing) {
    if (existing.commandHash !== commandHash || !same(existing.commandSnapshot, command)) return conflict('原工厂实装请求键已绑定其他核验内容。');
    return (await verifyFactoryLoadingReceiptInTx(tx, id, batch, coverage.scopeFingerprint,
      { shipmentId: handoff.shipmentId, allocationId: allocation.id, handoffId: handoff.id })).receipt;
  }
  for (const oldId of command.previousFactoryLoadingReceiptIds) await verifyFactoryLoadingReceiptInTx(tx, oldId, batch, coverage.scopeFingerprint,
    { shipmentId: handoff.shipmentId, allocationId: allocation.id, handoffId: handoff.id });
  const now = BigInt(Date.now());
  const persisted = { id, handoffId: handoff.id, shipmentId: handoff.shipmentId, allocationId: allocation.id,
    orderId: batch.orderId, orderLineId: batch.orderLineId, productionBatchId: batch.id, productionBatchRevision: batch.revision,
    factoryRelationId: batch.factoryRelationId, scopeFingerprint: coverage.scopeFingerprint, scopeSnapshot: json(coverage.scopeSnapshot),
    quantity: new Prisma.Decimal(command.quantity), unit: batch.unit, loadingDate, reference: command.reference,
    createdBy: actor.userId, verifiedAt: now, createdAt: now, requestKey: params.requestKey, commandHash, commandSnapshot: command };
  const ack = json({ schemaVersion: 1, receipt: persisted, replayed: false });
  const receipt = await tx.factoryLoadingReceipt.create({ data: { ...persisted, receiptSnapshot: ack } });
  await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source, operation, targetType: 'FactoryLoadingReceipt', targetId: id,
    transactionId: `factory-loading:${hash([handoff.id, batch.id, actor.userId, params.requestKey])}`, operationType: 'create',
    after: { schemaVersion: 1, command, commandHash, requestKey: params.requestKey, receipt: ack }, ip: params.ip ?? null });
  return receipt;
}

/** Verifies the original producer, never an arbitrary ID or a fake Warehouse.
 * Historical callers supply the immutable batch revision for cancellation. */
export async function verifyFactoryLoadingReceiptInTx(tx: any, id: string, batch: any, scopeFingerprint: string,
  ownership?: { shipmentId: string; allocationId: string; handoffId?: string }): Promise<{ receipt: any; identity: FactoryLoadingReceiptIdentity }> {
  const receipt = await tx.factoryLoadingReceipt.findUnique({ where: { id } });
  if (!receipt || receipt.productionBatchId !== batch.id || receipt.orderId !== batch.orderId || receipt.orderLineId !== batch.orderLineId
    || receipt.productionBatchRevision !== batch.revision || receipt.factoryRelationId !== batch.factoryRelationId || receipt.unit !== batch.unit
    || receipt.scopeFingerprint !== scopeFingerprint || hash(receipt.scopeSnapshot) !== scopeFingerprint
    || ownership && (receipt.shipmentId !== ownership.shipmentId || receipt.allocationId !== ownership.allocationId
      || ownership.handoffId !== undefined && receipt.handoffId !== ownership.handoffId)) return conflict('原工厂实装凭据与准确出运、工厂或批次范围不一致。');
  const command = receipt.commandSnapshot, ack = receipt.receiptSnapshot;
  if (!command || !ack?.receipt || ack.schemaVersion !== 1 || ack.replayed !== false
    || receipt.commandHash !== hash({ schemaVersion: 1, operation, actorId: receipt.createdBy, command })
    || !isValidLocalDateKey(receipt.loadingDate) || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(String(receipt.quantity))
    || !receipt.reference?.trim() || !Array.isArray(command.previousFactoryLoadingReceiptIds)) return conflict('原工厂实装命令或冻结回执不完整。');
  for (const key of ['handoffId', 'shipmentId', 'allocationId', 'orderId', 'orderLineId', 'productionBatchId', 'productionBatchRevision',
    'factoryRelationId', 'scopeFingerprint', 'unit', 'loadingDate', 'reference', 'requestKey'])
    if (command[key] !== receipt[key]) return conflict('原工厂实装凭据已偏离核验命令。');
  if (command.quantity !== String(receipt.quantity)) return conflict('原工厂实装数量已偏离核验命令。');
  const { receiptSnapshot: _ack, ...persisted } = json(receipt);
  if (!same(persisted, ack.receipt)) return conflict('原工厂实装凭据已偏离冻结历史。');
  const audits = await tx.auditLog.findMany({ where: { action: operation, targetType: 'FactoryLoadingReceipt', targetId: id } });
  if (audits.length !== 1 || audits[0].actorId !== receipt.createdBy || audits[0].detail?.source !== source
    || audits[0].detail?.after?.requestKey !== receipt.requestKey || audits[0].detail?.after?.commandHash !== receipt.commandHash
    || !same(audits[0].detail?.after?.command, command) || !same(audits[0].detail?.after?.receipt, ack))
    return conflict('原工厂实装缺少准确后勤创建审计。');
  const handoff = await tx.shipmentHandoff.findUnique({ where: { id: receipt.handoffId } });
  const allocation = await tx.shipmentOrderAllocation.findUnique({ where: { id: receipt.allocationId } });
  const line = await tx.shipmentHandoffLine.findFirst({ where: { handoffId: receipt.handoffId, allocationId: receipt.allocationId, productionBatchId: receipt.productionBatchId } });
  if (!handoff || handoff.shipmentId !== receipt.shipmentId || !allocation || allocation.shipmentId !== receipt.shipmentId
    || allocation.orderId !== receipt.orderId || allocation.orderLineId !== receipt.orderLineId || allocation.unit !== receipt.unit
    || !line || line.orderId !== receipt.orderId || line.orderLineId !== receipt.orderLineId || line.productionBatchRevision !== receipt.productionBatchRevision
    || line.factoryRelationId !== receipt.factoryRelationId || line.scopeFingerprint !== receipt.scopeFingerprint || line.unit !== receipt.unit)
    return conflict('原工厂实装凭据的交接来源身份已变化。');
  return { receipt, identity: { sourceKind: 'factory_direct', factoryLoadingReceiptId: receipt.id, handoffId: receipt.handoffId,
    shipmentId: receipt.shipmentId, productionBatchRevision: receipt.productionBatchRevision, factoryRelationId: receipt.factoryRelationId,
    loadedQuantity: String(receipt.quantity), unit: receipt.unit, loadingScopeFingerprint: receipt.scopeFingerprint, loadingCommandHash: receipt.commandHash } };
}
