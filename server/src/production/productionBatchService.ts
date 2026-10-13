import { currentOrderMoqReasons } from '../orderChanges/quantityPlanMoqGate';
import { resolveGarmentMaterialProof } from '../orders/internalFabricGate';
import { productionBatchLineFingerprint, productionBatchSourceFingerprint, physicalRange, resolveCurrentProductionBatchFacts } from './productionBatchFacts';
export { productionBatchLineFingerprint, productionBatchSourceFingerprint, resolveCurrentProductionBatchFacts } from './productionBatchFacts';
import { exactJsonValue } from '../lib/exactJsonValue';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { currentOrderLineWriteActor, freshOrderLineScope, lockedOrderLine, isOrderLineStorageConflict, assertOrderMainApprovalNotPending } from '../orders/orderLineWriteAccess';
import { orderConfirmedSourceBinding } from '../orders/orderConfirmedSourceBinding';
import { lockOrderReleaseSources } from './releaseService';
import { assertConfirmedFabricSourceEligible } from '../development/fabricAssetEligibility';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { businessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { readOrderLineProductionCompletion } from './productionCompletionService';
import { factoryRelationIdentitySelect, isUsableFactoryRelation } from '../suppliers/factoryRelationIdentity';
import { normalizeGarmentSizeBreakdown } from '../orders/garmentSizeBreakdown';
import { assertGarmentSizeAllocationAvailable, assertGarmentSizeSplit, type GarmentSizeMap } from './garmentSizeAllocation';
import { readProductionQcIssueProjection } from '../qc/productionQcIssueService';
import { createTeamShareService } from '../teams/teamShareService';
import { parseProductionLineChoice, freezeProductionLineIdentity, readBatchProductionLineIdentity, type ProductionLineChoice } from './productionLineIdentity';

/** Neutral physical coordinates; no production/receipt/stock/QC/PP fact is
 * created. Current authority and all range mutations share the business tx. */
const actions = ['create_production_batch', 'split_production_batch', 'bind_production_line'];
type JsonRecord = Record<string, any>;
type CreateCommand = { batchCode: string; quantity: string; unit: string; expectedLineFingerprint: string; requestKey: string; factoryRelationId?: string; sizeBreakdown?: GarmentSizeMap; productionLineChoice?: ProductionLineChoice };
type SplitCommand = { expectedRevision: number; expectedLineFingerprint: string; requestKey: string; children: Array<{ batchCode: string; quantity: string; sizeBreakdown?: GarmentSizeMap }> };
type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = (value: any): any => JSON.parse(JSON.stringify(exactJsonValue(value)));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const conflict = (message: string): never => { throw businessError('CONFLICT', message); };
const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };

function record(value: unknown, allowed: readonly string[]): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('请提交完整的批次命令。');
  const object = value as JsonRecord;
  if (Object.keys(object).some(key => !allowed.includes(key))) return invalid('批次命令包含不可提交的字段。');
  return object;
}
function text(value: unknown, label: string, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) return invalid(`${label}不能为空或超过允许长度。`);
  return value.trim();
}
/** Decimal(18,4), canonical positive input. Never Number, exponent or rounding. */
function quantity(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value)) return invalid('数量须为正的十进制字符串，最多四位小数。');
  const decimal = new Prisma.Decimal(value);
  if (!decimal.gt(0)) return invalid('批次数量必须大于零。');
  return decimal.toString();
}
function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid('请读取当前订单行的范围依据指纹后再提交。');
  return value;
}
function createCommand(value: unknown): CreateCommand {
  const body = record(value, ['batchCode', 'quantity', 'unit', 'expectedLineFingerprint', 'requestKey', 'factoryRelationId', 'sizeBreakdown', 'productionLineChoice']);
  const productionLineChoice = parseProductionLineChoice(body.productionLineChoice);
  const batchQuantity = quantity(body.quantity);
  let sizeBreakdown: GarmentSizeMap | undefined;
  if (body.sizeBreakdown !== undefined) {
    try { sizeBreakdown = normalizeGarmentSizeBreakdown(body.sizeBreakdown, batchQuantity) ?? undefined; }
    catch (error) { return invalid(error instanceof Error ? error.message : '工厂尺码数量无效。'); }
    if (!sizeBreakdown) return invalid('工厂尺码数量不能为空。');
  }
  return { batchCode: text(body.batchCode, '批号'), quantity: batchQuantity, unit: text(body.unit, '单位', 24),
    expectedLineFingerprint: fingerprint(body.expectedLineFingerprint), requestKey: text(body.requestKey, '请求键'),
    ...(body.factoryRelationId == null ? {} : { factoryRelationId: text(body.factoryRelationId, '生产工厂', 160) }), ...(sizeBreakdown ? { sizeBreakdown } : {}), ...(productionLineChoice ? { productionLineChoice } : {}) };
}
function splitCommand(value: unknown): SplitCommand {
  const body = record(value, ['expectedRevision', 'expectedLineFingerprint', 'requestKey', 'children']);
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) return invalid('拆批需提交实际批次修订。');
  if (!Array.isArray(body.children) || body.children.length < 2 || body.children.length > 100) return invalid('拆批需提交至少两个子批次。');
  const children = body.children.map((value: unknown) => { const child = record(value, ['batchCode', 'quantity', 'sizeBreakdown']);
    const childQuantity = quantity(child.quantity); let sizeBreakdown: GarmentSizeMap | undefined;
    if (child.sizeBreakdown !== undefined) {
      try { sizeBreakdown = normalizeGarmentSizeBreakdown(child.sizeBreakdown, childQuantity) ?? undefined; }
      catch (error) { return invalid(error instanceof Error ? error.message : '子批尺码数量无效。'); }
      if (!sizeBreakdown) return invalid('子批尺码数量不能为空。');
    }
    return { batchCode: text(child.batchCode, '子批号'), quantity: childQuantity, ...(sizeBreakdown ? { sizeBreakdown } : {}) }; });
  if (new Set(children.map(child => child.batchCode)).size !== children.length) return invalid('同次拆批的子批号不能重复。');
  return { expectedRevision: body.expectedRevision, expectedLineFingerprint: fingerprint(body.expectedLineFingerprint), requestKey: text(body.requestKey, '请求键'), children };
}
function contractSizeMap(line: any): GarmentSizeMap | null {
  try { return normalizeGarmentSizeBreakdown(line.sizeBreakdown, line.quantity instanceof Prisma.Decimal ? line.quantity.toString() : line.quantity); }
  catch (error) { return conflict(error instanceof Error ? `订单行尺码矩阵无效：${error.message}` : '订单行尺码矩阵无效，暂不能分配生产。'); }
}
async function scopedOrder(tx: any, orderId: string, actor: TokenPayload) {
  const scope = await freshOrderLineScope(tx, actor);
  let order;
  try { order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null, AND: [scope] } }); }
  catch { throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验订单范围，请稍后重试。'); }
  if (!order) throw businessError('ORDER_NOT_FOUND', '订单不存在或不可查看。');
  return order;
}
async function assertUsableProductionFactory(tx: any, factoryRelationId: string) {
  const [relation, profile] = await Promise.all([
    tx.relation.findUnique({ where: { id: factoryRelationId }, select: factoryRelationIdentitySelect }),
    tx.factoryProfile.findUnique({ where: { relationId: factoryRelationId }, select: { relationId: true, deletedAt: true, blacklistedAt: true } }),
  ]);
  if (!isUsableFactoryRelation(relation) || !profile || profile.deletedAt != null || profile.blacklistedAt != null)
    return conflict('生产工厂必须是有效的供应商组织及有效工厂档案；不能选择客户、普通供应商、已停用或已拉黑工厂。');
  return relation;
}
async function authorizeFactoryLineAccess(tx: any, actor: TokenPayload, factoryRelationId: string, write: boolean) {
  await assertUsableProductionFactory(tx, factoryRelationId);
  const access = await createTeamShareService(tx).resolveRelationAccess(actor, factoryRelationId, { fresh: true });
  if (access === 'none' || write && !['owner', 'team-followup'].includes(access)) throw businessError('FORBIDDEN', '当前账号没有本工厂业务的经办范围；公司档案可读不能代替生产线经办授权。');
}
function assertProductionOrganizationPartition(rows: any[], factoryRelationId: string, choice: ProductionLineChoice, excludedId?: string) {
  for (const row of rows) {
    if (row.id === excludedId || row.factoryRelationId !== factoryRelationId) continue;
    const mode = row.productionLineSnapshot?.mode;
    if (mode && mode !== choice.mode) return conflict('同一条目同一工厂不能混用单线整体声明与命名生产线；请据实安排并重新核对原分支。');
  }
}
async function currentReadActor(tx: any, prior: TokenPayload | null | undefined) {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '批次查询需要有效的用户主体。');
  let actor: TokenPayload, user: any;
  try {
    user = await loadUserWithRoles(tx, prior.userId);
    if (user) actor = await buildLoadedAuthTokenPayload(tx, user);
  } catch {
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验读取权限，请稍后重试。');
  }
  if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
  if (prior.permissionCeiling !== undefined) actor!.permissionCeiling = [...prior.permissionCeiling];
  if (!hasScope({ ...actor!, roles: [] }, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有订单读取权限。');
  return actor!;
}
async function lockedWrite(tx: any, orderId: string, lineId: string, prior: TokenPayload) {
  // Preflight avoids locking another customer's parent merely by guessing an
  // ID. It is never the final authority: repeat AFTER every business lock.
  const preActor = await currentOrderLineWriteActor(tx, prior, 'update');
  await scopedOrder(tx, orderId, preActor);
  const locks = await lockOrderReleaseSources(tx, orderId);
  const line = await lockedOrderLine(tx, lineId, orderId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ProductionBatch" WHERE "orderLineId"=${lineId} ORDER BY "id" FOR UPDATE`);
  const actor = await currentOrderLineWriteActor(tx, prior, 'update');
  const order = await scopedOrder(tx, orderId, actor);
  const currentLine = await tx.orderLine.findUnique({ where: { id: line.id } });
  if (!currentLine || currentLine.orderId !== order.id) return conflict('订单行归属已变化，请刷新后重新核对。');
  await assertOrderMainApprovalNotPending(tx, order.id);
  return { actor, order, line: currentLine, failedSources: locks.failedSources };
}
async function creationBasis(tx: any, order: any, line: any, actor: TokenPayload, failedSources: Array<{ type: string | null; id: string | null }> = [], requestedFactoryRelationId?: string) {
  if (failedSources.some(source => source.type === line.confirmedSourceType && source.id === line.confirmedSourceId))
    throw businessError('DEVELOPMENT_SOURCE_CHANGED', '当前确认成果的来源已不可用，请核对原成果。');
  if (!line.confirmedSourceType || !line.confirmedSourceId || line.specSnapshot == null) return conflict('请先补录本行真实确认成果及规格。');
  if (!line.unit || !String(line.unit).trim()) return conflict('订单行单位未知，请先核对本行单位。');
  const currentSource = await assertConfirmedFabricSourceEligible(tx, { type: line.confirmedSourceType, id: line.confirmedSourceId });
  await orderConfirmedSourceBinding(tx, order, line, { confirmedSourceType: line.confirmedSourceType, confirmedSourceId: line.confirmedSourceId }, actor);
  const businessLine = String(order.businessLine ?? order.type ?? '').trim().toLowerCase();
  const isGarment = businessLine === 'garment';
  // A garment confirmed sample identifies the design/version, not the final
  // production factory. Garment order rows may be ranged across factories.
  // Fabric remains single-mill, single-branch and follows its confirmed source.
  if (!isGarment && order.millRelationId && currentSource.factoryRelationId && order.millRelationId !== currentSource.factoryRelationId) return conflict('订单工厂与确认成果的真实工厂不一致。');
  const factoryRelationId = isGarment
    ? requestedFactoryRelationId ?? order.millRelationId ?? currentSource.factoryRelationId
    : currentSource.factoryRelationId ?? order.millRelationId;
  if (requestedFactoryRelationId && !isGarment && requestedFactoryRelationId !== factoryRelationId)
    return conflict('面料生产工厂必须沿用该订单行唯一确认的工厂。');
  if (!factoryRelationId) return conflict('批次工厂尚未关联真实有效关系，请先核对订单与成果工厂。');
  await assertUsableProductionFactory(tx, factoryRelationId);
  return { factoryRelationId, sourceFingerprint: productionBatchSourceFingerprint(order, line, factoryRelationId) };
}
/** Consumption adds the existing real source eligibility; it grants no PP or
 * shipment approval. QC should use the neutral resolver above to record facts. */
export async function assertCurrentProductionBatch(tx: any, batch: any, options: { neutral?: boolean } = {}) {
  const facts = await resolveCurrentProductionBatchFacts(tx, batch);
  if (!options.neutral) await resolveGarmentMaterialProof(tx, facts.order, facts.line);
  await assertUsableProductionFactory(tx, facts.batch.factoryRelationId);
  const source = await assertConfirmedFabricSourceEligible(tx, { type: facts.line.confirmedSourceType, id: facts.line.confirmedSourceId });
  if (String(facts.order.businessLine ?? facts.order.type ?? '').trim().toLowerCase() !== 'garment'
    && source.factoryRelationId && source.factoryRelationId !== facts.batch.factoryRelationId) return conflict('当前成果工厂与批次冻结工厂不一致。');
  return facts;
}
function firstGap(rows: any[], size: Prisma.Decimal, line: any) {
  const sorted = [...rows].sort((a, b) => new Prisma.Decimal(a.rangeStart).comparedTo(new Prisma.Decimal(b.rangeStart)));
  let end = new Prisma.Decimal(0), available: Prisma.Decimal | undefined;
  for (const row of sorted) {
    physicalRange(row, line);
    if (row.unit !== line.unit) return conflict('当前有效批次的单位与订单行不一致。');
    const start = new Prisma.Decimal(row.rangeStart), qty = new Prisma.Decimal(row.quantity);
    if (start.lt(end)) return conflict('当前有效批次范围重叠，请先核对原批次。');
    if (available === undefined && start.minus(end).gte(size)) available = end;
    end = start.plus(qty);
  }
  if (available !== undefined) return available;
  if (new Prisma.Decimal(line.quantity).minus(end).lt(size)) return conflict('当前有效批次范围将超过本行数量。');
  return end;
}
async function originalRequestAudits(tx: any, lineId: string, actorId: string, requestKey: string) {
  return tx.auditLog.findMany({ where: { actorId, action: { in: actions }, targetType: 'ProductionBatch',
    AND: [{ detail: { path: ['after', 'orderLineId'], equals: lineId } }, { detail: { path: ['after', 'requestKey'], equals: requestKey } }] } });
}
async function originalReceipt(tx: any, lineId: string, actorId: string, requestKey: string, parameterHash: string, operation: string, audited?: any[]) {
  const matches = audited ?? await originalRequestAudits(tx, lineId, actorId, requestKey);
  if (!matches.length) return null;
  if (matches.length !== 1) return conflict('原请求回执不唯一，请核对原请求。');
  const original = matches[0], after = original.detail?.after;
  if (original.action !== operation || after?.parameterHash !== parameterHash || !after.receipt || hash(after.command) !== hash(after.receipt.command)) return conflict('请求键已用于不同参数或原回执不完整，请保留原请求。');
  return after.receipt.result;
}
async function auditReceipt(tx: any, actorId: string, action: string, targetId: string, lineId: string, command: any, parameterHash: string, result: any, before?: any) {
  await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:production:neutral-batch', operation: action, targetType: 'ProductionBatch', targetId,
    before: before == null ? undefined : json(before), after: { orderLineId: lineId, requestKey: command.requestKey, parameterHash, command,
      receipt: { command, result: json(result) } }, operationType: action === actions[0] ? 'create' : 'transition' });
}
async function outcome<T>(label: string, work: () => Promise<T>): Promise<Result<T>> {
  try { return { ok: true, data: await work() }; }
  catch (error) {
    logger.error('[ProductionBatch] ' + label, { error });
    const cause = isOrderLineStorageConflict(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      ? businessError('CONFLICT', '批次范围或原请求正在变化，请保留原键并重新核对。') : error;
    const safe = safeRouteError(cause, { fallbackCode: 'INTERNAL_ERROR' });
    return { ok: false, error: { code: safe.code, message: safe.message, status: safe.status } };
  }
}
export async function listProductionBatches(params: { prisma: PrismaClient; orderId: string; lineId: string; actor: TokenPayload | null }) {
  return outcome('查询失败', () => params.prisma.$transaction(async (tx: any) => {
    const actor = await currentReadActor(tx, params.actor), order = await scopedOrder(tx, params.orderId, actor);
    const line = await tx.orderLine.findUnique({ where: { id: params.lineId } });
    if (!line || line.orderId !== order.id) throw businessError('ORDER_LINE_NOT_FOUND', '订单行不存在或不可查看。');
    const rows = await tx.productionBatch.findMany({ where: { orderId: order.id, orderLineId: line.id }, orderBy: [{ rangeStart: 'asc' }, { createdAt: 'asc' }] });
    const productionCompletion = await readOrderLineProductionCompletion(tx, order, line);
    const batches: any[] = [];
    for (const batch of rows) batches.push({ ...json(batch), productionQcIssues: await readProductionQcIssueProjection(tx, {
      orderId: order.id, orderLineId: line.id, productionBatchId: batch.id, productionBatchRevision: batch.revision }) });
    return { lineFingerprint: productionBatchLineFingerprint(order, line), batches, productionCompletion: json(productionCompletion), productionLineApplicable: String(order.businessLine ?? order.type ?? '').trim().toLowerCase() === 'garment' };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
}
export async function listFactoryProductionLines(params: { prisma: PrismaClient; orderId: string; lineId: string; actor: TokenPayload | null; factoryRelationId: unknown }) {
  return outcome('读取实际生产线失败', () => params.prisma.$transaction(async (tx: any) => {
    const factoryRelationId = text(params.factoryRelationId, '实际工厂');
    const actor = await currentReadActor(tx, params.actor), order = await scopedOrder(tx, params.orderId, actor);
    const line = await tx.orderLine.findUnique({ where: { id: params.lineId } });
    if (!line || line.orderId !== order.id) throw businessError('ORDER_LINE_NOT_FOUND', '订单行不存在或不可查看。');
    await authorizeFactoryLineAccess(tx, actor, factoryRelationId, false);
    const rows = await tx.factoryProductionLine.findMany({ where: { factoryRelationId }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 1001 });
    if (rows.length > 1000) return conflict('实际生产线记录过多，请在工厂档案核查，不能截断后猜选。');
    return { orderId: order.id, orderLineId: line.id, factoryRelationId, lines: json(rows) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
}
export async function registerFactoryProductionLine(params: { prisma: PrismaClient; orderId: string; lineId: string; actor: TokenPayload | null; input: unknown }) {
  return outcome('登记实际生产线失败', async () => {
    const body = record(params.input, ['factoryRelationId', 'name', 'location', 'requestKey']);
    const command = { factoryRelationId: text(body.factoryRelationId, '实际工厂'), name: text(body.name, '实际线名'), location: body.location == null || body.location === '' ? null : text(body.location, '实际地点', 500), requestKey: text(body.requestKey, '请求键') };
    const parameterHash = hash({ operation: 'create_factory_production_line', orderId: params.orderId, lineId: params.lineId, command });
    return params.prisma.$transaction(async (tx: any) => {
      if (!params.actor?.userId) throw businessError('UNAUTHORIZED', '登记生产线需要真实登录账号。');
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`factory-line-request:${params.actor.userId}:${command.requestKey}`},0))::text`);
      const { actor, order, line } = await lockedWrite(tx, params.orderId, params.lineId, params.actor);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Relation" WHERE "id"=${command.factoryRelationId} FOR UPDATE`);
      await authorizeFactoryLineAccess(tx, actor, command.factoryRelationId, true);
      const prior = await tx.auditLog.findMany({ where: { actorId: actor.userId, action: 'create_factory_production_line', targetType: 'FactoryProductionLine',
        AND: [{ detail: { path: ['after', 'requestKey'], equals: command.requestKey } }] } });
      if (prior.length) {
        if (prior.length !== 1 || prior[0].detail?.after?.parameterHash !== parameterHash || !prior[0].detail.after.receipt) return conflict('原生产线请求参数不一致或回执不完整，请保留原请求。');
        return { ...prior[0].detail.after.receipt, replayed: true };
      }
      const now = BigInt(Date.now()), created = await tx.factoryProductionLine.create({ data: { id: `FPL_${randomUUID()}`, ...command, parameterHash, state: 'active', revision: 1, createdBy: actor.userId, createdAt: now, updatedAt: now } });
      const result = { orderId: order.id, orderLineId: line.id, factoryRelationId: command.factoryRelationId, line: json(created), replayed: false };
      await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'route:production:factory-line', operation: 'create_factory_production_line', targetType: 'FactoryProductionLine', targetId: created.id,
        after: { orderId: order.id, orderLineId: line.id, requestKey: command.requestKey, parameterHash, command, receipt: result }, operationType: 'create' });
      const finalActor = await currentOrderLineWriteActor(tx, params.actor, 'update'); await scopedOrder(tx, order.id, finalActor);
      await authorizeFactoryLineAccess(tx, finalActor, command.factoryRelationId, true);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
  });
}
export async function bindProductionBatchLine(params: { prisma: PrismaClient; batchId: string; actor: TokenPayload | null; input: unknown }) {
  return outcome('保存实际生产组织失败', async () => {
    const body = record(params.input, ['expectedRevision', 'expectedLineFingerprint', 'requestKey', 'productionLineChoice']);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) return invalid('须提交准确批次修订。');
    const choice = parseProductionLineChoice(body.productionLineChoice); if (!choice) return invalid('须明确本次实际生产组织。');
    const command = { expectedRevision: body.expectedRevision as number, expectedLineFingerprint: fingerprint(body.expectedLineFingerprint), requestKey: text(body.requestKey, '请求键'), productionLineChoice: choice };
    return params.prisma.$transaction(async (tx: any) => {
      if (!params.actor?.userId) throw businessError('UNAUTHORIZED', '保存生产组织需要真实登录账号。');
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`production-line-binding:${params.actor.userId}:${command.requestKey}`},0))::text`);
      const hint = await tx.productionBatch.findUnique({ where: { id: params.batchId } }); if (!hint) throw businessError('ORDER_LINE_NOT_FOUND', '实际分支不存在或不可查看。');
      const { actor, order, line } = await lockedWrite(tx, hint.orderId, hint.orderLineId, params.actor);
      await authorizeFactoryLineAccess(tx, actor, hint.factoryRelationId, true);
      const parameterHash = hash({ operation: actions[2], batchId: hint.id, orderId: order.id, lineId: line.id, command });
      const replay = await originalReceipt(tx, line.id, actor.userId, command.requestKey, parameterHash, actions[2]); if (replay) return { ...replay, replayed: true };
      const batch = await tx.productionBatch.findUnique({ where: { id: params.batchId } });
      if (!batch || batch.orderId !== order.id || batch.orderLineId !== line.id || batch.state !== 'active' || batch.revision !== command.expectedRevision) return conflict('批次状态或修订已变化，请读取当前分支。');
      if (String(order.businessLine ?? order.type ?? '').trim().toLowerCase() !== 'garment') return invalid('面料履约不使用成衣生产线声明。');
      if (productionBatchLineFingerprint(order, line) !== command.expectedLineFingerprint) return conflict('本行依据已变化，请重新读取。');
      await resolveCurrentProductionBatchFacts(tx, batch);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentProductionAllocation" WHERE "productionBatchId"=${batch.id} ORDER BY "id" FOR UPDATE`);
      if (await tx.productionBatchCompletion.findFirst({ where: { productionBatchId: batch.id } }) || await tx.productionStockReceipt.findFirst({ where: { productionBatchId: batch.id } })
        || await tx.shipmentProductionAllocation.findFirst({ where: { productionBatchId: batch.id, state: { in: ['reserved', 'shipped'] } } })) return conflict('本分支已有实际完工、库存或有效发运预留，不能改写实际生产组织。');
      if (choice.mode === 'named_line') await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "FactoryProductionLine" WHERE "id"=${choice.productionLineId} FOR UPDATE`);
      assertProductionOrganizationPartition(await tx.productionBatch.findMany({ where: { orderLineId: line.id, state: 'active' } }), batch.factoryRelationId, choice, batch.id);
      const identity = await freezeProductionLineIdentity(tx, batch.factoryRelationId, choice, actor.userId, new Date());
      const changed = await tx.productionBatch.updateMany({ where: { id: batch.id, state: 'active', revision: command.expectedRevision }, data: { productionLineId: identity.productionLineId, productionLineSnapshot: identity, revision: { increment: 1 }, updatedAt: BigInt(Date.now()) } });
      if (changed.count !== 1) return conflict('批次已变化，请核对原保存请求。');
      const result = { batch: json(await tx.productionBatch.findUnique({ where: { id: batch.id } })), replayed: false,
        productionLineReceipt: { protocolVersion: 1, requestKey: command.requestKey, actorId: actor.userId, orderId: order.id,
          orderLineId: line.id, batchId: batch.id, expectedRevision: command.expectedRevision, revision: command.expectedRevision + 1, parameterHash, command } };
      await auditReceipt(tx, actor.userId, actions[2], batch.id, line.id, command, parameterHash, result, batch);
      const finalActor = await currentOrderLineWriteActor(tx, params.actor, 'update'); await scopedOrder(tx, order.id, finalActor); await authorizeFactoryLineAccess(tx, finalActor, batch.factoryRelationId, true);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
  });
}
export async function createProductionBatch(params: { prisma: PrismaClient; orderId: string; lineId: string; actor: TokenPayload | null; input: unknown }) {
  return outcome('建立范围失败', async () => {
    const command = createCommand(params.input), parameterHash = hash({ operation: actions[0], orderId: params.orderId, lineId: params.lineId, command });
    return params.prisma.$transaction(async (tx: any) => {
      if (!params.actor?.userId) throw businessError('UNAUTHORIZED', '建立分支需要真实登录账号。');
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`production-batch-request:${params.actor.userId}:${command.requestKey}`},0))::text`);
      const { actor, order, line, failedSources } = await lockedWrite(tx, params.orderId, params.lineId, params.actor!);
      const replay = await originalReceipt(tx, line.id, actor.userId, command.requestKey, parameterHash, actions[0]);
      if (replay) { if (command.productionLineChoice) await authorizeFactoryLineAccess(tx, actor, replay.batch.factoryRelationId, false); return { ...replay, replayed: true }; }
      if (productionBatchLineFingerprint(order, line) !== command.expectedLineFingerprint) return conflict('订单行范围依据已变化，请读取当前行后建立新请求。');
      if (command.unit !== line.unit) return invalid('批次单位必须与当前订单行单位完全一致，不执行隐式换算。');
      const moqReasons=await currentOrderMoqReasons(tx,order.id);if(moqReasons.length)throw businessError('CONFLICT',moqReasons.join('；'));
      const basis = await creationBasis(tx, order, line, actor, failedSources, command.factoryRelationId);
      const existing = await tx.productionBatch.findMany({ where: { orderLineId: line.id, state: 'active' } });
      const isGarment = String(order.businessLine ?? order.type ?? '').trim().toLowerCase() === 'garment';
      if (!isGarment && command.productionLineChoice) return invalid('面料履约不使用成衣生产线声明。');
      if (isGarment && !command.productionLineChoice) return invalid('请明确本工厂实际按单线整体履约，或选择真实生产线；系统不会替新分支推断生产组织。');
      let productionLineSnapshot;
      if (command.productionLineChoice) {
        await authorizeFactoryLineAccess(tx, actor, basis.factoryRelationId, true);
        if (command.productionLineChoice.mode === 'named_line') await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "FactoryProductionLine" WHERE "id"=${command.productionLineChoice.productionLineId} FOR UPDATE`);
        assertProductionOrganizationPartition(existing, basis.factoryRelationId, command.productionLineChoice);
        productionLineSnapshot = await freezeProductionLineIdentity(tx, basis.factoryRelationId, command.productionLineChoice, actor.userId, new Date());
      }
      const contractSizes = isGarment ? contractSizeMap(line) : null;
      let sizeBreakdown: GarmentSizeMap | null = null;
      if (contractSizes) {
        try { sizeBreakdown = assertGarmentSizeAllocationAvailable(contractSizes, existing, command.sizeBreakdown as GarmentSizeMap, command.quantity); }
        catch (error) { return conflict(error instanceof Error ? error.message : '工厂尺码分配与订单行不一致。'); }
      } else if (command.sizeBreakdown) return invalid('当前订单行没有成衣尺码矩阵，不能提交工厂尺码分配。');
      if (String(order.businessLine ?? order.type ?? '').trim().toLowerCase() === 'fabric'
        && (existing.length > 0 || !new Prisma.Decimal(command.quantity).eq(line.quantity)))
        return conflict('面料订单行只允许一个工厂、一条覆盖完整订单数量的生产分支；生产分批不能用出运批次代替。');
      const now = BigInt(Date.now()), created = await tx.productionBatch.create({ data: { id: `PB_${randomUUID()}`, batchCode: command.batchCode,
        orderId: order.id, orderLineId: line.id, parentBatchId: null, factoryRelationId: basis.factoryRelationId,
        ...(productionLineSnapshot ? { productionLineId: productionLineSnapshot.productionLineId, productionLineSnapshot } : {}),
        rangeStart: firstGap(existing, new Prisma.Decimal(command.quantity), line), quantity: command.quantity, sizeBreakdown, unit: line.unit, revision: 1, state: 'active',
        confirmedSourceType: line.confirmedSourceType, confirmedSourceId: line.confirmedSourceId, specSnapshot: line.specSnapshot,
        sourceFingerprint: basis.sourceFingerprint, requestKey: command.requestKey, parameterHash, commandSnapshot: command,
        createdBy: actor.userId, createdAt: now, updatedAt: now } });
      const result = { batch: json(created), replayed: false };
      await auditReceipt(tx, actor.userId, actions[0], created.id, line.id, command, parameterHash, result);
      if (command.productionLineChoice) await authorizeFactoryLineAccess(tx, await currentOrderLineWriteActor(tx, params.actor, 'update'), basis.factoryRelationId, true);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
  });
}
export async function splitProductionBatch(params: { prisma: PrismaClient; batchId: string; actor: TokenPayload | null; input: unknown }) {
  return outcome('拆分范围失败', async () => {
    // Establish only the key before the locked authority check. A previously
    // applied key is an immutable command, even when replacement children are
    // malformed. New keys still receive the same full INVALID_INPUT contract.
    if (!params.input || typeof params.input !== 'object' || Array.isArray(params.input)) return invalid('请提交完整的批次命令。');
    const requestKey = text((params.input as JsonRecord).requestKey, '请求键');
    return params.prisma.$transaction(async (tx: any) => {
      if (!params.actor?.userId) throw businessError('UNAUTHORIZED', '拆批需要有效的用户主体。');
      const hint = await tx.productionBatch.findUnique({ where: { id: params.batchId } });
      if (!hint) throw businessError('ORDER_LINE_NOT_FOUND', '实际生产批次不存在或不可查看。');
      const { actor, order, line, failedSources } = await lockedWrite(tx, hint.orderId, hint.orderLineId, params.actor);
      const audited = await originalRequestAudits(tx, line.id, actor.userId, requestKey);
      let command: SplitCommand;
      try { command = splitCommand(params.input); }
      catch (error) {
        if (audited.length) return conflict('请求键已用于不同参数或原回执不完整，请保留原请求。');
        throw error;
      }
      const parameterHash = hash({ operation: actions[1], batchId: params.batchId, orderId: order.id, lineId: line.id, command });
      const replay = await originalReceipt(tx, line.id, actor.userId, command.requestKey, parameterHash, actions[1], audited);
      if (replay) return { ...replay, replayed: true };
      const parent = await tx.productionBatch.findUnique({ where: { id: params.batchId } });
      if (!parent || parent.orderId !== order.id || parent.orderLineId !== line.id || parent.state !== 'active' || parent.revision !== command.expectedRevision) return conflict('批次状态或修订已变化，请读取当前批次。');
      if (String(order.businessLine ?? order.type ?? '').trim().toLowerCase() === 'fabric')
        return conflict('面料订单行只允许一个完整生产工厂分支；需要分批出运时在出运分配中登记，不拆生产分支。');
      if (await tx.productionBatchCompletion.findFirst({ where: { productionBatchId: parent.id } }))
        return conflict('该生产分支已有不可变的最终完工事实，不能再拆分或改写生产范围。');
      if (productionBatchLineFingerprint(order, line) !== command.expectedLineFingerprint) return conflict('订单行范围依据已变化，请读取当前行后拆批。');
      await assertCurrentProductionBatch(tx, parent, { neutral: true });
      await creationBasis(tx, order, line, actor, failedSources, parent.factoryRelationId);
      // Every allocator must lock the same parent Batch before reserving. The
      // allocation rows are also locked here; history is never rewritten.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ShipmentProductionAllocation" WHERE "productionBatchId"=${parent.id} ORDER BY "id" FOR UPDATE`);
      if (await tx.shipmentProductionAllocation.findFirst({ where: { productionBatchId: parent.id, state: { in: ['reserved', 'shipped'] } } })) return conflict('本批次已有有效预留或发运范围，不能拆批。');
      if (await tx.productionStockReceipt.findFirst({ where: { productionBatchId: parent.id } })) return conflict('本批次已有实际入库记录，不能通过范围拆分改名或抹除原实物来源。');
      const sum = command.children.reduce((total, child) => total.plus(child.quantity), new Prisma.Decimal(0));
      if (!sum.eq(parent.quantity)) return conflict('子批次必须精确、完整覆盖父批次数量。');
      const contractSizes = contractSizeMap(line);
      let childSizeBreakdowns: Array<GarmentSizeMap | null> = command.children.map(child => child.sizeBreakdown ?? null);
      if (contractSizes) {
        try { assertGarmentSizeSplit(parent, command.children, contractSizes); }
        catch (error) { return conflict(error instanceof Error ? error.message : '子批尺码数量必须完整覆盖父分支。'); }
      } else if (parent.sizeBreakdown != null || command.children.some(child => child.sizeBreakdown != null))
        return conflict('当前订单行没有成衣尺码矩阵，不能拆分尺码分配。');
      const active = await tx.productionBatch.findMany({ where: { orderLineId: line.id, state: 'active' } });
      firstGap(active, new Prisma.Decimal(0), line); // Verify original partition before replacing one interval.
      const now = BigInt(Date.now()), children: any[] = []; let start = new Prisma.Decimal(parent.rangeStart);
      for (const [index, child] of command.children.entries()) {
        const row = await tx.productionBatch.create({ data: { id: `PB_${randomUUID()}`, batchCode: child.batchCode, orderId: order.id, orderLineId: line.id,
          parentBatchId: parent.id, factoryRelationId: parent.factoryRelationId, rangeStart: start, quantity: child.quantity, unit: parent.unit, revision: 1, state: 'active',
          ...(parent.productionLineSnapshot == null ? {} : { productionLineId: parent.productionLineId, productionLineSnapshot: parent.productionLineSnapshot }),
          sizeBreakdown: childSizeBreakdowns[index],
          confirmedSourceType: parent.confirmedSourceType, confirmedSourceId: parent.confirmedSourceId, specSnapshot: parent.specSnapshot, sourceFingerprint: parent.sourceFingerprint,
          requestKey: `child:${hash([actor.userId, command.requestKey, parent.id, index])}`, parameterHash, commandSnapshot: { ...command, parentId: parent.id, childIndex: index },
          createdBy: actor.userId, createdAt: now, updatedAt: now } });
        children.push(row); start = start.plus(child.quantity);
      }
      const changed = await tx.productionBatch.updateMany({ where: { id: parent.id, state: 'active', revision: command.expectedRevision }, data: { state: 'split', revision: { increment: 1 }, updatedAt: now } });
      if (changed.count !== 1) return conflict('父批次已变化，请核对原拆批请求。');
      const result = { parent: json(await tx.productionBatch.findUnique({ where: { id: parent.id } })), children: json(children), replayed: false };
      await auditReceipt(tx, actor.userId, actions[1], parent.id, line.id, command, parameterHash, result, parent);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20_000 });
  });
}
