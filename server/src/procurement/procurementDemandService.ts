import { Prisma, PrismaClient, type ProcurementDemand } from '@prisma/client';
import { randomUUID, createHash } from 'crypto';
import type { TokenPayload } from '../auth/service';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { authorizeSupplierSources, freshSupplierActor, type SupplierContractTx } from './supplierContractAccess';
import { SupplierContractError } from './supplierContractPolicy';

export class DemandError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.statusCode = status; }
  readonly statusCode: number;
}
const fail = (code: string, message: string, status = 400): never => { throw new DemandError(code, message, status); };
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export function demandDecimal(value: unknown, label: string, zeroAllowed = false): Prisma.Decimal {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return fail('INVALID_NUMBER', `${label}必须为有效数字`);
  let n: Prisma.Decimal;
  try { n = new Prisma.Decimal(value); } catch { return fail('INVALID_NUMBER', `${label}必须为有效数字`); }
  if (!n.isFinite() || n.lt(0) || (!zeroAllowed && n.eq(0)) || n.decimalPlaces() > 4 || n.gte('100000000000000')) return fail('INVALID_NUMBER', `${label}必须${zeroAllowed ? '大于等于' : '大于'}零，最多四位小数`);
  return n;
}
function scope(orderId: string | null, visible: string[] | null) {
  if (visible !== null && (!orderId || !visible.includes(orderId))) fail('NOT_FOUND', '采购需求不存在或无权访问', 404);
}
export function createProcurementDemandService(prisma: PrismaClient) {
  async function transaction<T>(fn: (tx: SupplierContractTx) => Promise<T>): Promise<T> {
    try { return await prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (e) {
      if (e instanceof SupplierContractError) throw new DemandError(e.code, e.message, e.statusCode);
      const code = e != null && typeof e === 'object' && 'code' in e ? e.code : undefined;
      if (code === 'P2034' || code === 'P2002') throw new DemandError('CONFLICT', '需求已被其他操作更新，请刷新后重试；相同请求可安全重试', 409);
      throw e;
    }
  }
  function trusted(actorId: string, prior?: TokenPayload | null): TokenPayload {
    if (!prior?.userId) return fail('UNAUTHORIZED', '采购需求操作需要可信登录主体。', 401);
    if (prior.userId !== actorId) return fail('FORBIDDEN', '录入账号不能替代当前登录主体。', 403);
    return prior;
  }
  async function planningSources(tx: SupplierContractTx, source: Pick<ProcurementDemand, 'orderId' | 'orderLineId'>,
    prior: TokenPayload, options: { lock: boolean; mode: 'read' | 'write'; businessGates?: boolean; extraLineId?: string }) {
    if (!source.orderId) return fail('NOT_FOUND', '需求尚无可核实的准确来源订单。', 404);
    const ids = source.orderLineId ? [source.orderLineId] : (await tx.orderLine.findMany({ where: { orderId: source.orderId }, select: { id: true } })).map(row => row.id);
    if (options.extraLineId) ids.push(options.extraLineId);
    const result = await authorizeSupplierSources(tx, prior, ids, options);
    if (result.sources.some(row => row.orderId !== source.orderId)) return fail('INVALID_SOURCE', '请选择需求所属订单下的真实产品条目。');
    return result;
  }
  async function read(tx: SupplierContractTx, demandId: string, visible: string[] | null) {
    const d = await tx.procurementDemand.findUnique({ where: { id: demandId } });
    if (!d) return fail('NOT_FOUND', '采购需求不存在', 404);
    scope(d.orderId, visible);
    return d;
  }
  async function readForWrite(tx: SupplierContractTx, demandId: string, actorId: string, visible: string[] | null, prior?: TokenPayload | null, extraLineId?: string) {
    const actor = trusted(actorId, prior), before = await read(tx, demandId, visible);
    await planningSources(tx, before, actor, { mode: 'write', lock: true, extraLineId });
    const locked = await tx.$queryRaw<Array<{id: string}>>(Prisma.sql`SELECT "id" FROM "ProcurementDemand" WHERE "id" = ${demandId} FOR UPDATE`);
    if (!locked.length) return fail('NOT_FOUND', '采购需求不存在或已变化。', 404);
    const current = await read(tx, demandId, visible);
    if (before.orderId !== current.orderId || before.orderLineId !== current.orderLineId) return fail('SCOPE_CHANGED', '需求来源已变化，请刷新后重新核对。', 409);
    await planningSources(tx, current, actor, { mode: 'write', lock: false, extraLineId });
    return current;
  }
  function owned(d: ProcurementDemand, actorId: string, revision: unknown) {
    if (d.assigneeId !== actorId) fail('NOT_ASSIGNEE', '请由已领办人处理该需求', 403);
    if (d.revision !== revision) fail('REVISION_CONFLICT', '需求版本已变化，请刷新', 409);
  }
  async function line(tx: SupplierContractTx, orderId: string, orderLineId: string) {
    const l = await tx.orderLine.findUnique({ where: { id: orderLineId } });
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, status: true } });
    if (!order || order.status === 'Cancelled' || !l || l.orderId !== orderId) fail('INVALID_SOURCE', '请选择该订单下的真实产品明细');
    return l;
  }
  async function dto(tx: SupplierContractTx, d: ProcurementDemand) {
    const allocations = await tx.purchaseDemandAllocation.findMany({ where: { demandId: d.id }, orderBy: { createdAt: 'asc' } });
    const purchaseIds = [...new Set(allocations.flatMap(row => row.purchaseOrderId ? [row.purchaseOrderId] : []))], processingIds = [...new Set(allocations.flatMap(row => row.outsourcingOrderId ? [row.outsourcingOrderId] : []))];
    const pos = purchaseIds.length ? await tx.purchaseOrder.findMany({ where: { id: { in: purchaseIds } }, select: { id: true, poNumber: true, supplierName: true, businessOwnerId: true } }) : [];
    const processors = processingIds.length ? await tx.outsourcingOrder.findMany({ where: { id: { in: processingIds } }, select: { id: true, orderNumber: true, supplierId: true, businessOwnerId: true } }) : [];
    const parties = processors.length ? await tx.relation.findMany({ where: { id: { in: [...new Set(processors.flatMap(row => row.supplierId ? [row.supplierId] : []))] } }, select: { id: true, name: true } }) : [];
    const allocated = allocations.filter(row => row.status === 'Active').reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
    return { ...d, createdAt: Number(d.createdAt), updatedAt: Number(d.updatedAt), confirmedAt: d.confirmedAt ? Number(d.confirmedAt) : null,
      perOutputQuantity: d.perOutputQuantity?.toString() ?? null, plannedOutputQuantity: d.plannedOutputQuantity?.toString() ?? null,
      requiredQuantity: d.requiredQuantity?.toString() ?? null, allocatedQuantity: allocated.toString(), remainingQuantity: d.requiredQuantity == null ? null : new Prisma.Decimal(d.requiredQuantity).minus(allocated).toString(),
      allocations: allocations.map(row => { const purchase = pos.find(item => item.id === row.purchaseOrderId), processing = processors.find(item => item.id === row.outsourcingOrderId);
        return { id: row.id, quantity: row.quantity.toString(), purchaseOrderId: row.purchaseOrderId, purchaseLineId: row.purchaseLineId,
          outsourcingOrderId: row.outsourcingOrderId, outsourcingLineId: row.outsourcingLineId, status: row.status, contractKind: row.outsourcingOrderId ? 'processing' : 'purchase',
          contractNumber: processing?.orderNumber ?? purchase?.poNumber ?? null, poNumber: purchase?.poNumber ?? null,
          nativeContract: !!(purchase?.businessOwnerId || processing?.businessOwnerId), supplierName: purchase?.supplierName ?? parties.find(party => party.id === processing?.supplierId)?.name ?? null }; }) };
  }
  async function list(visible: string[] | null, actorId: string, opts: { orderId?: string; mine?: boolean; offset?: number; limit?: number } = {}, prior?: TokenPayload | null) {
    return transaction(async tx => {
      if (opts.orderId) scope(opts.orderId, visible);
      const original = trusted(actorId, prior), actor = await freshSupplierActor(tx, original, 'read'), freshScope = await freshOrderLineScope(tx, actor);
      const orders = await tx.order.findMany({ where: { deletedAt: null, AND: [freshScope as Prisma.OrderWhereInput, ...(visible === null ? [] : [{ id: { in: visible } }])] }, select: { id: true } });
      const ids = orders.map(row => row.id);
      if (opts.orderId && !ids.includes(opts.orderId)) return fail('NOT_FOUND', '采购需求不存在或无权访问。', 404);
      const where: Prisma.ProcurementDemandWhereInput = { status: { not: 'Superseded' }, orderId: opts.orderId ?? { in: ids }, ...(opts.mine ? { assigneeId: actor.userId } : {}) };
      const offset = Number.isInteger(opts.offset) && opts.offset! >= 0 ? opts.offset! : 0;
      const limit = Number.isInteger(opts.limit) && opts.limit! > 0 ? Math.min(opts.limit!, 100) : 50;
      const rows = await tx.procurementDemand.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: offset, take: limit });
      const total = await tx.procurementDemand.count({ where }), items = [];
      for (const row of rows) { await planningSources(tx, row, original, { mode: 'read', lock: false, businessGates: false }); items.push(await dto(tx, row)); }
      return { items, total, hasMore: total > offset + rows.length, offset, limit };
    });
  }
  async function create(input: any, actorId: string, visible: string[] | null, prior?: TokenPayload | null) {
    scope(input.orderId, visible);
    if (!input.orderId || !input.orderLineId || typeof input.description !== 'string' || !input.description.trim() || typeof input.unit !== 'string' || !input.unit.trim()) fail('INVALID_INPUT', '订单、产品明细、需求描述与单位必填');
    if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 150) fail('INVALID_REQUEST_KEY', '缺少有效的请求标识');
    const sourceKey = `manual:${actorId}:${input.requestKey}`;
    const kind = input.kind ?? 'Material';
    if (!['Material','FinishedGoods','ProcessingService'].includes(kind)) fail('INVALID_INPUT','采购类型无效');
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind, orderId: input.orderId, orderLineId: input.orderLineId, description: input.description.trim(), unit: input.unit.trim() })).digest('hex');
    return transaction(async tx => {
      const actor = trusted(actorId, prior), source = { orderId: input.orderId, orderLineId: input.orderLineId };
      await planningSources(tx, source, actor, { mode: 'write', lock: true, businessGates: false });
      const previous = await tx.procurementDemand.findUnique({ where: { sourceKey } });
      if (previous) {
        if (previous.creationFingerprint !== fingerprint) fail('REQUEST_KEY_REUSED', '请求标识已用于其他需求', 409);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProcurementDemand" WHERE "id" = ${previous.id} FOR UPDATE`);
        await planningSources(tx, previous, actor, { mode: 'write', lock: false, businessGates: false });
        return { demand: await dto(tx, previous) };
      }
      await planningSources(tx, source, actor, { mode: 'write', lock: false });
      await line(tx, input.orderId, input.orderLineId);
      const now = Date.now();
      const d = await tx.procurementDemand.create({ data: { id: id('PD'), kind, sourceKey, creationFingerprint: fingerprint, orderId: input.orderId, orderLineId: input.orderLineId, description: input.description.trim(), unit: input.unit.trim(), status: 'NeedsConfirmation', revision: 1, quantityBasis: 'ExplicitTotal', createdAt: now, updatedAt: now } });
      await audit(tx, actorId, d.id, 'create_procurement_demand', { orderLineId: input.orderLineId });
      return { demand: await dto(tx, d) };
    });
  }
  async function claim(demandId: string, revision: unknown, actorId: string, visible: string[] | null, prior?: TokenPayload | null) {
    return transaction(async tx => {
      const d = await readForWrite(tx, demandId, actorId, visible, prior);
      if (d.status === 'Superseded') fail('SUPERSEDED', '请处理已确认新版BOM的采购需求', 409);
      if (d.assigneeId && d.assigneeId !== actorId) fail('ALREADY_CLAIMED', '需求已由其他经办人领办', 409);
      if (d.revision !== revision) fail('REVISION_CONFLICT', '需求版本已变化，请刷新', 409);
      if (d.assigneeId === actorId) return { demand: await dto(tx, d) };
      const updated = await tx.procurementDemand.update({ where: { id: demandId }, data: { assigneeId: actorId, revision: { increment: 1 }, updatedAt: Date.now() } });
      await audit(tx, actorId, demandId, 'claim_procurement_demand', {});
      return { demand: await dto(tx, updated) };
    });
  }
  async function release(demandId: string, input: any, actorId: string, visible: string[] | null, prior?: TokenPayload | null) {
    const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 1000) fail('INVALID_REASON', '退回理由必填，且不能超过1000字');
    return transaction(async tx => {
      const d = await readForWrite(tx, demandId, actorId, visible, prior);
      owned(d, actorId, input.revision);
      if (!['NeedsConfirmation', 'Ready'].includes(d.status)) fail('INVALID_STATE', '当前状态不能退回待认领', 409);
      const previousAssigneeId = d.assigneeId;
      const updated = await tx.procurementDemand.update({ where: { id: demandId }, data: { assigneeId: null, revision: { increment: 1 }, updatedAt: Date.now() } });
      await audit(tx, actorId, demandId, 'release_procurement_demand', { beforeAssigneeId: previousAssigneeId, afterAssigneeId: null, reason });
      return { demand: await dto(tx, updated) };
    });
  }
  async function confirm(demandId: string, input: any, actorId: string, visible: string[] | null, prior?: TokenPayload | null) {
    const quantity = demandDecimal(input.requiredQuantity, '总需求量');
    return transaction(async tx => {
      const d = await readForWrite(tx, demandId, actorId, visible, prior, typeof input.orderLineId === 'string' ? input.orderLineId : undefined); owned(d, actorId, input.revision);
      await validBOM(tx, d);
      if (/占位|待补充/.test(d.description)) fail('PLACEHOLDER', '请先修订BOM补齐真实物料并确认新版，再处理新版本采购需求');
      if (!d.orderId) return fail('MISSING_ORDER', 'BOM 尚未关联订单，不能确认采购需求');
      await line(tx, d.orderId, input.orderLineId);
      if (await tx.purchaseDemandAllocation.count({ where: { demandId, status: 'Active' } })) fail('ALREADY_ALLOCATED', '已有准确合同计划分配，请先按合同变更流程核对占用，再重新确认需求。', 409);
      const updated = await tx.procurementDemand.update({ where: { id: demandId }, data: { orderLineId: input.orderLineId, requiredQuantity: quantity, quantityBasis: 'ExplicitTotal', status: 'Ready', confirmedBy: actorId, confirmedAt: Date.now(), revision: { increment: 1 }, updatedAt: Date.now() } });
      await audit(tx, actorId, demandId, 'confirm_procurement_demand', { quantity: quantity.toString(), orderLineId: input.orderLineId });
      return { demand: await dto(tx, updated) };
    });
  }
  async function allocate(_demandId: string, _input: unknown, _actorId: string, _visible: string[] | null, _prior?: TokenPayload | null): Promise<{ demand: Awaited<ReturnType<typeof dto>>; purchaseOrder: { id: string; poNumber: string } }> {
    return fail('NATIVE_SUPPLIER_CONTRACT_REQUIRED', '旧采购分配入口已关闭，请从已确认的准确需求进入采购或加工合同草稿。', 409);
  }
  return { list, create, claim, release, confirm, allocate };
}
async function audit(tx: any, actorId: string, targetId: string, action: string, detail: object) {
  await tx.auditLog.create({ data: { id: id('alog'), actorId, targetType: 'ProcurementDemand', targetId, action, detail, operationType: 'update' } });
}

/** Unit-cost BOM lines become unresolved needs, never executable total quantities. */
export async function createDemandsFromBOM(prisma: PrismaClient, bomId: string) {
  return prisma.$transaction(async (tx: any) => {
    const bom = await tx.bOM.findUnique({ where: { id: bomId }, include: { lines: true } });
    if (!bom || bom.deletedAt || bom.status !== 'Confirmed') fail('INVALID_BOM', 'BOM不存在或尚未确认');
    const now = Date.now();
    if (bom.parentBomId) {
      const old = await tx.procurementDemand.findMany({ where: { bomId: bom.parentBomId, allocations: { none: { status: 'Active' } } } });
      for (const demand of old) await tx.procurementDemand.update({ where: { id: demand.id }, data: { status: 'Superseded', revision: { increment: 1 }, updatedAt: now } });
    }
    const demands = [];
    for (const l of bom.lines) {
      demands.push(await tx.procurementDemand.upsert({ where: { sourceKey: `bom:${bom.id}:${bom.version}:${l.id}` }, update: {}, create: { id: id('PD'), sourceKey: `bom:${bom.id}:${bom.version}:${l.id}`, bomId: bom.id, bomLineId: l.id, bomVersion: bom.version, orderId: bom.orderId, description: l.description, unit: l.unit, perOutputQuantity: l.effectiveQty, quantityBasis: 'PerOutput', status: 'NeedsConfirmation', createdAt: now, updatedAt: now } }));
    }
    return { demandIds: demands.map(d => d.id), lineCount: demands.length };
  });
}

async function validBOM(tx: any, d: any) {
  if (!d.bomId) return;
  const bom = await tx.bOM.findUnique({ where: { id: d.bomId } });
  if (!bom || bom.deletedAt || bom.status !== 'Confirmed' || bom.version !== d.bomVersion) fail('STALE_BOM', '来源BOM已归档或变更，请使用已确认新版需求；已采购部分另行处理变更', 409);
  await rejectUntrackedPurchases(tx, bom.id);
  const visited = new Set<string>([bom.id]);
  let parentId = bom.parentBomId;
  while (parentId) {
    if (visited.has(parentId)) fail('INVALID_BOM_CHAIN', 'BOM版本关系异常，不能确认采购需求', 409);
    visited.add(parentId);
    await rejectUntrackedPurchases(tx, parentId);
    const active = await tx.purchaseDemandAllocation.count({ where: { status: 'Active', demand: { bomId: parentId } } });
    if (active > 0) fail('PRIOR_VERSION_ALLOCATED', '旧版BOM已有采购分配，须先完成旧采购变更处理；不得重复采购新版总需求', 409);
    const parent = await tx.bOM.findUnique({ where: { id: parentId } });
    if (!parent) fail('INVALID_BOM_CHAIN', '旧版BOM记录缺失，不能确认采购需求', 409);
    parentId = parent.parentBomId;
  }
}

async function rejectUntrackedPurchases(tx: any, bomId: string) {
  const pos = await tx.purchaseOrder.findMany({ where: { bomId, deletedAt: null, status: { not: 'Cancelled' } }, select: { id: true } });
  if (!pos.length) return;
  const tracked = await tx.purchaseDemandAllocation.findMany({ where: { purchaseOrderId: { in: pos.map((p: any) => p.id) } }, select: { purchaseOrderId: true } });
  const ids = new Set(tracked.map((a: any) => a.purchaseOrderId));
  if (pos.some((p: any) => !ids.has(p.id))) fail('LEGACY_PURCHASE_REVIEW', '此BOM或旧版已有未登记需求分配的采购单，请先核对原采购；不能按新版需求重复采购', 409);
}
