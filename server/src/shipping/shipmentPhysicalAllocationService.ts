import {TRANSFER_RECEIPT_OPERATION,verifyTransferredProductionReceipt} from '../inventory/inventoryTransferReceiptService';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { freshOrderLineScope, isOrderLineStorageConflict } from '../orders/orderLineWriteAccess';
import { lockReleaseSources } from '../production/releaseService';
import { resolveCurrentProductionBatchFacts } from '../production/productionBatchService';
import { resolveQcCoverage } from '../qc/qcPhysicalCoverage';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { syncOrderLineShipmentQuantity } from '../shared/orderLineShippedQty';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { businessError, isBusinessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { exactJsonValue } from '../lib/exactJsonValue';
import { verifyFactoryLoadingReceiptInTx } from './factoryLoadingReceiptService';

const source = 'route:shipping:physical-allocation';
const createAction = 'create_physical_shipment_allocation', updateAction = 'update_physical_shipment_allocation';
const actions = [createAction, updateAction];
const states = new Set(['Planned', 'PartiallyShipped', 'Fulfilled', 'ShortShipped', 'Cancelled']);
const json = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && qcReportSourceFingerprint(a) === qcReportSourceFingerprint(b);
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
type Quantity = string | null;
type PhysicalRow = { productionBatchId: string; expectedRevision: number; expectedScopeFingerprint: string;
  stockReceiptId: string | null; factoryLoadingReceiptId?: string; plannedQty: Quantity; actualQty: Quantity; unit: string };
type Command = { requestKey: string; expectedAllocationUpdatedAt?: string; orderId?: string; orderLineId?: string;
  plannedQty?: Quantity; actualQty?: Quantity; unit?: string; status?: string; batchOrCartonNote?: string | null;
  exception?: string | null; productionBatchAllocations?: PhysicalRow[] };
export type PhysicalAllocationParams = { prisma: PrismaClient; shipmentId: string; allocationId?: string;
  actor: TokenPayload | null; input: unknown; ip?: string | null; tx?: any;
  /** Trusted internal handoff command context; never accepted from HTTP body. */
  handoffAuthorization?: { handoffId: string; operation: 'create' | 'revise' | 'record-actual' } };

function object(value: unknown, fields?: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('请提交完整的实际批次分配命令。');
  const row = value as Record<string, any>;
  if (fields && Object.keys(row).some(key => !fields.includes(key))) return invalid('分配命令含不可提交的字段。');
  return row;
}
function text(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) return invalid(`${label}须明确填写。`);
  return value.trim();
}
function quantity(value: unknown): Quantity {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value))
    return invalid('数量须为最多四位小数的非负十进制字符串；未知请明确提交 null。');
  return new Prisma.Decimal(value).toString();
}
function savedQuantity(value: unknown): Quantity {
  if (value === null) return null;
  if (value === undefined) return conflict('既有分配数量缺失，不能冒充未知或零。');
  const valueText = String(value);
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(valueText)) return conflict('既有数量无法精确核验，请核对原记录。');
  return new Prisma.Decimal(valueText).toString();
}
function physicalRow(input: unknown): PhysicalRow {
  const row = object(input, ['productionBatchId', 'expectedRevision', 'expectedScopeFingerprint', 'stockReceiptId', 'factoryLoadingReceiptId', 'plannedQty', 'actualQty', 'unit']);
  if (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1) return invalid('请提交实际批次修订。');
  if (typeof row.expectedScopeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedScopeFingerprint)) return invalid('请读取本批次当前范围指纹。');
  const parsed = { productionBatchId: text(row.productionBatchId, '实际批次'), expectedRevision: row.expectedRevision,
    expectedScopeFingerprint: row.expectedScopeFingerprint, stockReceiptId: row.stockReceiptId === null ? null : text(row.stockReceiptId, '原收货凭据'),
    ...(row.factoryLoadingReceiptId !== undefined ? { factoryLoadingReceiptId: text(row.factoryLoadingReceiptId, '工厂实装凭据') } : {}),
    plannedQty: quantity(row.plannedQty), actualQty: quantity(row.actualQty), unit: text(row.unit, '单位', 24) };
  if (parsed.stockReceiptId && parsed.factoryLoadingReceiptId) return invalid('同一实物来源不能同时是仓库收货和工厂直出。');
  if (parsed.plannedQty === null && parsed.actualQty === null) return invalid('每个批次分配至少须有一项已知数量。');
  if (parsed.actualQty !== null && new Prisma.Decimal(parsed.actualQty).gt(0) && !parsed.stockReceiptId && !parsed.factoryLoadingReceiptId) return invalid('实际货物须明确关联原生收货或工厂实装凭据。');
  return parsed;
}
function command(value: unknown, patch: boolean): Command {
  const fields = ['requestKey', 'plannedQty', 'actualQty', 'unit', 'status', 'batchOrCartonNote', 'exception', 'productionBatchAllocations', 'orderId', 'orderLineId'];
  if (patch) fields.push('expectedAllocationUpdatedAt');
  const raw = object(value, fields), result: Command = { requestKey: text(raw.requestKey, '原请求键') };
  if (patch) {
    if (typeof raw.expectedAllocationUpdatedAt !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw.expectedAllocationUpdatedAt)) return invalid('修改须提交原分配更新时间的精确字符串。');
    result.expectedAllocationUpdatedAt = raw.expectedAllocationUpdatedAt;
  }
  for (const key of ['orderId', 'orderLineId', 'unit'] as const) if (Object.prototype.hasOwnProperty.call(raw, key)) result[key] = text(raw[key], key, key === 'unit' ? 24 : 200);
  for (const key of ['plannedQty', 'actualQty'] as const) if (Object.prototype.hasOwnProperty.call(raw, key)) result[key] = quantity(raw[key]);
  for (const key of ['batchOrCartonNote', 'exception'] as const) if (Object.prototype.hasOwnProperty.call(raw, key)) {
    if (raw[key] !== null && (typeof raw[key] !== 'string' || raw[key].length > 2000)) return invalid('备注或异常说明无效。');
    result[key] = raw[key] === null ? null : raw[key].trim();
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'status')) {
    if (!states.has(raw.status)) return invalid('分配状态无效。');
    result.status = raw.status;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'productionBatchAllocations')) {
    if (!Array.isArray(raw.productionBatchAllocations) || !raw.productionBatchAllocations.length || raw.productionBatchAllocations.length > 100) return invalid('须明确提交一至一百条实际批次/收货关联。');
    result.productionBatchAllocations = raw.productionBatchAllocations.map(physicalRow);
    const identities = result.productionBatchAllocations.map(row => JSON.stringify([row.productionBatchId, row.stockReceiptId, row.factoryLoadingReceiptId ?? null]));
    if (new Set(identities).size !== identities.length) return invalid('同批次原收货凭据或未收货计划身份不能重复。');
  }
  if (!patch && (!result.orderId || !result.orderLineId || !result.unit)) return invalid('实际批次分配须明确真实订单、订单行和单位。');
  return result;
}

/** Canonical original intent, not the mutable current list. PATCH omitted keys
 * remain omitted. Decimal strings are normalized, null remains unknown. */
export function physicalShipmentAllocationCommandHash(input: { operation: string; shipmentId: string;
  allocationId: string | null; actorId: string; command: Command }): string {
  return qcReportSourceFingerprint(input);
}
async function currentActor(tx: any, prior: TokenPayload | null, requireOrderRead = true, writeScope: 'shipments:write' | 'orders:write' = 'shipments:write'): Promise<TokenPayload> {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请使用当前账号登记实际批次分配。');
  let actor: TokenPayload, user: any;
  try { user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    actor = await buildLoadedAuthTokenPayload(tx, user);
  } catch (error) {
    if (isBusinessError(error)) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前分配权限。');
  }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if ((requireOrderRead && !hasScope({ ...actor, roles: [] }, 'orders:read')) || !hasScope({ ...actor, roles: [] }, writeScope))
    throw businessError('FORBIDDEN', requireOrderRead ? '当前账号没有本次订单读取和出运写入权限。' : '当前账号没有本次出运写入权限。');
  return actor;
}
async function allocationActor(tx: any, params: PhysicalAllocationParams): Promise<TokenPayload> {
  const authority = params.handoffAuthorization;
  if (!authority || authority.operation === 'record-actual') return currentActor(tx, params.actor);
  const actor = await currentActor(tx, params.actor, true, 'orders:write');
  const handoff = await tx.shipmentHandoff.findUnique({ where: { shipmentId: params.shipmentId } });
  const expectedStatus = authority.operation === 'create' ? 'PendingLogistics' : 'NeedsBusinessDecision';
  if (!handoff || handoff.id !== authority.handoffId || handoff.businessActorId !== actor.userId || handoff.status !== expectedStatus)
    throw businessError('FORBIDDEN', '业务只能预留或修订本人当前出运交接的数量。');
  return actor;
}
async function visibleOrders(tx: any, ids: string[], actor: TokenPayload): Promise<any[]> {
  const scope = await freshOrderLineScope(tx, actor), rows = [];
  for (const id of ids) {
    let order;
    try { order = await tx.order.findFirst({ where: { id, deletedAt: null, AND: [scope] } }); }
    catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验当前来源订单范围。'); }
    if (!order) throw businessError('ORDER_NOT_FOUND', '订单不存在或不可查看。');
    rows.push(order);
  }
  return rows;
}
async function hints(tx: any, shipmentId: string, allocationId?: string, suppliedOrderId?: string, suppliedLineId?: string) {
  const shipment = await tx.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment || shipment.deletedAt != null) throw businessError('SHIPMENT_NOT_FOUND', '出运记录不存在或不可查看。');
  const allocations = await tx.shipmentOrderAllocation.findMany({ where: { shipmentId }, orderBy: { id: 'asc' } });
  const existing = allocationId ? allocations.find((row: any) => row.id === allocationId) : null;
  if (allocationId && !existing) throw businessError('NOT_FOUND', '分配记录不存在或不可查看。');
  const orderId = existing?.orderId ?? suppliedOrderId, lineId = existing?.orderLineId ?? suppliedLineId;
  const orderIds = [...new Set<string>([shipment.orderId, ...allocations.map((row: any) => row.orderId), orderId].filter(Boolean))].sort();
  return { shipment, allocations, existing, orderId, lineId, orderIds,
    identity: { headerOrderId: shipment.orderId, allocations: allocations.map((row: any) => [row.id, row.orderId, row.orderLineId]), orderId, lineId } };
}

/** Read-only routing decision; failures never select the legacy writer. */
export async function allocationRequiresPhysicalContract(params: { prisma: PrismaClient; shipmentId: string;
  allocationId?: string; orderId?: string; orderLineId?: string; actor: TokenPayload | null }): Promise<boolean> {
  try { return await params.prisma.$transaction(async (tx: any) => {
    const actor = await currentActor(tx, params.actor), hint = await hints(tx, params.shipmentId, params.allocationId, params.orderId, params.orderLineId);
    await visibleOrders(tx, hint.orderIds, actor);
    if (hint.lineId) {
      const line = await tx.orderLine.findUnique({ where: { id: hint.lineId } });
      if (!line || line.orderId !== hint.orderId) throw businessError('NOT_FOUND', '订单行不存在或不可查看。');
    }
    if (await tx.shipmentProductionAllocation.count({ where: { shipmentId: params.shipmentId } })) return true;
    return !!await tx.productionBatch.count({ where: { orderId: { in: hint.orderIds } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }); }
  catch (error) { if (isBusinessError(error)) throw error; throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验真实批次分配范围。'); }
}

/** Legacy business TX seam, not a second transaction or an authority fallback
 * for HTTP. Existing internal scalar-actor callers omit actor; supplied actor
 * (including null) must pass the same current-account/cap/L2 checks. Either
 * path is categorically unable to mutate a modern physical allocation. */
export async function lockLegacyShipmentAllocationWrite(tx: any, params: { shipmentId: string; allocationId?: string;
  orderId?: string; actor?: TokenPayload | null }): Promise<void> {
  const usesActor = params.actor !== undefined;
  const actor = usesActor ? await currentActor(tx, params.actor!) : null;
  const before = await hints(tx, params.shipmentId, params.allocationId, params.orderId);
  if (typeof tx.shipmentHandoff?.findUnique === 'function') {
    const handoff = await tx.shipmentHandoff.findUnique({ where: { shipmentId: params.shipmentId } });
    if (handoff && handoff.status !== 'Cancelled') return conflict('该票已由出运交接托管，旧分配接口不能新增、修改或删除其来源行。');
  }
  if (actor) await visibleOrders(tx, before.orderIds, actor);
  await lockReleaseSources(tx, before.orderIds);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Shipment" WHERE "id"=${params.shipmentId} FOR UPDATE`);
  const after = await hints(tx, params.shipmentId, params.allocationId, params.orderId);
  if (!same(before.identity, after.identity)) return conflict('原票来源订单或分配集合在锁定时变化，请重试原请求。');
  await lockIds(tx, 'ShipmentOrderAllocation', after.allocations.map((row: any) => row.id));
  if (usesActor) {
    const finalActor = await currentActor(tx, params.actor!);
    if (finalActor.userId !== actor!.userId) return conflict('执行主体在取得锁时变化，请核对原请求。');
    await visibleOrders(tx, after.orderIds, finalActor);
  }
  if (await tx.productionBatch.count({ where: { orderId: { in: after.orderIds } } })
    || await tx.shipmentProductionAllocation.count({ where: { shipmentId: params.shipmentId } }))
    return conflict('本票已有真实生产批次或实物分配历史，请核对原关联；不能退回旧分配或删除历史。');
}

function receiptRows(projection: any): PhysicalRow[] {
  const scope = projection.scopeSnapshot;
  if (!scope || scope.schemaVersion !== 1 || !Number.isSafeInteger(scope.allocationVersion) || scope.allocationVersion < 1
    || scope.scopeType !== 'production_batch' || scope.scopeKey !== `production_batch:${projection.productionBatchId}`
    || typeof scope.scopeFingerprint !== 'string' || scope.scopeFingerprint !== qcReportSourceFingerprint(scope.scopeSnapshot)
    || !Array.isArray(scope.receiptAllocations) || !scope.receiptAllocations.length) return conflict('既有实物分配来源或版本不完整，请核对历史记录。');
  try { return scope.receiptAllocations.map((row: any) => physicalRow({ productionBatchId: projection.productionBatchId,
    expectedRevision: projection.productionBatchRevision, expectedScopeFingerprint: scope.scopeFingerprint,
    stockReceiptId: row.stockReceiptId, ...(row.factoryLoadingReceiptId ? { factoryLoadingReceiptId: row.factoryLoadingReceiptId } : {}),
    plannedQty: row.plannedQty, actualQty: row.actualQty, unit: row.unit })); }
  catch (error) { if (isBusinessError(error)) return conflict('既有实物分配关联不完整，请核对原记录。'); throw error; }
}
function requireTotal(total: Quantity, rows: PhysicalRow[], key: 'plannedQty' | 'actualQty') {
  if (total === null) { if (rows.some(row => row[key] !== null)) return conflict('未知总量不能冒充已知批次分配合计。'); return; }
  if (rows.some(row => row[key] === null) || !rows.reduce((sum, row) => sum.plus(row[key]!), new Prisma.Decimal(0)).equals(total)) return conflict('批次关联的计划和实际数量须分别精确等于原 SOA 数量。');
}
function knownSum(rows: PhysicalRow[], key: 'plannedQty' | 'actualQty'): Quantity {
  return rows.some(row => row[key] === null) ? null : rows.reduce((sum, row) => sum.plus(row[key]!), new Prisma.Decimal(0)).toString();
}
function occupied(row: { plannedQty: Quantity; actualQty: Quantity }, state: string): Prisma.Decimal {
  if (state === 'released' || state === 'reversed') return new Prisma.Decimal(0);
  if (state === 'shipped') return row.actualQty === null ? conflict('已发运分配缺少真实实际数量。') : new Prisma.Decimal(row.actualQty);
  if (state !== 'reserved' || (row.plannedQty === null && row.actualQty === null)) return conflict('实物分配状态或数量无法核验。');
  // A null side is unquantified, never a fabricated zero. At least one side is known.
  return row.plannedQty === null ? new Prisma.Decimal(row.actualQty!) : row.actualQty === null ? new Prisma.Decimal(row.plannedQty)
    : Prisma.Decimal.max(row.plannedQty, row.actualQty);
}

const nativeFields = ['id', 'shipmentId', 'orderId', 'orderLineId', 'plannedQty', 'actualQty', 'unit', 'status', 'batchOrCartonNote', 'exception', 'createdAt', 'updatedAt'];
function nativeAllocation(value: any) { return Object.fromEntries(nativeFields.map(key => [key, value[key]])); }
function readAck(audit: any): any {
  const after = audit?.detail?.after, ack = after?.ack;
  if (!actions.includes(audit?.action) || audit.detail?.source !== source || audit.targetType !== 'ShipmentOrderAllocation'
    || after?.schemaVersion !== 1 || !Number.isSafeInteger(after.allocationVersion) || after.allocationVersion < 1
    || audit.targetId !== after.allocationId || audit.actorId !== after.actorId || !ack || ack.id !== after.allocationId
    || ack.shipmentId !== after.shipmentId || ack.actorId !== after.actorId || ack.operation !== audit.action
    || ack.replayed !== false || ack.allocationVersion !== after.allocationVersion || ack.requestKey !== after.requestKey
    || ack.commandHash !== after.commandHash || !same(ack.commandSnapshot, after.command)
    || !Array.isArray(ack.productionBatchAllocations) || !ack.productionBatchAllocations.length
    || after.ackHash !== qcReportSourceFingerprint(ack)
    || after.commandHash !== physicalShipmentAllocationCommandHash({ operation: audit.action, shipmentId: after.shipmentId,
      allocationId: audit.action === createAction ? null : after.allocationId, actorId: after.actorId, command: after.command })
    || audit.transactionId !== requestTransactionId(after.actorId, after.shipmentId, audit.action, after.requestKey))
    return conflict('原分配命令或不可变回执受损，请核对原记录。');
  let controlled: Command;
  try { controlled = command(after.command, audit.action === updateAction); }
  catch { return conflict('原分配命令不完整，请核对原记录。'); }
  if (!same(controlled, after.command)) return conflict('原分配命令不是受控参数，请核对原记录。');
  return ack;
}
function requestTransactionId(actorId: string, shipmentId: string, operation: string, requestKey: string) {
  return `physical-allocation:${qcReportSourceFingerprint({ actorId, shipmentId, operation, requestKey })}`;
}
async function allocationHistory(tx: any, allocation: any, projections: any[]): Promise<number> {
  const audits = await tx.auditLog.findMany({ where: { targetType: 'ShipmentOrderAllocation', targetId: allocation.id, action: { in: actions } } });
  if (!audits.length) { if (projections.length) return conflict('既有实物分配缺少完整原命令和版本审计，不能自动补造。'); return 0; }
  const acks = audits.map(readAck).sort((a: any, b: any) => a.allocationVersion - b.allocationVersion);
  if (acks.some((ack: any, i: number) => ack.allocationVersion !== i + 1)) return conflict('实物分配版本历史不连续，请核对原记录。');
  const latest = acks[acks.length - 1];
  if (!same(nativeAllocation(json(allocation)), nativeAllocation(latest)) || !same(json(projections), latest.productionBatchAllocations))
    return conflict('当前分配与最后完整审计版本不一致，请核对原记录。');
  return latest.allocationVersion;
}

/** Same Order/Line locks serialize old and new allocation writers. An older
 * SOA without proven physical identity is not zero occupancy and cannot be
 * apportioned to this batch. The exact SOA being restored by PATCH is excluded.
 * Shipment state and update timestamps may subsequently change; immutable
 * source/quantity/scope facts must still match its recorded allocation version. */
async function assertNoUnresolvedLegacyOccupancy(tx: any, context: any): Promise<void> {
  const allocations = await tx.shipmentOrderAllocation.findMany({ where: {
    orderId: context.orderId, status: { not: 'Cancelled' },
    OR: [{ orderLineId: context.lineId }, { orderLineId: null }],
    ...(context.existing ? { id: { not: context.existing.id } } : {}),
  }, orderBy: { id: 'asc' } });
  if (!allocations.length) return;
  const shipments = await tx.shipment.findMany({ where: {
    id: { in: [...new Set(allocations.map((row: any) => row.shipmentId))] }, deletedAt: null, status: { not: 'Cancelled' },
  }, select: { id: true } });
  const activeShipments = new Set(shipments.map((row: any) => row.id));
  const meaningful = allocations.filter((row: any) => activeShipments.has(row.shipmentId));
  const projections = await tx.shipmentProductionAllocation.findMany({ where: {
    allocationId: { in: meaningful.map((row: any) => row.id) },
  }, orderBy: { id: 'asc' } });
  const unresolved = () => conflict('本行或整单还有未核清物理来源的原分配，请先核对原关联；不能把历史占用当作零或猜入当前批次。');
  for (const allocation of meaningful) {
    const planned = savedQuantity(allocation.plannedQty), actual = savedQuantity(allocation.actualQty);
    if (planned !== null && actual !== null && new Prisma.Decimal(planned).isZero() && new Prisma.Decimal(actual).isZero()) continue;
    const physical = projections.filter((row: any) => row.allocationId === allocation.id);
    if (!physical.length || !allocation.orderLineId || physical.some((row: any) => row.shipmentId !== allocation.shipmentId
      || row.orderId !== allocation.orderId || row.orderLineId !== allocation.orderLineId || row.unit !== allocation.unit
      || !['reserved', 'shipped', 'released', 'reversed'].includes(row.state))) return unresolved();
    const audits = await tx.auditLog.findMany({ where: { targetType: 'ShipmentOrderAllocation', targetId: allocation.id, action: { in: actions } } });
    const acks = audits.map(readAck).sort((a: any, b: any) => a.allocationVersion - b.allocationVersion);
    if (!acks.length || acks.some((ack: any, i: number) => ack.allocationVersion !== i + 1)) return unresolved();
    const latest = acks[acks.length - 1];
    if (latest.shipmentId !== allocation.shipmentId || latest.orderId !== allocation.orderId || latest.orderLineId !== allocation.orderLineId
      || latest.unit !== allocation.unit || savedQuantity(latest.plannedQty) !== planned || savedQuantity(latest.actualQty) !== actual
      || latest.productionBatchAllocations.length !== physical.length) return unresolved();
    for (const row of physical) {
      receiptRows(row);
      const recorded = latest.productionBatchAllocations.find((value: any) => value.id === row.id);
      if (!recorded || recorded.allocationId !== row.allocationId || recorded.shipmentId !== row.shipmentId
        || recorded.orderId !== row.orderId || recorded.orderLineId !== row.orderLineId || recorded.productionBatchId !== row.productionBatchId
        || recorded.productionBatchRevision !== row.productionBatchRevision || recorded.unit !== row.unit
        || savedQuantity(recorded.plannedQty) !== savedQuantity(row.plannedQty) || savedQuantity(recorded.actualQty) !== savedQuantity(row.actualQty)
        || !same(recorded.scopeSnapshot, row.scopeSnapshot)) return unresolved();
    }
    const activeRows = physical.filter((row: any) => ['reserved', 'shipped'].includes(row.state)).flatMap(receiptRows);
    if (!activeRows.length) return unresolved();
    requireTotal(planned, activeRows, 'plannedQty'); requireTotal(actual, activeRows, 'actualQty');
  }
}

async function lockIds(tx: any, table: 'ProductionBatch' | 'ShipmentOrderAllocation' | 'ShipmentProductionAllocation' | 'ProductionStockReceipt' | 'FactoryLoadingReceipt' | 'Warehouse' | 'InventoryItem', ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" IN (${Prisma.join(sorted)}) ORDER BY "id" FOR UPDATE`);
}
async function lockedContext(tx: any, params: PhysicalAllocationParams, raw: Record<string, any>) {
  const firstActor = await allocationActor(tx, params);
  const before = await hints(tx, params.shipmentId, params.allocationId,
    typeof raw.orderId === 'string' ? raw.orderId.trim() : undefined, typeof raw.orderLineId === 'string' ? raw.orderLineId.trim() : undefined);
  if (!before.orderId || !before.lineId) return invalid('实际批次分配须定位真实订单行。');
  await visibleOrders(tx, before.orderIds, firstActor);
  const ownPhysical = await tx.shipmentProductionAllocation.findMany({ where: { shipmentId: params.shipmentId }, orderBy: { id: 'asc' } });
  for (const row of ownPhysical) {
    const owner = before.allocations.find((allocation: any) => allocation.id === row.allocationId);
    if (!owner || owner.orderId !== row.orderId || owner.orderLineId !== row.orderLineId) return conflict('实物分配与原 SOA 归属不一致，请核对历史。');
  }
  await lockReleaseSources(tx, before.orderIds);
  const relatedBatches = await tx.productionBatch.findMany({ where: { orderId: { in: before.orderIds } }, orderBy: { id: 'asc' } });
  if (ownPhysical.some((p: any) => !relatedBatches.some((b: any) => b.id === p.productionBatchId && b.orderId === p.orderId && b.orderLineId === p.orderLineId))) return conflict('本票实物分配的原批次来源已缺失或跨单。');
  await lockIds(tx, 'ProductionBatch', relatedBatches.map((row: any) => row.id));
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Shipment" WHERE "id"=${params.shipmentId} FOR UPDATE`);
  const after = await hints(tx, params.shipmentId, params.allocationId,
    typeof raw.orderId === 'string' ? raw.orderId.trim() : undefined, typeof raw.orderLineId === 'string' ? raw.orderLineId.trim() : undefined);
  if (!same(before.identity, after.identity)) return conflict('本票来源订单或分配集合在锁定时变化，请读取当前票后重试。');
  await lockIds(tx, 'ShipmentOrderAllocation', after.allocations.map((row: any) => row.id));
  const physical = await tx.shipmentProductionAllocation.findMany({ where: { productionBatchId: { in: relatedBatches.map((row: any) => row.id) } }, orderBy: { id: 'asc' } });
  await lockIds(tx, 'ShipmentProductionAllocation', physical.map((row: any) => row.id));
  const actualPhysical = await tx.shipmentProductionAllocation.findMany({ where: { shipmentId: params.shipmentId }, orderBy: { id: 'asc' } });
  const anchors = (rows: any[]) => rows.map(row => [row.id, row.allocationId, row.orderId, row.orderLineId, row.productionBatchId]);
  if (!same(anchors(ownPhysical), anchors(actualPhysical))) return conflict('本票实物来源集合在锁定时已变化，请重试原请求。');
  // The final authority is fresh ReadCommitted data AFTER source/parent locks.
  const actor = await allocationActor(tx, params), orders = await visibleOrders(tx, before.orderIds, actor);
  const refreshed = await hints(tx, params.shipmentId, params.allocationId,
    typeof raw.orderId === 'string' ? raw.orderId.trim() : undefined, typeof raw.orderLineId === 'string' ? raw.orderLineId.trim() : undefined);
  if (!same(before.identity, refreshed.identity)) return conflict('本票来源集合已变化，请核对原请求。');
  const currentBatches = await tx.productionBatch.findMany({ where: { orderId: { in: before.orderIds } }, orderBy: { id: 'asc' } });
  if (!same(relatedBatches.map((b: any) => [b.id, b.orderId, b.orderLineId]), currentBatches.map((b: any) => [b.id, b.orderId, b.orderLineId]))) return conflict('实际批次来源集合已变化，请重试原请求。');
  return { ...refreshed, actor, orders, batches: currentBatches,
    physical: await tx.shipmentProductionAllocation.findMany({ where: { productionBatchId: { in: currentBatches.map((b: any) => b.id) } }, orderBy: { id: 'asc' } }) };
}
function consolidation(orders: any[]) {
  const first = orders[0];
  if (!first) return invalid('实际批次分配须定位订单。');
  const identity = (relationId: unknown, label: unknown) => {
    if (typeof relationId === 'string' && relationId.trim()) return `id:${relationId.trim()}`;
    return typeof label === 'string' && label.trim() ? `name:${label.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}` : null;
  };
  const firstConsignee = identity(first.consigneeRelationId, first.consigneeName ?? first.shipToName);
  if (!firstConsignee) return invalid('实际批次出运来源订单须已有明确收货方。');
  for (const order of orders.slice(1)) {
    if (identity(first.customerRelationId, first.customer) !== identity(order.customerRelationId, order.customer)) return conflict('合票仅允许同一真实客户的来源订单。');
    if (identity(order.consigneeRelationId, order.consigneeName ?? order.shipToName) !== firstConsignee) return conflict('合票仅允许同一收货方的来源订单。');
    if ((first.businessLine ?? 'other') !== (order.businessLine ?? 'other')) return conflict('合票仅允许同一业务线的来源订单。');
  }
}

/** Validates the actual producer's immutable command/ACK/audit and Inbound.
 * Public SPA snapshots expose identities only, never receipt costs or its ACK. */
async function originalReceipt(tx: any, id: string, batch: any, scopeFingerprint: string, historical=false, ancestors=new Set<string>()): Promise<{receipt:any;item:any;available:Prisma.Decimal;identity:{stockReceiptId:string;warehouseId:string;inventoryItemId:string;stockMovementId:string;productionBatchRevision:number;receivedQuantity:string;unit:string;receiptScopeFingerprint:string;receiptCommandHash:string}}> {
  const receipt = await tx.productionStockReceipt.findUnique({ where: { id } });
  if (!receipt || receipt.productionBatchId !== batch.id || receipt.orderId !== batch.orderId || receipt.orderLineId !== batch.orderLineId
    || receipt.productionBatchRevision !== batch.revision || receipt.unit !== batch.unit || receipt.scopeFingerprint !== scopeFingerprint
    || receipt.scopeFingerprint !== qcReportSourceFingerprint(receipt.scopeSnapshot)) return conflict('原收货凭据与当前批次范围不一致。');
  if(receipt.commandSnapshot?.operation===TRANSFER_RECEIPT_OPERATION){if(ancestors.has(id))return conflict('调拨收货来源循环');const next=new Set(ancestors);next.add(id);return verifyTransferredProductionReceipt(tx,receipt,batch,scopeFingerprint,sourceId=>originalReceipt(tx,sourceId,batch,scopeFingerprint,true,next),ancestors,historical);}
  const cmd = receipt.commandSnapshot, ack = receipt.receiptSnapshot;
  if (!cmd || !ack?.receipt || !ack.inventoryItem || !ack.movement || ack.replayed !== false
    || receipt.commandHash !== qcReportSourceFingerprint({ operation: 'receive_production_batch_stock', batchId: batch.id, actorId: receipt.createdBy, command: cmd })
    || cmd.requestKey !== receipt.requestKey || cmd.expectedBatchRevision !== receipt.productionBatchRevision || cmd.expectedScopeFingerprint !== receipt.scopeFingerprint
    || cmd.warehouseId !== receipt.warehouseId || cmd.quantity !== String(receipt.quantity) || cmd.unit !== receipt.unit
    || cmd.movementDate !== receipt.movementDate || cmd.receiptReference !== receipt.receiptReference) return conflict('原入库命令或冻结回执不完整。');
  const { receiptSnapshot: _current, ...persisted } = json(receipt), { receiptSnapshot: _original, ...frozen } = ack.receipt;
  if (!same(persisted, frozen)) return conflict('原收货凭据已偏离其冻结回执。');
  const audits = await tx.auditLog.findMany({ where: { action: 'receive_production_batch_stock', targetType: 'ProductionStockReceipt', targetId: id } });
  if (audits.length !== 1 || audits[0].actorId !== receipt.createdBy || audits[0].detail?.source !== 'route:production:physical-stock-receipt'
    || audits[0].detail?.after?.productionBatchId !== batch.id || audits[0].detail?.after?.orderLineId !== batch.orderLineId
    || audits[0].detail?.after?.requestKey !== receipt.requestKey || audits[0].detail?.after?.commandHash !== receipt.commandHash
    || !same(audits[0].detail?.after?.command, cmd) || !same(audits[0].detail?.after?.receipt, ack)) return conflict('原生收货缺少准确创建审计，不能仅凭收货 ID 分配。');
  const item = await tx.inventoryItem.findUnique({ where: { id: receipt.inventoryItemId } });
  const movement = await tx.stockMovement.findUnique({ where: { id: receipt.stockMovementId } });
  const warehouse = await tx.warehouse.findUnique({ where: { id: receipt.warehouseId } });
  const oldItem = ack.inventoryItem;
  if (!item || !warehouse || (!historical && (item.deletedAt != null || warehouse.deletedAt != null || !warehouse.isActive))
    || (!historical && (item.warehouseId !== receipt.warehouseId || item.orderId !== receipt.orderId || item.unit !== receipt.unit
    || item.id !== oldItem.id || item.warehouseId !== oldItem.warehouseId || item.orderId !== oldItem.orderId || item.unit !== oldItem.unit
    || item.ownership !== oldItem.ownership
    || item.materialCode !== oldItem.materialCode || item.batchNumber !== oldItem.batchNumber || item.productAssetId !== oldItem.productAssetId))
    || !['Owned', 'Transferred'].includes(oldItem.ownership) || cmd.ownership !== oldItem.ownership || cmd.currency !== oldItem.currency
    || !same(cmd.unitCost, oldItem.unitCost) || !movement || !same(json(movement), ack.movement)
    || movement.type !== 'Inbound' || movement.itemId !== item.id || movement.warehouseId !== receipt.warehouseId
    || movement.unit !== receipt.unit || !new Prisma.Decimal(movement.quantity).equals(receipt.quantity)
    || !new Prisma.Decimal(movement.balanceBefore).equals(0) || !new Prisma.Decimal(movement.balanceAfter).equals(receipt.quantity)
    || movement.operator !== receipt.createdBy || movement.referenceType !== 'ProductionBatch' || movement.referenceId !== batch.id)
    return conflict('原入库流水或当前库存归属、仓库、单位已变化；跨仓承接须另行核对。');
  const currentQty = savedQuantity(item.quantity), lockedQty = savedQuantity(item.lockedQuantity);
  if (currentQty === null || lockedQty === null || new Prisma.Decimal(lockedQty).gt(currentQty)) return conflict('当前库存可用数量无法核验。');
  return { receipt, item, available: new Prisma.Decimal(currentQty).minus(lockedQty), identity: {
    stockReceiptId: receipt.id, warehouseId: receipt.warehouseId, inventoryItemId: receipt.inventoryItemId, stockMovementId: receipt.stockMovementId,
    productionBatchRevision: receipt.productionBatchRevision, receivedQuantity: String(receipt.quantity), unit: receipt.unit,
    receiptScopeFingerprint: receipt.scopeFingerprint, receiptCommandHash: receipt.commandHash } };
}

async function preparePhysical(tx: any, context: any, rows: PhysicalRow[], prior: any[], version: number) {
  const byBatch = new Map<string, PhysicalRow[]>();
  for (const row of rows) {
    const group = byBatch.get(row.productionBatchId) ?? []; group.push(row); byBatch.set(row.productionBatchId, group);
  }
  const scopes = new Map<string, any>();
  for (const [batchId, group] of byBatch) {
    const batch = context.batches.find((value: any) => value.id === batchId);
    if (!batch || batch.orderId !== context.orderId || batch.orderLineId !== context.lineId) return conflict('实际批次不属于本条分配的订单行。');
    if (prior.some(value => value.productionBatchId === batchId && value.state !== 'reserved')) return conflict('已释放、冲回或发运的原批次分配不能原地重写，请按原票续办。');
    await resolveCurrentProductionBatchFacts(tx, batch);
    const coverage = await resolveQcCoverage(tx, context.orderId, { scopeType: 'production_batch', productionBatchId: batchId });
    if (group.some(row => row.expectedRevision !== batch.revision || row.expectedScopeFingerprint !== coverage.scopeFingerprint || row.unit !== batch.unit)) return conflict('当前批次修订、范围或单位已变化，请核对原请求。');
    scopes.set(batchId, coverage);
  }
  // Batch locks serialize all new reservations. Receipt -> Warehouse -> Item
  // locks also serialize real stock writers; no same-SKU warehouse selection.
  const relevant = context.physical.filter((p: any) => byBatch.has(p.productionBatchId) && p.allocationId !== context.existing?.id);
  if (relevant.some((p: any) => !['reserved', 'shipped', 'released', 'reversed'].includes(p.state))) return conflict('该批次既有实物分配状态无法核验，不能当作零占用。');
  const counted = relevant.filter((p: any) => ['reserved', 'shipped'].includes(p.state));
  const others = counted.flatMap((p: any) => receiptRows(p).map(row => ({ row, state: p.state, projection: p })));
  const directRows = [...rows.map(row => ({ row, shipmentId: context.shipment.id, allocationId: context.existing?.id })),
    ...others.map((item: any) => ({ row: item.row, shipmentId: item.projection.shipmentId, allocationId: item.projection.allocationId }))]
    .filter(item => item.row.factoryLoadingReceiptId);
  await lockIds(tx, 'FactoryLoadingReceipt', directRows.map(item => item.row.factoryLoadingReceiptId!));
  const direct = new Map<string, Awaited<ReturnType<typeof verifyFactoryLoadingReceiptInTx>>>();
  for (const { row, shipmentId, allocationId } of directRows) {
    const batch = context.batches.find((b: any) => b.id === row.productionBatchId);
    if (!allocationId || !batch) return conflict('工厂直出凭据必须定位原交接订单行分配。');
    const fact = await verifyFactoryLoadingReceiptInTx(tx, row.factoryLoadingReceiptId!, batch, row.expectedScopeFingerprint, { shipmentId, allocationId });
    if (row.actualQty === null || new Prisma.Decimal(row.actualQty).gt(fact.receipt.quantity)) return conflict('工厂直出实际数量不能未知或超过原实装凭据。');
    direct.set(row.factoryLoadingReceiptId!, fact);
  }
  const receiptIds = [...rows, ...others.map((value: any) => value.row)].map(row => row.stockReceiptId).filter((id): id is string => id !== null);
  await lockIds(tx, 'ProductionStockReceipt', receiptIds);
  const receipts = receiptIds.length ? await tx.productionStockReceipt.findMany({ where: { id: { in: [...new Set(receiptIds)] } } }) : [];
  if (receipts.length !== new Set(receiptIds).size) return conflict('关联的原生收货凭据已缺失，请核对原记录。');
  await lockIds(tx, 'Warehouse', receipts.map((r: any) => r.warehouseId));
  await lockIds(tx, 'InventoryItem', receipts.map((r: any) => r.inventoryItemId));
  const verified = new Map<string, Awaited<ReturnType<typeof originalReceipt>>>();
  for (const id of [...new Set(receiptIds)].sort()) {
    const receipt = receipts.find((r: any) => r.id === id), batch = context.batches.find((b: any) => b.id === receipt.productionBatchId);
    if (!batch) return conflict('原收货批次不在已锁定的来源集合。');
    const coverage = scopes.get(batch.id) ?? await resolveQcCoverage(tx, batch.orderId, { scopeType: 'production_batch', productionBatchId: batch.id });
    verified.set(id, await originalReceipt(tx, id, batch, coverage.scopeFingerprint));
  }
  for (const row of [...rows, ...others.map((value: any) => value.row)]) {
    if (!row.stockReceiptId) continue;
    const fact = verified.get(row.stockReceiptId)!;
    if (fact.receipt.productionBatchId !== row.productionBatchId || fact.receipt.productionBatchRevision !== row.expectedRevision
      || fact.receipt.unit !== row.unit || fact.receipt.scopeFingerprint !== row.expectedScopeFingerprint) return conflict('原收货凭据不能跨批次、修订或单位借用。');
  }
  for (const projection of counted) {
    if (projection.scopeSnapshot.scopeFingerprint !== scopes.get(projection.productionBatchId).scopeFingerprint) return conflict('该批次既有预留的当前范围已变化，请先核对原计划。');
    for (const row of projection.scopeSnapshot.receiptAllocations) {
      if (row.stockReceiptId && Object.entries(verified.get(row.stockReceiptId)!.identity).some(([key, value]) => row[key] !== value)) return conflict('原收货关联的真实库存身份已受损。');
      if (row.factoryLoadingReceiptId && Object.entries(direct.get(row.factoryLoadingReceiptId)!.identity).some(([key, value]) => row[key] !== value)) return conflict('原工厂直出关联的核验身份已受损。');
    }
    const audits = await tx.auditLog.findMany({ where: { targetType: 'ShipmentOrderAllocation', targetId: projection.allocationId, action: { in: actions } } });
    const originalVersion = audits.map(readAck).filter((ack: any) => ack.allocationVersion === projection.scopeSnapshot.allocationVersion);
    if (originalVersion.length !== 1 || !originalVersion[0].productionBatchAllocations.some((p: any) => p.id === projection.id
      && p.allocationId === projection.allocationId && p.shipmentId === projection.shipmentId && p.orderId === projection.orderId && p.orderLineId === projection.orderLineId
      && p.productionBatchId === projection.productionBatchId && p.productionBatchRevision === projection.productionBatchRevision && p.unit === projection.unit
      && savedQuantity(p.plannedQty) === savedQuantity(projection.plannedQty) && savedQuantity(p.actualQty) === savedQuantity(projection.actualQty)
      && same(p.scopeSnapshot, projection.scopeSnapshot))) return conflict('既有批次预留缺少准确不可变来源审计。');
  }
  const batchUse = new Map<string, Prisma.Decimal>(), receiptUse = new Map<string, Prisma.Decimal>(), reservedStock = new Map<string, Prisma.Decimal>();
  const add = (map: Map<string, Prisma.Decimal>, key: string, qty: Prisma.Decimal) => map.set(key, (map.get(key) ?? new Prisma.Decimal(0)).plus(qty));
  const count = (row: PhysicalRow, state: string, projection?: any) => {
    if (projection && (projection.productionBatchRevision !== row.expectedRevision || projection.unit !== row.unit
      || projection.orderId !== context.batches.find((b: any) => b.id === row.productionBatchId)?.orderId
      || projection.orderLineId !== context.batches.find((b: any) => b.id === row.productionBatchId)?.orderLineId)) return conflict('既有实物分配的真实归属或单位无法核验。');
    const qty = occupied(row, state); add(batchUse, row.productionBatchId, qty);
    if (row.stockReceiptId) { add(receiptUse, row.stockReceiptId, qty); if (state === 'reserved') add(reservedStock, row.stockReceiptId, qty); }
  };
  for (const projection of counted) {
    const originalRows = receiptRows(projection);
    requireTotal(savedQuantity(projection.plannedQty), originalRows, 'plannedQty'); requireTotal(savedQuantity(projection.actualQty), originalRows, 'actualQty');
  }
  for (const { row, state, projection } of others) count(row, state, projection);
  for (const row of rows) count(row, 'reserved');
  for (const [batchId, qty] of batchUse) {
    const batch = context.batches.find((b: any) => b.id === batchId);
    if (!batch || qty.gt(batch.quantity)) return conflict('全批次已预留或实际发运数量超过受控批次数量。');
  }
  for (const [receiptId, qty] of receiptUse) {
    const fact = verified.get(receiptId)!;
    if (qty.gt(fact.receipt.quantity) || (reservedStock.get(receiptId) ?? new Prisma.Decimal(0)).gt(fact.available)) return conflict('该原收货凭据已分配或当前可用库存不足，请明确调整原计划。');
  }
  return [...byBatch].sort(([a], [b]) => a.localeCompare(b)).map(([batchId, group]) => {
    const coverage = scopes.get(batchId), batch = context.batches.find((b: any) => b.id === batchId);
    return { productionBatchId: batchId, productionBatchRevision: batch.revision, plannedQty: knownSum(group, 'plannedQty'), actualQty: knownSum(group, 'actualQty'), unit: batch.unit,
      scopeSnapshot: { schemaVersion: 1, allocationVersion: version, scopeType: coverage.scopeType, scopeKey: coverage.scopeKey,
        scopeFingerprint: coverage.scopeFingerprint, scopeSnapshot: coverage.scopeSnapshot,
        receiptAllocations: group.map(row => ({ ...(row.stockReceiptId ? verified.get(row.stockReceiptId)!.identity : row.factoryLoadingReceiptId
          ? direct.get(row.factoryLoadingReceiptId)!.identity : { warehouseId: null, inventoryItemId: null, stockMovementId: null }),
          stockReceiptId: row.stockReceiptId, plannedQty: row.plannedQty, actualQty: row.actualQty, unit: row.unit })) } };
  });
}

async function writeInTx(tx: any, params: PhysicalAllocationParams) {
  // Do not let malformed body metadata supply a principal. The trusted actor
  // is loaded before source hint reads and again after every relevant lock.
  await allocationActor(tx, params);
  const raw = object(params.input);
  const context = await lockedContext(tx, params, raw), operation = params.allocationId ? updateAction : createAction;
  // Historical order-level allocations have no precise fulfilment identity.
  // Keep them readable, but never let the physical writer reinterpret an old
  // null-line row as whichever line a caller supplies today.
  if (params.allocationId && context.existing?.orderLineId == null) {
    return conflict('历史整单分配只能查看；请按准确订单行新建分配。');
  }
  if (typeof tx.shipmentHandoff?.findUnique === 'function') {
    const linked = await tx.shipmentHandoff.findUnique({ where: { shipmentId: params.shipmentId } });
    if (linked && linked.status !== 'Cancelled') {
      const expectedOperation = params.handoffAuthorization?.operation;
      const allowedStatus = expectedOperation === 'create' ? linked.status === 'PendingLogistics'
        : expectedOperation === 'revise' ? linked.status === 'NeedsBusinessDecision'
          : expectedOperation === 'record-actual' ? linked.status === 'Processing' : false;
      if (linked.id !== params.handoffAuthorization?.handoffId || !allowedStatus
        || (expectedOperation === 'create' && params.allocationId) || (expectedOperation !== 'create' && !params.allocationId))
        return conflict('该票已由出运交接托管，物理分配只能通过交接创建、业务修订或后勤核实实际量命令修改。');
    }
  }
  const requestKey = text(raw.requestKey, '原请求键'), transactionId = requestTransactionId(context.actor.userId, params.shipmentId, operation, requestKey);
  const original = await tx.auditLog.findMany({ where: { transactionId } });
  if (original.length > 1) return conflict('同一原请求有重复审计回执，请核对历史。');
  let input: Command;
  try { input = command(raw, !!params.allocationId); }
  catch (error) { if (original.length) return conflict('原请求键已绑定其他参数或回执受损，请核对原命令。'); throw error; }
  const commandHash = physicalShipmentAllocationCommandHash({ operation, shipmentId: params.shipmentId,
    allocationId: params.allocationId ?? null, actorId: context.actor.userId, command: input });
  if (original.length) {
    const ack = readAck(original[0]);
    if (ack.actorId !== context.actor.userId || ack.shipmentId !== params.shipmentId || ack.operation !== operation
      || (params.allocationId && ack.id !== params.allocationId) || ack.commandHash !== commandHash || !same(ack.commandSnapshot, input)) return conflict('原请求键已绑定其他完整参数。');
    // Replay never borrows current batch eligibility, a mutable projection or
    // a later ACK. Current account, ceiling and every parent L2 remain required.
    return { ...ack, replayed: true };
  }
  if (!['Draft', 'Booked', 'Loading'].includes(context.shipment.status)) return conflict('仅未发运且未取消的票可修改实际批次分配。');
  const [replacement, repair] = await Promise.all([
    tx.claimDisposition.findFirst({ where: { replacementShipmentId: params.shipmentId }, select: { id: true } }),
    tx.repairWorkOrder.findFirst({ where: { reshipmentId: params.shipmentId }, select: { id: true } }),
  ]);
  if (replacement || repair) return conflict('售后补发或返修运单须使用原售后库存合同，不能冒充销售订单分配。');
  if (!params.allocationId && !input.productionBatchAllocations) return conflict('存在真实生产批次，须明确提交原生批次分配清单。');
  const existing = context.existing, prior = existing ? context.physical.filter((p: any) => p.allocationId === existing.id) : [];
  if (existing && String(existing.updatedAt) !== input.expectedAllocationUpdatedAt) return conflict('原分配更新时间已变化，请读取当前记录后重试。');
  if (existing && (input.orderId !== undefined && input.orderId !== existing.orderId || input.orderLineId !== undefined && input.orderLineId !== existing.orderLineId)) return conflict('本条分配的真实订单行不能原地更换。');
  if (existing?.status === 'Cancelled' || prior.some((p: any) => !['reserved', 'released'].includes(p.state))
    || prior.length && !prior.some((p: any) => p.state === 'reserved')) return conflict('已释放、冲回或发运的历史分配不能原地重写，请核对原请求。');
  const version = (existing ? await allocationHistory(tx, existing, prior) : 0) + 1;
  if (!existing && context.allocations.some((a: any) => a.orderId === context.orderId && (a.orderLineId === context.lineId || a.orderLineId === null))) return conflict('同票同订单行或整单分配不能重复，修改请使用原记录。');
  const allocationOrders = new Set([context.orderId, ...context.allocations.map((row: any) => row.orderId)]);
  consolidation(context.orders.filter((order: any) => allocationOrders.has(order.id)));
  const line = await tx.orderLine.findUnique({ where: { id: context.lineId } });
  if (!line || line.orderId !== context.orderId) return conflict('真实订单行归属已变化。');
  const has = (key: keyof Command) => Object.prototype.hasOwnProperty.call(input, key);
  const effective = { plannedQty: has('plannedQty') ? input.plannedQty! : existing ? savedQuantity(existing.plannedQty) : null,
    actualQty: has('actualQty') ? input.actualQty! : existing ? savedQuantity(existing.actualQty) : null,
    unit: input.unit ?? existing?.unit, status: input.status ?? existing?.status ?? 'Planned',
    batchOrCartonNote: has('batchOrCartonNote') ? input.batchOrCartonNote : existing?.batchOrCartonNote ?? null,
    exception: has('exception') ? input.exception : existing?.exception ?? null };
  if (effective.plannedQty === null && effective.actualQty === null) return invalid('本条分配至少须有一项明确的计划或实际数量。');
  if (effective.unit !== line.unit) return conflict('实际批次分配单位须与真实订单行一致，不隐式换算。');
  const reserved = prior.filter((p: any) => p.state === 'reserved');
  const rows: PhysicalRow[] = input.productionBatchAllocations ?? reserved.flatMap(receiptRows);
  if (!rows.length) return conflict('既有关联没有完整实物分配，须明确提交原生清单。');
  requireTotal(effective.plannedQty, rows, 'plannedQty'); requireTotal(effective.actualQty, rows, 'actualQty');
  if (rows.some(row => row.unit !== effective.unit)) return conflict('批次关联单位与本条 SOA 不一致。');
  await assertNoUnresolvedLegacyOccupancy(tx, context);
  const cancelling = effective.status === 'Cancelled';
  if (cancelling && (!existing || effective.plannedQty !== savedQuantity(existing.plannedQty) || effective.actualQty !== savedQuantity(existing.actualQty)
    || !same(rows, reserved.flatMap(receiptRows)))) return conflict('取消仅释放原未发运预留，数量和收货历史须保持原样。');
  const nextPhysical = cancelling ? [] : await preparePhysical(tx, context, rows, prior, version);
  // Fresh authority includes stock-lock wait time; signed [] cannot recover a
  // withdrawn grant and failures cannot return a normal transaction result.
  const finalActor = await allocationActor(tx, params);
  if (finalActor.userId !== context.actor.userId) return conflict('执行主体在取得锁时变化，请保留原请求重新核对。');
  await visibleOrders(tx, context.orderIds, finalActor);
  const now = BigInt(Date.now()), timestamp = existing && now <= existing.updatedAt ? existing.updatedAt + BigInt(1) : now;
  const allocation = existing ? await tx.shipmentOrderAllocation.update({ where: { id: existing.id }, data: { ...effective, updatedAt: timestamp } })
    : await tx.shipmentOrderAllocation.create({ data: { id: `SHPA__${randomUUID()}`, shipmentId: params.shipmentId, orderId: context.orderId,
      orderLineId: context.lineId, ...effective, createdAt: timestamp, updatedAt: timestamp } });
  for (const projection of prior) {
    if (projection.state === 'reserved' && !nextPhysical.some(row => row.productionBatchId === projection.productionBatchId)) await tx.shipmentProductionAllocation.update({ where: { id: projection.id },
      data: { state: 'released', scopeSnapshot: { ...projection.scopeSnapshot, allocationVersion: version }, updatedBy: finalActor.userId, updatedAt: timestamp } });
  }
  for (const projection of nextPhysical) {
    const originalProjection = prior.find((p: any) => p.productionBatchId === projection.productionBatchId);
    if (originalProjection) await tx.shipmentProductionAllocation.update({ where: { id: originalProjection.id }, data: { ...projection, updatedBy: finalActor.userId, updatedAt: timestamp } });
    else await tx.shipmentProductionAllocation.create({ data: { id: `SPA__${randomUUID()}`, allocationId: allocation.id, shipmentId: params.shipmentId,
      orderId: context.orderId, orderLineId: context.lineId, ...projection, state: 'reserved', createdBy: finalActor.userId,
      updatedBy: finalActor.userId, createdAt: timestamp, updatedAt: timestamp } });
  }
  const first = await tx.shipmentOrderAllocation.findFirst({ where: { shipmentId: params.shipmentId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const primaryOrder = context.orders.find((o: any) => o.id === first?.orderId);
  await tx.shipment.update({ where: { id: params.shipmentId }, data: { orderId: first?.orderId ?? null, businessLine: primaryOrder?.businessLine ?? null, updatedAt: timestamp } });
  // Original Float UI projection only. All source quantities, reservations,
  // inventory checks and ACK facts above remain Decimal; no cache gates stock.
  await syncOrderLineShipmentQuantity(tx, context.orderId);
  const physical = await tx.shipmentProductionAllocation.findMany({ where: { allocationId: allocation.id }, orderBy: { id: 'asc' } });
  const ack = { ...json(allocation), productionBatchAllocations: json(physical), operation, actorId: finalActor.userId,
    allocationVersion: version, requestKey, commandHash, commandSnapshot: input, replayed: false };
  await writeRouteAuditLog({ prisma: tx, actorId: finalActor.userId, source, operation, targetType: 'ShipmentOrderAllocation', targetId: allocation.id,
    transactionId, operationType: existing ? 'update' : 'create', ip: params.ip,
    before: existing ? { allocation: json(existing), productionBatchAllocations: json(prior), allocationVersion: version - 1 } : null,
    after: { schemaVersion: 1, allocationVersion: version, shipmentId: params.shipmentId, allocationId: allocation.id, actorId: finalActor.userId,
      requestKey, commandHash, command: input, ack, ackHash: qcReportSourceFingerprint(ack) } });
  return ack;
}

/** External tx callers must enter before Shipment locks, in the same global
 * source->parents->batches order. Throw on any failure so the outer tx rolls
 * back; only the owning transaction translates a safe HTTP failure. */
export async function writePhysicalShipmentAllocation(params: PhysicalAllocationParams) {
  if (params.tx) return { ok: true as const, data: { allocation: await writeInTx(params.tx, params) } };
  try {
    const allocation = await params.prisma.$transaction((tx: any) => writeInTx(tx, params),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
    return { ok: true as const, data: { allocation } };
  } catch (error) {
    logger.error('[PhysicalShipmentAllocation] 原分配未确认', { error });
    const storageConflict = isOrderLineStorageConflict(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
    const safe = safeRouteError(storageConflict ? businessError('CONFLICT', '分配范围或原请求正在变化，请核对原键重试。') : error, { fallbackCode: 'INTERNAL_ERROR' });
    return { ok: false as const, error: { code: safe.code, message: safe.message, status: safe.status } };
  }
}

/** Internal physical consumers reuse the original native source proof. These
 * are transaction-only helpers; callers never receive private receipt ACKs. */
export const assertPhysicalShipmentWriteAuthority = currentActor;
export const validatePhysicalAllocationVersion = allocationHistory;
export const readPhysicalReceiptAllocations = receiptRows;
export const verifyOriginalProductionReceipt = originalReceipt;
