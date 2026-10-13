import { currentOrderMoqReasons } from '../orderChanges/quantityPlanMoqGate';
import { resolveGarmentMaterialProof } from '../orders/internalFabricGate';
import { orderSampleDigest } from '../samples/orderSampleSourceContract';
import { createHash } from 'node:crypto';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope } from '../auth/permissionService';
import { OrderLineWriteError, freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { safeRouteError } from '../shared/routeError';
import type { TokenPayload } from '../auth/service';
import { exactJsonValue } from '../lib/exactJsonValue';
import { businessError as registeredBusinessError } from '../shared/errorCodes';
import { ProductionBatchFactsError } from './productionBatchFacts';
import { ReleaseBatchBindingError, currentReleaseActor, releaseQuantity, lockReleaseBatchRows, resolveReleaseBatchBinding, readReleaseBatchBinding, assertReleaseBatchProof, classifyReleaseScope, hasBatchReleaseMode } from './releaseBatchBinding';
/**
 * releaseService.ts — DR-053 阶段 2：生产放行范围化（§14）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md §14
 *
 * 核心语义（§14.2/14.3）：
 *  - ReleaseScope：按订单行/实际批次确定放行范围（scopeRevision 递增=范围变化，旧批准不再匹配）
 *  - ReleaseRequest：固定本次审批输入（scope 规格依据 + 样品证据修订快照）
 *  - ReleaseSignature：签署追加；同请求同角色唯一；两角色由不同人员承担
 *  - PpSampleRelease：双签齐备且服务端重验通过后写入；批准事实不可变（不覆盖/删除）
 *  - ReleaseEvent：append-only（granted/paused/resumed/revoked/invalidated/superseded）；sourceKey 幂等
 *  - evaluateProductionRelease：统一资格判定（页面/生产 API/Agent 共用；执行前必须重验）
 *
 * 返修联动：Sample revise / 证据失效 → invalidateScopesBySample 把引用该样品的 active
 * scope 置 invalidated + 追加事件（历史批准保留，不抹）。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { assertConfirmedFabricSourceEligible, lockConfirmedFabricSourcesIsolated, type ConfirmedFabricSource, type FailedFabricSource } from '../development/fabricAssetEligibility';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { sampleConsumerOriginProof, assertFrozenSampleConsumerOrigin } from '../samples/sampleConsumerSource';
import { resolveOrderSampleConsumerProof, assertFrozenOrderSampleConsumerProof } from '../samples/orderSampleConsumerProof';
import { isLeaderPrincipal } from '../_shared/rolePermissionMatrix';

import { publishNotificationEvent } from '../realtime';
import { logger } from '../lib/logger';
export const RELEASE_ROLES = ['production', 'business'] as const;
export type ReleaseRole = (typeof RELEASE_ROLES)[number];
export type ReleaseScopeState = 'no_release' | 'ready' | 'paused' | 'revoked' | 'invalidated';
export const RELEASE_EVENT_KINDS = ['granted', 'paused', 'resumed', 'revoked', 'invalidated', 'superseded'] as const;

/**
 * 证据失效态：样品处于这些状态时，批准锁定的证据不再成立（§14.4 兜底第 ② 层）。
 * 注意 sealed/approved/confirmed… 均**不在**此列——封样、继续确认不改变已批准事实，不得误伤。
 */
export const EVIDENCE_VOID_SAMPLE_STATUSES: readonly string[] = ['revising', 'rejected'];

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });
const ok = <T>(data: T): Result<T> => ({ ok: true, data });
class ReleaseGateError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) { super(message); }
}
/** Native intentional rejects keep the registered status and operation-specific text. */
const businessError = (code: string, message: string) => {
  const canonical = registeredBusinessError(code, message);
  return new ReleaseGateError(canonical.code, canonical.message, canonical.statusCode);
};
export function knownReleaseFailure(error: unknown): Result<never> | null {
  if (error instanceof ReleaseGateError || error instanceof DevelopmentDomainError) return fail(error.code, error.message, error.statusCode);
  if (error instanceof ReleaseBatchBindingError || error instanceof ProductionBatchFactsError || error instanceof OrderLineWriteError) { const safe = safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }); return fail(safe.code, safe.message, safe.status); }
  return storageReleaseConflict(error);
}

/** The public router always supplies this field (null is not a legacy seam).
 * Existing trusted internal scalar callbacks keep their original contract. */
async function authorizePublicRelease(tx: any, params: { actorId: string; trustedActor?: TokenPayload | null }, cap: string, orderId: string,
  options: { leaderOnly?: boolean } = {}) {
  if (params.trustedActor === undefined) return undefined;
  const actor = await currentReleaseActor(tx, params.trustedActor, cap, orderId);
  if (params.actorId !== actor.userId) throw businessError('UNAUTHORIZED', '放行签署主体与可信当前账号不一致。');
  // PP approval is a leader-only single signature. Evaluate role identity from
  // the current DB-loaded actor returned above; JWT role claims only identify
  // the subject and cannot preserve a role that has since been removed.
  if (options.leaderOnly && !isLeaderPrincipal([...(actor.roleIds ?? []), ...(actor.roles ?? [])])) {
    throw businessError('FORBIDDEN', 'PP 样放行单签仅限当前业务领导、销售主管或老板。');
  }
  return actor;
}

function genId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** scope 内下一个事件序号（append-only） */
async function nextEventSequence(prisma: PrismaClient, scopeId: string): Promise<number> {
  const last = await (prisma as any).releaseEvent.findFirst({ where: { scopeId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
  return (last?.sequence ?? 0) + 1;
}

/** 追加事件 + 更新 scope 当前投影（同事务调用方保证原子） */
async function appendEventAndUpdateScope(tx: any, scopeId: string, kind: string, opts: { releaseId?: string | null; reason?: string | null; actorId?: string | null; sourceKey?: string | null; state?: string; currentReleaseId?: string | null }): Promise<void> {
  // Every event producer takes the Scope row before its sequence/unique key.
  // Callers have already locked native source parents and Order/Line rows.
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ReleaseScope" WHERE "id"=${scopeId} FOR UPDATE`);
  const sequence = await nextEventSequence(tx, scopeId);
  await tx.releaseEvent.create({
    data: {
      id: genId('REV'), scopeId, sequence, kind,
      releaseId: opts.releaseId ?? null, reason: opts.reason ?? null, actorId: opts.actorId ?? null,
      sourceKey: opts.sourceKey ?? null, occurredAt: BigInt(Date.now()), createdAt: BigInt(Date.now()),
    },
  });
  if (opts.state) {
    const data: any = { state: opts.state, updatedAt: BigInt(Date.now()) };
    if (opts.currentReleaseId !== undefined) data.currentReleaseId = opts.currentReleaseId;
    await tx.releaseScope.update({ where: { id: scopeId }, data });
  }
}

// ════════════════════════════════════════════════════════════════════
// 放行范围（§14.1）
// ════════════════════════════════════════════════════════════════════

export async function createReleaseScope(params: {
  prisma: PrismaClient;
  orderId: string;
  orderLineId: string;
  input: { factoryRelationId?: string | null; productionBatchId?: string; expectedBatchRevision?: number; quantity?: string | number; unit?: string; confirmedSourceType?: string | null; confirmedSourceId?: string | null; specSnapshot?: unknown };
  actorId: string;
  trustedActor?: TokenPayload | null;
}): Promise<Result<{ scope: any }>> {
  const { prisma, orderId, orderLineId, input, actorId } = params;
  try {
    // 校验订单行存在
    const line = await (prisma as any).orderLine.findUnique({ where: { id: orderLineId }, select: { id: true, orderId: true } });
    if (!line || line.orderId !== orderId) return fail('ORDER_LINE_NOT_FOUND', `订单行 ${orderLineId} 不属于订单 ${orderId}`, 404);
    const hasBatch = input.productionBatchId != null;
    const qty = hasBatch ? null : releaseQuantity(input.quantity);

    const now = BigInt(Date.now());
    // 拆批后整行 scope 退出（同 orderId+lineId 已有整行 scope 且新 scope 带批次 → 整行置 invalidated）
    const scope = await (prisma as any).$transaction(async (tx: any) => {
      // The native UI sends quantity/unit only. Client source fields are
      // assertions, never a producer of a different confirmed line version.
      await authorizePublicRelease(tx, params, 'orders:write', orderId);
      const parentBefore = await tx.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true, millRelationId: true, sourceCaseId: true, type: true, businessLine: true } });
      const locks = await lockOrderReleaseSources(tx, orderId, { additionalSources: [{ type: input.confirmedSourceType ?? null, id: input.confirmedSourceId ?? null }] });
      await lockReleaseBatchRows(tx, orderId);
      await authorizePublicRelease(tx, params, 'orders:write', orderId);
      const parent = await tx.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true, millRelationId: true, sourceCaseId: true, type: true, businessLine: true } });
      if (!parent || !sameSource(parentBefore, parent)) throw new DevelopmentDomainError('CONFLICT', '订单或工厂来源在锁定时变化，请刷新后核对放行范围');
      const currentLine = await tx.orderLine.findUnique({ where: { id: orderLineId } });
      if (!currentLine || currentLine.orderId !== orderId) throw new ReleaseGateError('ORDER_LINE_NOT_FOUND', '订单行不存在或归属已变化', 404);
      const source = await lineSource(tx, currentLine);
      const denied = deniedSourceReasons(locks.failedSources, [source]);
      if (denied.length) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', denied.join('；'));
      const currentSource = await assertConfirmedFabricSourceEligible(tx, source);
      const specSnapshot = currentLine.specSnapshot ?? null;
      if (source.type === 'Sample') assertFrozenSampleConsumerOrigin(currentSource.sampleOriginProof ?? null, (specSnapshot as any)?.sampleOriginProof);
      for (const [key, actual] of [['confirmedSourceType', source.type], ['confirmedSourceId', source.id], ['specSnapshot', specSnapshot]] as const) {
        if (Object.prototype.hasOwnProperty.call(input, key) && !sameSource(input[key] ?? null, actual)) {
          throw new DevelopmentDomainError('CONFLICT', '提交的确认来源或规格与订单行当前依据不一致，请刷新后核对');
        }
      }
      const isGarment = String(parent.businessLine ?? parent.type).toLowerCase() === 'garment';
      if (!isGarment && currentSource.factoryRelationId && parent.millRelationId && currentSource.factoryRelationId !== parent.millRelationId) {
        throw new DevelopmentDomainError('CONFLICT', '订单工厂与当前确认成果工厂不一致，请核对原订单行');
      }
      // An independently recorded historical source can lack a factory. Keep
      // that explicit legacy input contract; never infer one from a name.
      const binding = hasBatch ? await resolveReleaseBatchBinding(tx, { ...input, orderId, orderLineId, productionBatchId: input.productionBatchId, expectedBatchRevision: input.expectedBatchRevision }) : null;
      const factoryRelationId = isGarment && binding ? binding.factoryRelationId : currentSource.factoryRelationId ?? parent.millRelationId ?? input.factoryRelationId ?? null;
      if (Object.prototype.hasOwnProperty.call(input, 'factoryRelationId') && (input.factoryRelationId ?? null) !== factoryRelationId) {
        throw new DevelopmentDomainError('CONFLICT', '提交的放行工厂与当前真实工厂不一致，请刷新后核对');
      }
      const wholeScopes = await tx.releaseScope.findMany({ where: { orderId, orderLineId, productionBatchId: null, deletedAt: null }, orderBy: { id: 'asc' } });
      if (!hasBatch) {
        if (await hasBatchReleaseMode(tx, orderId, orderLineId)) throw businessError('CONFLICT', '该订单行已由实际批次范围承接，不能新增整行放行范围。');
        for (const whole of wholeScopes) {
          if ((await classifyReleaseScope(tx, whole)).classification === 'current') throw businessError('CONFLICT', `已有当前整行范围 ${whole.id}，请在原范围中继续办理。`);
        }
      }
      const created = await tx.releaseScope.create({
        data: {
          id: genId('RS'), orderId, orderLineId,
          factoryRelationId,
          productionBatchId: binding?.id ?? null,
          productionBatchRevision: binding?.revision ?? null,
          quantity: binding?.quantity ?? qty!, unit: binding?.unit ?? input.unit ?? null,
          scopeRevision: 1, state: 'no_release',
          confirmedSourceType: source.type,
          confirmedSourceId: source.id,
          specSnapshot,
          createdAt: now, updatedAt: now,
        },
      });
      // 拆批：整行 scope 退出当前适用集合（旧批准不再匹配）
      if (hasBatch) {
        for (const whole of wholeScopes) {
          const last = whole.state === 'invalidated' ? await tx.releaseEvent.findFirst({ where: { scopeId: whole.id }, orderBy: { sequence: 'desc' }, select: { kind: true } }) : null;
          if (last?.kind === 'superseded') continue;
          await appendEventAndUpdateScope(tx, whole.id, 'superseded', { releaseId: whole.currentReleaseId, actorId, reason: '整行范围退出，由实际批次承接', state: 'invalidated', currentReleaseId: null });
        }
      }
      await writeRouteAuditLog({
        prisma: tx, actorId: actorId || 'api', source: 'route:release:scope', operation: 'create_release_scope',
        targetType: 'ReleaseScope', targetId: created.id,
        after: { orderId, orderLineId, factoryRelationId: created.factoryRelationId, productionBatchId: created.productionBatchId, productionBatchRevision: created.productionBatchRevision, quantity: created.quantity.toString(),
          unit: created.unit, confirmedSourceType: created.confirmedSourceType, confirmedSourceId: created.confirmedSourceId, specSnapshot: created.specSnapshot }, ip: null,
      });
      if (binding) await readReleaseBatchBinding(tx, created);
      await authorizePublicRelease(tx, params, 'orders:write', orderId);
      return created;
    });
    return ok({ scope });
  } catch (e: any) {
    // Scope, superseding event and mandatory audit now share the same tx.
    // Retain the existing conservative user-facing recovery wording.
    logger.error('[Release] 创建放行范围失败', { orderId, orderLineId, error: e?.message });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
      && Array.isArray(e.meta?.target)
      && ['orderId', 'orderLineId', 'productionBatchId'].every(field => (e.meta!.target as string[]).includes(field))) {
      return fail('CONFLICT', '该订单行和实际批次的放行范围已存在，请核对现有范围后继续。', 409);
    }
    const known = knownReleaseFailure(e); if (known) return known;
    return fail('SCOPE_CREATE_FAILED', '创建放行范围未能完成，请稍后重试；持续失败请联系管理员核对该订单行的放行范围与拆批记录。', 500);
  }
}

/** Explicitly advances the current projection of the same native batch range.
 * Original approvals, signatures and evidence remain immutable history. */
export async function rebindReleaseScope(params: {
  prisma: PrismaClient; scopeId: string; actorId: string; trustedActor: TokenPayload | null;
  input: { productionBatchId?: string; expectedScopeRevision?: number; expectedBatchRevision?: number;
    quantity?: string | number; unit?: string; factoryRelationId?: string | null;
    confirmedSourceType?: string | null; confirmedSourceId?: string | null; specSnapshot?: unknown };
}): Promise<Result<{ scope: any }>> {
  const { prisma, scopeId, actorId, input } = params;
  try {
    if (!Number.isSafeInteger(input.expectedScopeRevision) || (input.expectedScopeRevision as number) < 1)
      throw businessError('INVALID_INPUT', '须提交读取到的范围修订。');
    // This new endpoint has no legacy scalar-actor compatibility seam.
    if (!params.trustedActor?.userId || params.trustedActor.userId !== actorId)
      throw businessError('UNAUTHORIZED', '范围重新绑定需要可信的当前登录主体。');
    const scope = await (prisma as any).$transaction(async (tx: any) => {
      const hint = await tx.releaseScope.findFirst({ where: { id: scopeId, deletedAt: null } });
      if (!hint) throw new ReleaseGateError('SCOPE_NOT_FOUND', '范围不存在', 404);
      await authorizePublicRelease(tx, params, 'orders:write', hint.orderId);
      const { scope: before, locks } = await lockedReleaseScope(tx, scopeId);
      await authorizePublicRelease(tx, params, 'orders:write', before.orderId);
      if (before.productionBatchId == null || input.productionBatchId !== before.productionBatchId)
        throw businessError('CONFLICT', '仅可续办原范围的同一实际批次；整行转换须建立真实批次范围。');
      if (before.scopeRevision !== input.expectedScopeRevision) throw businessError('CONFLICT', '范围修订已变化，请刷新后核对。');
      if (!Number.isSafeInteger(before.scopeRevision + 1)) throw businessError('CONFLICT', '范围修订无法继续，请联系管理员核对。');
      const binding = await resolveReleaseBatchBinding(tx, { ...input, orderId: before.orderId, orderLineId: before.orderLineId,
        productionBatchId: input.productionBatchId, expectedBatchRevision: input.expectedBatchRevision });
      const denied = deniedSourceReasons(locks.failedSources, [{ type: binding.confirmedSourceType, id: binding.confirmedSourceId }]);
      if (denied.length) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', denied.join('；'));
      await assertConfirmedFabricSourceEligible(tx, { type: binding.confirmedSourceType, id: binding.confirmedSourceId });
      const now = BigInt(Date.now());
      await tx.releaseScope.update({ where: { id: scopeId }, data: {
        productionBatchId: binding.id, productionBatchRevision: binding.revision, quantity: binding.quantity, unit: binding.unit,
        factoryRelationId: binding.factoryRelationId, confirmedSourceType: binding.confirmedSourceType,
        confirmedSourceId: binding.confirmedSourceId, specSnapshot: binding.specSnapshot,
        scopeRevision: before.scopeRevision + 1, state: 'no_release', currentReleaseId: null, updatedAt: now,
      } });
      await tx.releaseRequest.updateMany({ where: { scopeId, state: 'pending' }, data: { state: 'voided', updatedAt: now } });
      await appendEventAndUpdateScope(tx, scopeId, 'invalidated', { releaseId: before.currentReleaseId, actorId,
        reason: '显式重新绑定实际批次；须按新的范围修订重新送审签署', state: 'no_release', currentReleaseId: null });
      const updated = await tx.releaseScope.findUnique({ where: { id: scopeId } });
      await readReleaseBatchBinding(tx, updated);
      await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:release:rebind', operation: 'rebind_release_scope',
        targetType: 'ReleaseScope', targetId: scopeId, before: exactJsonValue(before), after: exactJsonValue(updated), ip: null });
      await authorizePublicRelease(tx, params, 'orders:write', before.orderId);
      return updated;
    }, { timeout: 20000 });
    return ok({ scope });
  } catch (error) {
    logger.error('[Release] Explicit batch rebind failed', { scopeId, error });
    const known = knownReleaseFailure(error); if (known) return known;
    return fail('INTERNAL_ERROR', '批次范围重新绑定未能完成，本次未确认任何改动，请保留原修订并刷新核对。', 500);
  }
}

// ════════════════════════════════════════════════════════════════════
// 放行请求 + 签署 + 批准（§14.2）
// ════════════════════════════════════════════════════════════════════

/** 从样品（Sample pp/seal）构建证据修订快照（冻结；含轮次/工厂/规格/确认状态） */
async function buildEvidenceSnapshot(prisma: PrismaClient, sampleId: string | null | undefined, scopeId: string): Promise<{ sampleId: string | null; sampleRound: number | null; snapshot: unknown }> {
  if (!sampleId) return { sampleId: null, sampleRound: null, snapshot: null };
  const s = await (prisma as any).sample.findFirst({ where: { id: sampleId, deletedAt: null } });
  if (!s) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', '送审证据样品不存在或已不可用，请核对后续办', 409);
  // Native storage enforces sourceOrderId on every bound Sample. Case-only
  // origins retain their existing producer and consumer contract.
  const native = s.sourceOrderId ? await (prisma as any).orderSampleSource.findUnique({ where: { sampleId: s.id }, select: { id: true, family: true } }) : null;
  if (native) {
    if (native.family !== 'garment_pp') throw new ReleaseGateError('SCOPE_NOT_ACTIVE', '本次产前放行须引用对应范围的产前样，船样、匹头样或投产后样品不能替代产前依据。', 409);
    const current = await resolveOrderSampleConsumerProof(prisma, { kind: 'release_scope', id: scopeId }, 'garment_pp', { sourceId: native.id });
    if (current.mode !== 'native' || !current.qualified || current.proof.source.sampleId !== s.id) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', '此产前样尚未满足本范围的实际检验、寄送、客户确认或来源版本要求，请核对样品业务记录。', 409);
    return { sampleId: s.id, sampleRound: current.proof.source.round,
      snapshot: { sampleId: s.id, code: s.code, type: s.type, round: current.proof.source.round,
        nativeOrderSampleScopeId: scopeId, nativeOrderSampleProof: current.proof } };
  }
  const sampleOriginProof = await sampleConsumerOriginProof(prisma, s);
  return {
    sampleId: s.id,
    sampleRound: s.round ?? null,
    snapshot: {
      sampleId: s.id, code: s.code, type: s.type, status: s.status, round: s.round,
      supplierRelationId: s.supplierRelationId, supplierName: s.supplierName,
      qcStatus: s.qcStatus, customerStatus: s.customerStatus, approvedAt: s.approvedAt ? Number(s.approvedAt) : null,
      productAssetId: s.productAssetId, specSnapshot: s.specSnapshot ?? null,
      sampleOriginProof,
    },
  };
}

export async function createReleaseRequest(params: {
  prisma: PrismaClient;
  scopeId: string;
  input: { sampleId?: string; expectedScopeRevision?: number; clientRequestId?: string };
  actorId: string;
  trustedActor?: TokenPayload | null;
}): Promise<Result<{ request: any }>> {
  const { prisma, scopeId, input, actorId } = params;
  try {
    const request = await (prisma as any).$transaction(async (tx: any) => {
      const hint = await tx.releaseScope.findFirst({ where: { id: scopeId, deletedAt: null } });
      if (!hint) throw new ReleaseGateError('SCOPE_NOT_FOUND', '范围不存在', 404);
      await authorizePublicRelease(tx, params, 'orders:write', hint.orderId);
      const { scope, locks } = await lockedReleaseScope(tx, scopeId, { evidenceSampleIds: input.sampleId ? [input.sampleId] : [] });
      await authorizePublicRelease(tx, params, 'orders:write', scope.orderId);
      const binding = await readReleaseBatchBinding(tx, scope);
      if (scope.state === 'revoked') throw new ReleaseGateError('SCOPE_NOT_ACTIVE', '范围已 revoked，不可发起放行请求', 409);
      if (scope.state === 'invalidated') {
        const lastEvent = await tx.releaseEvent.findFirst({ where: { scopeId }, orderBy: { sequence: 'desc' }, select: { kind: true } });
        if (lastEvent?.kind === 'superseded') throw new ReleaseGateError('SCOPE_SUPERSEDED', '该范围已因拆批退出（由子批次承接），不可重新发起放行', 409);
      }
      if (input.expectedScopeRevision && Number(input.expectedScopeRevision) !== Number(scope.scopeRevision)) {
        throw new ReleaseGateError('SCOPE_REVISION_MISMATCH', `范围修订已变化（期望 ${input.expectedScopeRevision}，当前 ${scope.scopeRevision}），请刷新后重试`, 409);
      }
      const sourceReasons = [...await scopeSourceReasons(tx, scope, locks.failedSources), ...await currentOrderMoqReasons(tx,scope.orderId)];
      if (sourceReasons.length) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', sourceReasons.join('；'), 409);
      const evidence = await buildEvidenceSnapshot(tx, input.sampleId, scope.id);
      const materialOrder = await tx.order.findFirst({ where: { id: scope.orderId, deletedAt: null } });
      const materialLine = await tx.orderLine.findUnique({ where: { id: scope.orderLineId } });
      const materialProof = await resolveGarmentMaterialProof(tx, materialOrder, materialLine);
      if (materialProof) evidence.snapshot = { ...(evidence.snapshot as any ?? {}), materialProof };
      if (binding) evidence.snapshot = { ...(evidence.snapshot as any ?? {}), productionBatchBinding: binding };
      if (scope.state === 'invalidated') {
        await appendEventAndUpdateScope(tx, scope.id, 'resumed', { reason: '样品返修后重新发起放行（P2-1：invalidated 不再是死状态）', actorId,
          state: 'no_release', currentReleaseId: null });
      }
      const now = BigInt(Date.now());
      // No persisted request key exists in this legacy model: creation is
      // atomic, but this endpoint does not claim request-key idempotency.
      const created = await tx.releaseRequest.create({ data: { id: genId('RRQ'), scopeId, scopeRevision: scope.scopeRevision,
        evidenceSnapshot: evidence.snapshot as any, specSnapshot: scope.specSnapshot as any,
        ruleVersion: 'pp-release-v1', requestRevision: 1, state: 'pending', createdBy: actorId, createdAt: now, updatedAt: now } });
      if (binding) assertReleaseBatchProof(await readReleaseBatchBinding(tx, scope), created.evidenceSnapshot);
      const finalReasons = [...await scopeSourceReasons(tx, scope, locks.failedSources), ...await currentOrderMoqReasons(tx,scope.orderId),
        ...await requestSampleReasons(tx, created.evidenceSnapshot, locks.failedSources, scope.id)];
      if (finalReasons.length) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', finalReasons.join('；'), 409);
      await authorizePublicRelease(tx, params, 'orders:write', scope.orderId);
      return created;
    });
    return ok({ request });
  } catch (e: any) {
    // Reinstatement/event and creation share the tx; keep the existing conservative recovery wording.
    logger.error('[Release] 发起放行请求失败', { scopeId, error: e?.message });
    const known = knownReleaseFailure(e); if (known) return known;
    return fail('REQUEST_CREATE_FAILED', '发起放行请求未能完成，请稍后重试；持续失败请联系管理员核对该放行范围的请求与证据快照。', 500);
  }
}

export async function signReleaseRequest(params: {
  prisma: PrismaClient;
  requestId: string;
  role: string;
  actorId: string;
  trustedActor?: TokenPayload | null;
  actorName?: string;
  expectedRequestRevision?: number;
  expectedScopeRevision?: number;
  reviewContentFingerprint?: string;
  confirmedReviewedContent?: boolean;
}): Promise<Result<{ release?: any; request: any; signed: boolean }>> {
  const { prisma, requestId, role, actorId, actorName } = params;
  if (!(RELEASE_ROLES as readonly string[]).includes(role)) return fail('INVALID_ROLE', `签字角色必须是 ${RELEASE_ROLES.join('|')}`, 400);
  // Reject incomplete public signing attempts before opening a transaction.
  // The locked transaction below still compares these facts with the exact
  // pending request; this is only a shape and attestation gate.
  if (params.trustedActor !== undefined) {
    if (params.confirmedReviewedContent !== true) return fail('REVIEW_CONFIRMATION_REQUIRED', '请先核对放行依据并明确确认后再签署。', 400);
    if (!Number.isSafeInteger(params.expectedRequestRevision) || Number(params.expectedRequestRevision) < 1
      || !Number.isSafeInteger(params.expectedScopeRevision) || Number(params.expectedScopeRevision) < 1
      || typeof params.reviewContentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(params.reviewContentFingerprint)) {
      return fail('REVIEW_CONTENT_CHANGED', '原申请或范围修订尚未完成核对，请重新读取最终依据。', 409);
    }
  }
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const hint = await tx.releaseRequest.findUnique({ where: { id: requestId } });
      if (!hint) throw new ReleaseGateError('REQUEST_NOT_FOUND', '放行请求不存在', 404);
      const hintScope = await tx.releaseScope.findFirst({ where: { id: hint.scopeId, deletedAt: null } });
      if (!hintScope) throw new ReleaseGateError('SCOPE_NOT_FOUND', '范围不存在', 404);
      const cap = role === 'production' ? 'production:pp_release:production_sign' : 'production:pp_release:business_sign';
      await authorizePublicRelease(tx, params, cap, hintScope.orderId, { leaderOnly: true });
      const sampleId = hint.evidenceSnapshot?.sampleId;
      const { scope, locks } = await lockedReleaseScope(tx, hint.scopeId, { evidenceSampleIds: sampleId ? [String(sampleId)] : [] });
      await authorizePublicRelease(tx, params, cap, scope.orderId, { leaderOnly: true });
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ReleaseRequest" WHERE "id"=${requestId} FOR UPDATE`);
      const request = await tx.releaseRequest.findUnique({ where: { id: requestId } });
      if (!request) throw new ReleaseGateError('REQUEST_NOT_FOUND', '放行请求不存在', 404);
      if (request.scopeId !== hint.scopeId || !sameSource(request.evidenceSnapshot, hint.evidenceSnapshot)) throw new DevelopmentDomainError('CONFLICT', '请求证据或范围在锁定时变化，请刷新后重新核对');
      if (request.state !== 'pending') throw new ReleaseGateError('REQUEST_NOT_PENDING', `请求已 ${request.state}`, 409);

      // Public signers must explicitly attest to the exact final request and
      // scope they reviewed. Legacy trusted in-process callers keep their
      // established contract; the HTTP route always supplies trustedActor.
      if (params.trustedActor !== undefined) {
        if (params.confirmedReviewedContent !== true) throw new ReleaseGateError('REVIEW_CONFIRMATION_REQUIRED', '请先核对放行依据并明确确认后再签署。', 400);
        if (!Number.isSafeInteger(params.expectedRequestRevision) || Number(params.expectedRequestRevision) !== Number(request.requestRevision)
          || !Number.isSafeInteger(params.expectedScopeRevision) || Number(params.expectedScopeRevision) !== Number(request.scopeRevision)) {
          throw new ReleaseGateError('REVIEW_CONTENT_CHANGED', '原申请或范围修订已变化，请重新读取并核对最终依据。', 409);
        }
      }

      if (Number(scope.scopeRevision) !== Number(request.scopeRevision)) throw new ReleaseGateError('SCOPE_REVISION_CHANGED', `范围修订已变化（${scope.scopeRevision}≠${request.scopeRevision}），需重新发起请求`, 409);
      if (['revoked', 'invalidated'].includes(scope.state)) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', `范围已 ${scope.state}，不可批准`, 409);
      if (!sameSource(scope.specSnapshot ?? null, request.specSnapshot ?? null)) throw new ReleaseGateError('SCOPE_REVISION_CHANGED', '范围规格依据已变化，请重新发起请求', 409);
      const binding = await readReleaseBatchBinding(tx, scope);
      assertReleaseBatchProof(binding, request.evidenceSnapshot);
      const sourceReasons = [...await scopeSourceReasons(tx, scope, locks.failedSources), ...await currentOrderMoqReasons(tx,scope.orderId)];
      const sampleReasons = await requestSampleReasons(tx, request.evidenceSnapshot, locks.failedSources, scope.id);
      if (sourceReasons.length || sampleReasons.length) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', [...sourceReasons, ...sampleReasons].join('；'), 409);

      if (params.trustedActor !== undefined) {
        const line = await tx.orderLine.findUnique({ where: { id: scope.orderLineId } });
        const order = await tx.order.findFirst({ where: { id: scope.orderId, deletedAt: null }, select: { id: true, poNumber: true } });
        if (!line || line.orderId !== scope.orderId || !order) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', '订单行或订单编号已变化，请重新读取原申请。', 409);
        const currentReviewFingerprint = releaseReviewFingerprint({ request, scope, line, order });
        if (typeof params.reviewContentFingerprint !== 'string' || params.reviewContentFingerprint !== currentReviewFingerprint) {
          throw new ReleaseGateError('REVIEW_CONTENT_CHANGED', '最终放行依据已变化，请重新读取并核对后再签署。', 409);
        }
      }

      // §10.7 P-3 口径修正（业务方 2026-09-12）：**无双签**——工厂不在公司体系内，
      // 放行 = 领导（老板/业务负责人）单签即批准。保留双角色表结构与历史 pending 兼容：
      // 若请求此前已有另一角色签（旧双签数据），批准时一并回填。
      const existingSig = await tx.releaseSignature.findUnique({ where: { requestId_role: { requestId, role } } });
      if (existingSig) throw new ReleaseGateError('ALREADY_SIGNED', `该请求已由${role === 'production' ? '生产' : '业务'}签署`, 409);

      const now = BigInt(Date.now());
      await tx.releaseSignature.create({
        data: {
          id: genId('RSG'), requestId, role, actorId, actorName: actorName ?? null,
          signedAt: now, inputDigest: params.reviewContentFingerprint ?? `rev=${request.requestRevision}:scope=${request.scopeRevision}`,
        },
      });

      const otherRole = role === 'production' ? 'business' : 'production';
      const otherSig = await tx.releaseSignature.findUnique({ where: { requestId_role: { requestId, role: otherRole } } });
      const prodSig = role === 'production'
        ? { actorId, actorName: actorName ?? null, signedAt: now }
        : (otherSig ? { actorId: otherSig.actorId, actorName: otherSig.actorName, signedAt: otherSig.signedAt } : null);
      const bizSig = role === 'business'
        ? { actorId, actorName: actorName ?? null, signedAt: now }
        : (otherSig ? { actorId: otherSig.actorId, actorName: otherSig.actorName, signedAt: otherSig.signedAt } : null);

      const release = await tx.ppSampleRelease.create({
        data: {
          id: genId('REL'), requestId,
          scopeId: scope.id, scopeRevision: scope.scopeRevision,
          signedByProduction: prodSig?.actorId ?? null, signedByBusiness: bizSig?.actorId,
          signedAtProduction: prodSig?.signedAt ?? null, signedAtBusiness: bizSig?.signedAt ?? null,
          approvedBy: actorId, approvedAt: now,
          sampleId: (request.evidenceSnapshot as any)?.sampleId ?? null,
          sampleRound: (request.evidenceSnapshot as any)?.round ?? null,
          evidenceSnapshot: request.evidenceSnapshot as any,
          ruleVersion: request.ruleVersion,
          createdAt: now,
        },
      });
      await tx.releaseRequest.update({ where: { id: requestId }, data: { state: 'granted', updatedAt: now } });
      await appendEventAndUpdateScope(tx, scope.id, 'granted', {
        releaseId: release.id, actorId, reason: '领导签字，放行批准（单签口径）',
        state: 'ready', currentReleaseId: release.id,
      });
      assertReleaseBatchProof(await readReleaseBatchBinding(tx, scope), request.evidenceSnapshot);
      const finalReasons = [...await scopeSourceReasons(tx, scope, locks.failedSources), ...await currentOrderMoqReasons(tx,scope.orderId), ...await requestSampleReasons(tx, request.evidenceSnapshot, locks.failedSources, scope.id)];
      if (finalReasons.length) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', finalReasons.join('；'), 409);
      await authorizePublicRelease(tx, params, cap, scope.orderId, { leaderOnly: true });
      const order = await tx.order.findFirst({ where: { id: scope.orderId, deletedAt: null },
        select: { id: true, ownerId: true, poNumber: true } });
      let notificationReceipt: { id: string; userId: string; title: string; body: string; link: string;
        metadata: Record<string, string>; created: boolean } | null = null;
      let notificationStatus: 'persisted' | 'already_persisted' | 'no_recipient' = 'no_recipient';
      if (order?.ownerId) {
        const id = `ntf_pp_release_granted_${requestId}`;
        const title = `订单 ${order.poNumber || order.id} 放行已批准`;
        const body = '领导已签字放行（单签口径），该订单可按放行范围推进开裁/投产。';
        const link = `/orders?id=${encodeURIComponent(order.id)}&tab=production`;
        const metadata = { orderId: order.id, requestId, releaseId: release.id };
        // This is a required result handoff, like approvalResultReceipt: muted
        // reminder preferences never suppress it, and a failed write rolls back
        // the signature/release/granted facts with this transaction.
        const created = await tx.notification.createMany({ data: [{ id, userId: String(order.ownerId),
          type: 'pp_release_granted', title, body, level: 'info', link,
          metadata: metadata as Prisma.InputJsonValue }], skipDuplicates: true });
        notificationStatus = created.count > 0 ? 'persisted' : 'already_persisted';
        notificationReceipt = { id, userId: String(order.ownerId), title, body, link, metadata, created: created.count > 0 };
      }
      return { release, request: { ...request, state: 'granted' }, signed: true,
        notificationStatus, notificationOrderId: scope.orderId, notificationReceipt };
    });
    // The Notification row is committed with approval. SSE is only a live nudge;
    // REST reads retain the durable handoff if a client is offline or this write fails.
    const { notificationReceipt, notificationOrderId, ...response } = result as any;
    if (notificationReceipt?.created) {
      try {
        publishNotificationEvent({ type: 'pp_release_granted', title: notificationReceipt.title,
          body: notificationReceipt.body, level: 'info', link: notificationReceipt.link,
          eventId: notificationReceipt.id, eventType: 'pp_release_granted',
          recipientIds: [notificationReceipt.userId], metadata: notificationReceipt.metadata });
      } catch (e: any) {
        logger.warn('[Release] 放行已批通知 SSE 投递失败；持久通知仍可读取', { requestId, error: e?.message });
      }
    } else if (response.notificationStatus === 'no_recipient') {
      logger.warn('[Release] 放行已批但订单没有跟单人收件人；未完成通知交接', { requestId, orderId: notificationOrderId });
    }
    return ok(response);
  } catch (e: any) {
    // B39 / D52：try 内唯一业务写 = $transaction（:216，写全用 tx）；通知那段有自己的内层 try（:275-299）
    // 不会冒到这里 ⇒ 可以承诺"本次未确认任何改动"。
    logger.error('[Release] 放行签署失败', { requestId, error: e?.message });
    const known = knownReleaseFailure(e); if (known) return known;
    return fail('SIGN_FAILED', '放行签署未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该放行范围的签字与放行单。', 500);
  }
}

// ════════════════════════════════════════════════════════════════════
// 统一资格判定（§14.3：页面/生产 API/Agent 共用；执行前必须重验）
// ════════════════════════════════════════════════════════════════════

const canonicalSource = (value: any): any => Array.isArray(value) ? value.map(canonicalSource) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalSource(value[key])])) : value;
const sameSource = (left: unknown, right: unknown) => JSON.stringify(canonicalSource(left)) === JSON.stringify(canonicalSource(right));

async function lineSource(db: any, line: any): Promise<ConfirmedFabricSource> {
  if (line.confirmedSourceType || line.confirmedSourceId) return { type: line.confirmedSourceType ?? null, id: line.confirmedSourceId ?? null };
  // A real unique SKU link is usable; descriptions/product titles are not.
  const asset = line.materialCode ? await db.productAsset.findUnique({ where: { sku: line.materialCode }, select: { id: true } }) : null;
  return { type: asset ? 'Asset' : null, id: asset?.id ?? null };
}

async function scopeSourceReasons(db: any, scope: any, failedSources: FailedFabricSource[] = []): Promise<string[]> {
  {
    try { await readReleaseBatchBinding(db, scope); }
    catch (error) { if ((error instanceof ReleaseBatchBindingError || error instanceof ProductionBatchFactsError) && ['CONFLICT','INVALID_INPUT'].includes(error.code)) return [safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }).message]; throw error; }
  }
  const line = await db.orderLine.findUnique({ where: { id: scope.orderLineId } });
  if (!line || line.orderId !== scope.orderId) return ['放行范围的原订单行已不可用'];
  const order = await db.order.findFirst({ where: { id: scope.orderId, deletedAt: null } });
  if (!order) return ['原订单已不可用'];
  const lineConfirmed = await lineSource(db, line);
  const own: ConfirmedFabricSource = { type: scope.confirmedSourceType ?? null, id: scope.confirmedSourceId ?? null };
  if (!sameSource(own, lineConfirmed)) return ['放行范围与订单行当前确认来源不一致'];
  const source = own.type || own.id ? own : lineConfirmed;
  const reasons = deniedSourceReasons(failedSources, [own, lineConfirmed]);
  if (!sameSource(scope.specSnapshot ?? null, line.specSnapshot ?? null)) reasons.push('放行规格与订单行当前规格不一致');
  if (line.quantity != null && scope.quantity != null && (new Prisma.Decimal(scope.quantity).lte(0) || new Prisma.Decimal(scope.quantity).gt(line.quantity))) reasons.push('放行数量超出当前订单行范围');
  if (scope.unit && line.unit && scope.unit !== line.unit) reasons.push('放行数量单位与当前订单行不一致');
  try {
    await resolveGarmentMaterialProof(db, order, line);
    const current = await assertConfirmedFabricSourceEligible(db, source);
    if (source.type === 'Sample') assertFrozenSampleConsumerOrigin(current.sampleOriginProof ?? null, scope.specSnapshot?.sampleOriginProof);
    if (String(order.businessLine ?? order.type).toLowerCase() !== 'garment' && scope.factoryRelationId && current.factoryRelationId && scope.factoryRelationId !== current.factoryRelationId) reasons.push('放行工厂与当前确认成果工厂不一致');
  }
  catch (error) { if (!(error instanceof DevelopmentDomainError)) throw error; reasons.push(error.message); }
  return reasons;
}

function deniedSourceReasons(failed: FailedFabricSource[], sources: ConfirmedFabricSource[]): string[] {
  return [...new Set(failed.filter(failure => sources.some(source => source.type === failure.type && source.id === failure.id)).map(failure => failure.reason))];
}

type ReleaseLockOptions = { additionalSources?: ConfirmedFabricSource[]; evidenceSampleIds?: string[] };
type ReleaseSourceLocks = { failedSources: FailedFabricSource[] };
async function releaseSourceHints(tx: any, orderIds: string[], options: ReleaseLockOptions) {
  const orderId = orderIds.length === 1 ? orderIds[0] : { in: orderIds };
  const lines = await tx.orderLine.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
  const fullPackageLineIds = lines.filter((line: any) => line.fulfillmentMode === 'full_package').map((line: any) => line.id);
  const materials = fullPackageLineIds.length ? await tx.fabricLineAllocation.findMany({ where: { garmentOrderLineId: { in: fullPackageLineIds } }, orderBy: { id: 'asc' } }) : [];
  const scopes = await tx.releaseScope.findMany({ where: { orderId, deletedAt: null }, orderBy: { id: 'asc' } });
  const releaseIds = [...new Set<string>(scopes.map((scope: any) => scope.currentReleaseId).filter((id: any): id is string => Boolean(id)))].sort();
  const releases = releaseIds.length ? await tx.ppSampleRelease.findMany({ where: { id: { in: releaseIds } }, orderBy: { id: 'asc' } }) : [];
  const samples = [...new Set<string>([...releases.map((release: any) => release.sampleId), ...(options.evidenceSampleIds ?? [])].filter((id: any): id is string => Boolean(id)))].sort();
  const inputs = await Promise.all(lines.map((line: any) => lineSource(tx, line)));
  inputs.push(...scopes.map((scope: any) => ({ type: scope.confirmedSourceType ?? null, id: scope.confirmedSourceId ?? null })),
    ...samples.map(id => ({ type: 'Sample', id })), ...(options.additionalSources ?? []));
  const snapshot = {
    lines: lines.map((line: any) => [line.id, line.orderId, line.confirmedSourceType ?? null, line.confirmedSourceId ?? null, line.materialCode ?? null,
      line.specSnapshot ?? null, line.quantity == null ? null : String(line.quantity), line.unit ?? null]),
    scopes: scopes.map((scope: any) => [scope.id, scope.orderId, scope.orderLineId, scope.confirmedSourceType ?? null, scope.confirmedSourceId ?? null, scope.currentReleaseId ?? null, scope.scopeRevision]),
    releases: releases.map((release: any) => [release.id, release.scopeId, release.requestId, release.sampleId ?? null, release.sampleRound ?? null]),
    samples, inputs,
    materials: materials.map((row: any) => [row.id, row.revision, row.status, row.fabricOrderId, row.fabricOrderLineId, row.metres.toString(), row.auditId]),
  };
  return { lines, scopes, snapshot, inputs, materials };
}

/** One native parent set across all Orders avoids reacquiring a new development
 * parent after holding an Order during multi-order Sample invalidation. */
export async function lockReleaseSources(tx: any, orderIds: string[], options: ReleaseLockOptions = {}): Promise<ReleaseSourceLocks> {
  const sortedOrders = [...new Set(orderIds)].sort(), before = await releaseSourceHints(tx, sortedOrders, options);
  const failedSources = await lockConfirmedFabricSourcesIsolated(tx, before.inputs, { orderIds: [...new Set([...sortedOrders, ...before.materials.map((row: any) => row.fabricOrderId as string)])].sort() });
  for (const lineId of [...new Set<string>(before.materials.map((row: any) => row.fabricOrderLineId))].sort()) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${lineId} FOR UPDATE`);
  for (const line of before.lines) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "OrderLine" WHERE "id"=${line.id} FOR UPDATE`);
  for (const scope of before.scopes) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ReleaseScope" WHERE "id"=${scope.id} FOR UPDATE`);
  const after = await releaseSourceHints(tx, sortedOrders, options);
  if (!sameSource(before.snapshot, after.snapshot)) throw new DevelopmentDomainError('CONFLICT', '订单行、批准证据或放行来源在锁定时变化，请刷新重试');
  return { failedSources };
}

/** Write prelude only. Includes actual immutable release.sampleId and its
 * native parents; summaries are pure reads. Known malformed sources remain
 * denied individually while unrelated current sources are still locked. */
export async function lockOrderReleaseSources(tx: any, orderId: string, options: ReleaseLockOptions = {}): Promise<ReleaseSourceLocks> {
  return lockReleaseSources(tx, [orderId], options);
}

async function lockedReleaseScope(tx: any, scopeId: string, options: ReleaseLockOptions = {}) {
  const hint = await tx.releaseScope.findFirst({ where: { id: scopeId, deletedAt: null } });
  if (!hint) throw new ReleaseGateError('SCOPE_NOT_FOUND', '范围不存在', 404);
  const locks = await lockOrderReleaseSources(tx, hint.orderId, options);
  await lockReleaseBatchRows(tx, hint.orderId);
  const scope = await tx.releaseScope.findFirst({ where: { id: scopeId, deletedAt: null } });
  if (!scope) throw new ReleaseGateError('SCOPE_NOT_FOUND', '范围不存在', 404);
  if (scope.orderId !== hint.orderId) throw new DevelopmentDomainError('CONFLICT', '放行范围归属已变化，请刷新重试');
  return { scope, locks };
}

async function sampleOriginEvidenceReasons(db: any, sample: any, snapshot: any, actualScopeId?: string): Promise<string[]> {
  try {
    const native = sample.sourceOrderId ? await db.orderSampleSource.findUnique({ where: { sampleId: sample.id }, select: { id: true, family: true } }) : null;
    if (native || snapshot?.nativeOrderSampleProof) {
      if (!native || native.family !== 'garment_pp' || !actualScopeId || actualScopeId !== snapshot?.nativeOrderSampleScopeId || !snapshot?.nativeOrderSampleScopeId || snapshot.nativeOrderSampleProof?.source?.sampleId !== sample.id || snapshot.nativeOrderSampleProof?.source?.sourceId !== native.id)
        throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '订单产前样缺少对应放行范围的原生冻结依据。');
      const current = await resolveOrderSampleConsumerProof(db, { kind: 'release_scope', id: snapshot.nativeOrderSampleScopeId }, 'garment_pp', { sourceId: native.id });
      assertFrozenOrderSampleConsumerProof(current, snapshot.nativeOrderSampleProof);
      return [];
    }
    const current = await sampleConsumerOriginProof(db, sample);
    assertFrozenSampleConsumerOrigin(current, snapshot?.sampleOriginProof);
    return [];
  } catch (error) {
    if (!(error instanceof DevelopmentDomainError)) throw error;
    return [error.message];
  }
}

async function requestSampleReasons(db: any, snapshot: any, failedSources: FailedFabricSource[] = [], actualScopeId?: string): Promise<string[]> {
  const materialReasons: string[] = [];
  if (actualScopeId) {
    const scope = await db.releaseScope.findUnique({ where: { id: actualScopeId } });
    const order = scope ? await db.order.findFirst({ where: { id: scope.orderId, deletedAt: null } }) : null;
    const line = scope ? await db.orderLine.findUnique({ where: { id: scope.orderLineId } }) : null;
    if (order && line) try {
      const current = await resolveGarmentMaterialProof(db, order, line);
      if (current && orderSampleDigest(current) !== orderSampleDigest(snapshot?.materialProof ?? null)) materialReasons.push('批准冻结的内部材料依据已变化，请重新核对当前分配并送审。');
    } catch (error) { if (!(error instanceof DevelopmentDomainError)) throw error; materialReasons.push(error.message); }
  }
  if (!snapshot?.sampleId) return materialReasons;
  const reasons = [...materialReasons, ...deniedSourceReasons(failedSources, [{ type: 'Sample', id: String(snapshot.sampleId) }])];
  const sample = await db.sample.findFirst({ where: { id: String(snapshot.sampleId), deletedAt: null } });
  if (!sample) return [...reasons, '批准锁定的证据样品已不可用'];
  reasons.push(...await sampleOriginEvidenceReasons(db, sample, snapshot, actualScopeId));
  if (EVIDENCE_VOID_SAMPLE_STATUSES.includes(String(sample.status ?? ''))) reasons.push('批准锁定的证据样品已返修或拒绝，需重新确认后送审');
  if (snapshot.round != null && Number(sample.round) !== Number(snapshot.round)) reasons.push('批准锁定的证据样品轮次已变化，需重新确认后送审');
  return reasons;
}

function storageReleaseConflict(error: unknown): Result<never> | null {
  if ((error as { code?: string })?.code === 'P2034' || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010'
    && (error.meta?.code === '40001' || error.meta?.code === '40P01'))) {
    return fail('CONFLICT', '放行范围或来源正在变化，请保留原请求并刷新重试', 409);
  }
  return null;
}

/** Explicit write command, called with the above source/parent locks held.
 * Caller commits its blocked outcome instead of throwing and rolling back the
 * invalidation. Original PpSampleRelease and currentReleaseId remain history. */
export async function invalidateCurrentReleaseSourcesInTx(tx: any, orderId: string, actorId: string, failedSources: FailedFabricSource[] = []): Promise<{ invalidated: string[]; lineReasons: string[] }> {
  const invalidated: string[] = [], lineReasons: string[] = [];
  const lines = await tx.orderLine.findMany({ where: { orderId } });
  for (const line of lines) {
    const source = await lineSource(tx, line);
    lineReasons.push(...deniedSourceReasons(failedSources, [source]));
    try { await assertConfirmedFabricSourceEligible(tx, source); }
    catch (error) { if (!(error instanceof DevelopmentDomainError)) throw error; lineReasons.push(error.message); }
  }
  const scopes = await tx.releaseScope.findMany({ where: { orderId, deletedAt: null } });
  for (const scope of scopes) {
    const reasons = await scopeSourceReasons(tx, scope, failedSources);
    if (scope.currentReleaseId) {
      const release = await tx.ppSampleRelease.findUnique({ where: { id: scope.currentReleaseId } });
      if (release?.sampleId) reasons.push(...deniedSourceReasons(failedSources, [{ type: 'Sample', id: String(release.sampleId) }]));
    }
    if (!reasons.length || !['ready', 'paused'].includes(scope.state)) continue;
    await appendEventAndUpdateScope(tx, scope.id, 'invalidated', { actorId, releaseId: scope.currentReleaseId,
      reason: reasons.join('；'), state: 'invalidated' });
    await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:production:source-invalidate', operation: 'invalidate_release_source',
      targetType: 'ReleaseScope', targetId: scope.id, before: { state: scope.state, currentReleaseId: scope.currentReleaseId },
      after: { state: 'invalidated', currentReleaseId: scope.currentReleaseId, reasons }, ip: null });
    invalidated.push(scope.id);
  }
  return { invalidated, lineReasons };
}

export async function evaluateProductionRelease(params: { prisma: PrismaClient; scopeId: string }): Promise<Result<{
  scopeId: string; eligible: boolean; state: string; scopeRevision: number; releaseId: string | null; reasons: string[];
}>> {
  const { prisma, scopeId } = params;
  try {
  const scope = await (prisma as any).releaseScope.findFirst({ where: { id: scopeId, deletedAt: null } });
  if (!scope) return fail('SCOPE_NOT_FOUND', `放行范围 ${scopeId} 不存在`, 404);
  const reasons: string[] = [];
  if (scope.state !== 'ready') reasons.push(`范围未就绪（state=${scope.state}）`);
  if (!scope.currentReleaseId) reasons.push('无有效批准');
  if (scope.deletedAt) reasons.push('范围已删除');
  reasons.push(...await scopeSourceReasons(prisma, scope), ...await currentOrderMoqReasons(prisma,scope.orderId));

  // 兜底（§14.4）：即使 scope 未 invalidate，也要重验「批准锁定的样品证据」当前是否仍成立。
  //
  // 空窗修复（2026-09-13，P0-6）：原实现 **整体依赖 release.sampleRound != null**，且只比对 round。
  // 但「进入 revising」与「round+1」是两个**独立**动作——qc failed / 客户 needs_revision 只把
  // status 置为 revising，round 要后续 start 才 +1。在「已 revising 但 round 未变」的窗口内，
  // 一旦联动未覆盖（invalidateScopesBySample 只处理 state==='ready'，paused 范围被跳过，
  // 之后 resume 直接回 ready），兜底就完全失效 → 返修过的 PP 样仍判定可开裁投产（误放行）。
  //
  // 修法：把「证据是否仍成立」拆成可独立判定的层级，任一不成立即拒绝，且不再整体依赖 sampleRound：
  //  ① 证据样品查不到（已软删/不存在）→ 不可核验 → 拒绝（fail-closed；这正是兜底的职责，
  //     联动是 fail-open 的，见 sampleManageService 返修联动注释）
  //  ② 样品当前处于证据失效态（revising/rejected）→ 无论 round 是否变化，拒绝
  //  ③ round 可比对（release.sampleRound 非空）且已变化 → 拒绝（原逻辑保留）
  // Missing delegate/storage is a dependency failure, never evidence absence.
  if (scope.currentReleaseId) {
    const release = await (prisma as any).ppSampleRelease.findUnique({ where: { id: scope.currentReleaseId } });
    if (!release || release.scopeId !== scope.id || release.scopeRevision !== scope.scopeRevision) reasons.push('原放行批准与当前范围修订不匹配');
    let request: any = null;
    if (release) {
      request = await (prisma as any).releaseRequest.findUnique({ where: { id: release.requestId } });
      if (!request || request.scopeId !== scope.id || request.scopeRevision !== scope.scopeRevision || !sameSource(request.specSnapshot ?? null, scope.specSnapshot ?? null)) reasons.push('原批准的规格或请求依据与当前范围不一致');
      if (request && (!sameSource(request.evidenceSnapshot ?? null, release?.evidenceSnapshot ?? null)
        || release?.scopeId !== request.scopeId || release?.scopeRevision !== request.scopeRevision
        || request.state !== 'granted' || request.ruleVersion !== release?.ruleVersion)) {
        reasons.push('原放行请求与批准事实的样品证据或来源版本不一致，需重新核对原批准依据');
      }
      const evidence: any = release?.evidenceSnapshot;
      if ((release?.sampleId ?? null) !== (evidence?.sampleId ?? null)
        || (release?.sampleRound ?? null) !== (evidence?.round ?? null)) reasons.push('批准事实的样品指针或轮次与原冻结证据不一致');
    }
    if (scope.productionBatchId != null) {
      try { const binding = await readReleaseBatchBinding(prisma, scope); assertReleaseBatchProof(binding, release?.evidenceSnapshot); assertReleaseBatchProof(binding, request?.evidenceSnapshot); }
      catch (error) { if ((error instanceof ReleaseBatchBindingError || error instanceof ProductionBatchFactsError) && ['CONFLICT','INVALID_INPUT'].includes(error.code)) reasons.push(safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }).message); else throw error; }
    }
    const evidenceSampleId = release?.sampleId ? String(release.sampleId) : null;
    if (evidenceSampleId) {
      const sample = await (prisma as any).sample.findFirst({ where: { id: evidenceSampleId, deletedAt: null } });
      if (!sample) {
        reasons.push(`批准锁定的证据样品 ${evidenceSampleId} 已不可用（已删除或查不到），证据无法核验`);
      } else {
        reasons.push(...await sampleOriginEvidenceReasons(prisma, sample, release.evidenceSnapshot, scope.id));
        if (EVIDENCE_VOID_SAMPLE_STATUSES.includes(String(sample.status ?? ''))) {
          reasons.push(`样品证据已失效（当前状态 ${sample.status}，批准锁定 round ${release.sampleRound ?? '未记录'}，当前 round ${sample.round}），需重新确认/批准后再放行`);
        }
        if (release.sampleRound != null && Number(sample.round) !== Number(release.sampleRound)) {
          reasons.push(`样品已返修（批准锁定 round ${release.sampleRound}，当前 ${sample.round}），证据失效`);
        }
      }
    }
  }

  return ok({
    scopeId,
    eligible: scope.state === 'ready' && !!scope.currentReleaseId && !scope.deletedAt && reasons.length === 0,
    state: scope.state,
    scopeRevision: Number(scope.scopeRevision),
    releaseId: scope.currentReleaseId ?? null,
    reasons,
  });
  } catch (error) {
    logger.error('[Release] Current source eligibility unavailable', { scopeId, error });
    return fail('INTERNAL_ERROR', '当前放行依据暂时无法核验，请稍后重试；本次读取未改变原批准或范围', 500);
  }
}

/** 订单放行汇总（ready/partial/blocked；仅汇总展示，不替代范围判定） */
export async function summarizeOrderReleases(params: { prisma: PrismaClient; orderId: string }): Promise<Result<{
  total: number; ready: number; blocked: number; summary: 'ready' | 'partial' | 'blocked';
  historyTotal: number; hasScopeHistory: boolean; scopes: any[];
}>> {
  const { prisma, orderId } = params;
  const scopes = await (prisma as any).releaseScope.findMany({ where: { orderId, deletedAt: null } });
  let ready = 0, total = 0;
  const rows: any[] = [];
  for (const scope of scopes) {
    const category = await classifyReleaseScope(prisma, scope);
    rows.push({ ...scope, ...category });
    if (category.classification !== 'current') continue;
    total += 1;
    const current = await evaluateProductionRelease({ prisma, scopeId: scope.id });
    if (!current.ok) return current;
    if (current.data.eligible) ready += 1;
  }
  const summary = total === 0 ? 'blocked' : ready === total ? 'ready' : ready > 0 ? 'partial' : 'blocked';
  return ok({ total, ready, blocked: total - ready, summary, historyTotal: scopes.length - total,
    hasScopeHistory: scopes.length > 0, scopes: rows });
}

/**
 * DR-053 §14.6 影子对账：列出受影响在制订单，识别历史双签补证需求与放行差异。
 * 只读、不写库、不自动放行——供「先影子计算并列出受影响在制订单，完成补证和差异核对，
 * 再启用强制门禁」的迁移期治理使用。
 * 口径：
 *  - 在制订单 = productionStage.manufacturing(seq 8) 已推进（done/in_progress，即已开工）
 *  - 历史双签 = pp_sample_approved 的 signedByProduction ∧ signedByBusiness（保留为历史资料，
 *    不自动生成新有效批准，见 §14.6）
 *  - needsBackfill = 已开工但无任何 ReleaseScope 且已有历史双签（继续执行前须按行补证）
 *  - discrepancy = 已开工但 scope 汇总 blocked（返修/撤销/失效后资格不匹配执行事实）
 */
export async function listReleaseReconciliation(params: { prisma: PrismaClient; limit?: number; offset?: number }): Promise<Result<{
  total: number; inProduction: number; backfillRequired: number; discrepancies: number; items: any[];
}>> {
  const { prisma } = params;
  try {
    const limit = Math.min(Number(params.limit ?? 50) || 50, 200);
    const offset = Number(params.offset ?? 0) || 0;

    // 在制订单（manufacturing 已推进）
    const inProgressStages = await (prisma as any).productionStage.findMany({
      where: { stageKey: 'manufacturing', status: { in: ['done', 'in_progress'] } },
      select: { orderId: true, status: true, doneAt: true },
    });
    const orderIds = [...new Set(inProgressStages.map((s: any) => s.orderId))];
    if (orderIds.length === 0) return ok({ total: 0, inProduction: 0, backfillRequired: 0, discrepancies: 0, items: [] });

    const [orders, ppStages, scopeRows] = await Promise.all([
      (prisma as any).order.findMany({ where: { id: { in: orderIds }, deletedAt: null }, select: { id: true, poNumber: true, customer: true } }),
      (prisma as any).productionStage.findMany({ where: { stageKey: 'pp_sample_approved', orderId: { in: orderIds } }, select: { orderId: true, signedByProduction: true, signedByBusiness: true, status: true } }),
      (prisma as any).releaseScope.findMany({ where: { orderId: { in: orderIds }, deletedAt: null }, select: { id: true, orderId: true, state: true, orderLineId: true, productionBatchId: true } }),
    ]);
    const orderById = new Map(orders.map((o: any) => [o.id, o]));
    const ppByOrder = new Map(ppStages.map((s: any) => [s.orderId, s]));
    const scopesByOrder = new Map<string, any[]>();
    for (const sc of scopeRows) {
      const arr = scopesByOrder.get(sc.orderId) ?? [];
      arr.push(sc);
      scopesByOrder.set(sc.orderId, arr);
    }

    const items: any[] = [];
    let backfillRequired = 0;
    let discrepancies = 0;
    for (const st of inProgressStages) {
      const order: any = orderById.get(st.orderId);
      if (!order) continue;
      const pp: any = ppByOrder.get(st.orderId) ?? null;
      const scopes: any[] = scopesByOrder.get(st.orderId) ?? [];
      const historyInclusiveTotal = scopes.length;
      const current = await summarizeOrderReleases({ prisma, orderId: order.id });
      if (!current.ok) {
        if (current.error.status >= 500) throw businessError('AUTHORIZATION_UNAVAILABLE', '放行对账数据暂时无法核验，请稍后重试。');
        return current;
      }
      const total = current.data.total;
      const ready = current.data.ready;
      const summary = current.data.summary;
      const hasHistoricalDoubleSign = Boolean(pp?.signedByProduction && pp?.signedByBusiness);
      const needsBackfill = historyInclusiveTotal === 0 && hasHistoricalDoubleSign;
      const discrepancy = total > 0 && summary === 'blocked';
      if (needsBackfill) backfillRequired += 1;
      if (discrepancy) discrepancies += 1;
      items.push({
        orderId: order.id,
        poNumber: order.poNumber ?? null,
        customer: order.customer ?? null,
        manufacturingStatus: st.status,
        manufacturedAt: st.doneAt ? Number(st.doneAt) : null,
        scopeCount: total,
        historyTotal: current.data.historyTotal,
        ready,
        summary,
        hasHistoricalDoubleSign,
        ppStageStatus: pp?.status ?? null,
        needsBackfill,
        discrepancy,
        scopeIds: scopes.map((s: any) => s.id),
      });
    }

    const sorted = items.sort((a: any, b: any) => Number(a.manufacturedAt ?? 0) - Number(b.manufacturedAt ?? 0));
    const page = sorted.slice(offset, offset + limit);
    return ok({
      total: sorted.length,
      inProduction: sorted.length,
      backfillRequired,
      discrepancies,
      items: page,
    });
  } catch (error) {
    logger.error('[Release] Reconciliation read unavailable', { error });
    const unavailable = safeRouteError(businessError('AUTHORIZATION_UNAVAILABLE', '放行对账数据暂时无法核验，请稍后重试；本次读取未改变任何批准或范围。'), { fallbackCode: 'INTERNAL_ERROR' });
    return fail(unavailable.code, unavailable.message, unavailable.status);
  }
}

// ════════════════════════════════════════════════════════════════════
// 暂停 / 恢复 / 撤销（append-only；恢复仅限可恢复暂停且需重验）
// ════════════════════════════════════════════════════════════════════

export async function transitionRelease(params: {
  prisma: PrismaClient;
  scopeId: string;
  action: 'pause' | 'resume' | 'revoke';
  reason?: string;
  expectedScopeRevision?: number;
  actorId: string;
  trustedActor?: TokenPayload | null;
}): Promise<Result<{ scope: any }>> {
  const { prisma, scopeId, action, reason, expectedScopeRevision, actorId } = params;
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const hint = await tx.releaseScope.findFirst({ where: { id: scopeId, deletedAt: null } });
      if (!hint) throw new ReleaseGateError('SCOPE_NOT_FOUND', '范围不存在', 404);
      await authorizePublicRelease(tx, params, 'production:pp_release:admin', hint.orderId);
      const { scope } = await lockedReleaseScope(tx, scopeId);
      await authorizePublicRelease(tx, params, 'production:pp_release:admin', scope.orderId);
      if (expectedScopeRevision && Number(expectedScopeRevision) !== Number(scope.scopeRevision)) {
        throw new ReleaseGateError('SCOPE_REVISION_MISMATCH', '范围修订已变化，请刷新', 409);
      }
      const now = BigInt(Date.now());
      if (action === 'pause') {
        if (scope.state !== 'ready') throw new ReleaseGateError('INVALID_TRANSITION', `仅已放行范围可暂停（当前 ${scope.state}）`, 409);
        await appendEventAndUpdateScope(tx, scopeId, 'paused', { releaseId: scope.currentReleaseId, reason: reason ?? null, actorId, state: 'paused' });
      } else if (action === 'resume') {
        if (scope.state !== 'paused') throw new ReleaseGateError('INVALID_TRANSITION', `仅暂停范围可恢复（当前 ${scope.state}）`, 409);
        if (!scope.currentReleaseId) throw new ReleaseGateError('NO_RELEASE', '无批准可恢复', 409);
        const reasons = [...await scopeSourceReasons(tx, scope), ...await currentOrderMoqReasons(tx,scope.orderId)];
        if (reasons.length) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', reasons.join('；'), 409);
        const original = await tx.ppSampleRelease.findUnique({ where: { id: scope.currentReleaseId } });
        assertReleaseBatchProof(await readReleaseBatchBinding(tx, scope), original?.evidenceSnapshot);
        await appendEventAndUpdateScope(tx, scopeId, 'resumed', { releaseId: scope.currentReleaseId, reason: reason ?? null, actorId, state: 'ready' });
      } else if (action === 'revoke') {
        if (!['ready', 'paused'].includes(scope.state)) throw new ReleaseGateError('INVALID_TRANSITION', `仅已放行/暂停范围可撤销（当前 ${scope.state}）`, 409);
        await appendEventAndUpdateScope(tx, scopeId, 'revoked', { releaseId: scope.currentReleaseId, reason: reason ?? null, actorId, state: 'revoked', currentReleaseId: null });
      }
      const updated = await tx.releaseScope.findUnique({ where: { id: scopeId } });
      await authorizePublicRelease(tx, params, 'production:pp_release:admin', scope.orderId);
      return updated;
    });
    return ok({ scope: result });
  } catch (e: any) {
    // B39 / D52：try 内唯一写 = $transaction（:473）⇒ 可承诺零改动。
    logger.error('[Release] 放行状态变更失败', { scopeId, action, error: e?.message });
    const known = knownReleaseFailure(e); if (known) return known;
    return fail('TRANSITION_FAILED', '放行状态变更未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该放行范围的状态与事件流水。', 500);
  }
}

// ════════════════════════════════════════════════════════════════════
// 返修失效联动（§14.4：Sample revise / 证据失效 → invalidate 关联 scope）
// ════════════════════════════════════════════════════════════════════

export async function invalidateScopesBySample(params: {
  prisma: PrismaClient;
  sampleId: string;
  reason?: string;
  sourceKey?: string;
  actorId?: string;
}): Promise<Result<{ invalidated: number }>> {
  const { prisma, sampleId, reason, sourceKey, actorId } = params;
  try {
    const invalidated = await (prisma as any).$transaction(async (tx: any) => {
      if (sourceKey && await tx.releaseEvent.findFirst({ where: { sourceKey } })) return 0;
      // scopeId is non-nullable in the actual model; no invalid not:null filter.
      const releases = await tx.ppSampleRelease.findMany({ where: { sampleId }, select: { scopeId: true, id: true } });
      const scopeIds = [...new Set<string>(releases.map((release: any) => release.scopeId))].sort();
      if (!scopeIds.length) return 0;
      const hints = await tx.releaseScope.findMany({ where: { id: { in: scopeIds }, deletedAt: null }, orderBy: { id: 'asc' } });
      if (!hints.length) return 0;
      await lockReleaseSources(tx, hints.map((scope: any) => scope.orderId), { evidenceSampleIds: [sampleId] });
      if (sourceKey && await tx.releaseEvent.findFirst({ where: { sourceKey } })) return 0;
      let count = 0;
      for (const hint of hints) {
        const scope = await tx.releaseScope.findFirst({ where: { id: hint.id, deletedAt: null } });
        if (!scope) continue;
        if (scope.orderId !== hint.orderId) throw new DevelopmentDomainError('CONFLICT', '放行范围归属在锁定时变化，请刷新重试');
        if (scope.state !== 'ready') continue;
        const currentRelease = scope.currentReleaseId ? await tx.ppSampleRelease.findUnique({ where: { id: scope.currentReleaseId } }) : null;
        if (!currentRelease || currentRelease.scopeId !== scope.id || currentRelease.scopeRevision !== scope.scopeRevision) throw new ReleaseGateError('NO_RELEASE', '当前批准依据无法核验，失效联动未写入', 409);
        // Old approvals remain immutable history; only the actually current
        // evidence sample can invalidate this projection.
        if (currentRelease.sampleId !== sampleId) continue;
        await appendEventAndUpdateScope(tx, scope.id, 'invalidated', { releaseId: scope.currentReleaseId,
          reason: reason ? String(reason) : '样品返修/证据失效', actorId: actorId ? String(actorId) : null,
          sourceKey: sourceKey ? String(sourceKey) : null, state: 'invalidated', currentReleaseId: null });
        count++;
      }
      return count;
    });
    return ok({ invalidated });
  } catch (e: any) {
    // B39 / D52：try 内唯一写 = $transaction（:528）⇒ 可承诺零改动。
    logger.error('[Release] 失效联动失败', { sampleId, sourceKey, error: e?.message });
    const known = knownReleaseFailure(e); if (known) return known;
    return fail('INVALIDATE_FAILED', '失效联动未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该样品关联的放行范围与事件流水。', 500);
  }
}

// Read-only native request projection. No call to a writer, source lock,
// nested transaction or ready-only production qualification is permitted here.
export type ReleaseRequestActionContext = {
  request: { id: string; scopeId: string; scopeRevision: number; requestRevision: number; state: string; createdAt: string; updatedAt: string };
  scope: { id: string; orderId: string; orderLineId: string; scopeRevision: number; state: string; classification: 'current' | 'historical';
    quantity: string; unit: string; productionBatchId: string | null; productionBatchRevision: number | null };
  line: { id: string; orderId: string; label: string | null; quantity: string; unit: string };
  signer: { userId: string; displayName: string; department: string | null; positions: string[] };
  reviewContentFingerprint: string;
  reviewBasis: {
    orderReference: string;
    item: { itemNo: string | null; description: string | null; materialCode: string | null; quantity: string; unit: string | null;
      deliveryDate: string | null; exMillDate: string | null; styleNo: string | null; colorName: string | null };
    productionScope: { quantity: string; unit: string; batchCode: string | null; batchRevision: number | null };
    finalSpecification: unknown;
    sampleEvidence: { code: string | null; type: string | null; round: number | null; status: string | null;
      qcStatus: string | null; customerStatus: string | null; supplierName: string | null } | null;
  };
  allowedRoles: ReleaseRole[]; canSign: boolean; blockedReasons: string[];
};
const releaseSignScope = (role: ReleaseRole) => role === 'production'
  ? 'production:pp_release:production_sign' : 'production:pp_release:business_sign';

function releaseReviewFingerprint(input: { request: any; scope: any; line: any; order: any }): string {
  const { request, scope, line, order } = input;
  return releaseReadDigest({
    request: { id: request.id, requestRevision: request.requestRevision, scopeRevision: request.scopeRevision,
      ruleVersion: request.ruleVersion, state: request.state, evidenceSnapshot: request.evidenceSnapshot ?? null,
      specSnapshot: request.specSnapshot ?? null },
    scope: { id: scope.id, orderId: scope.orderId, orderLineId: scope.orderLineId, scopeRevision: scope.scopeRevision,
      state: scope.state, quantity: scope.quantity, unit: scope.unit ?? null, productionBatchId: scope.productionBatchId ?? null,
      productionBatchRevision: scope.productionBatchRevision ?? null, confirmedSourceType: scope.confirmedSourceType ?? null,
      confirmedSourceId: scope.confirmedSourceId ?? null, specSnapshot: scope.specSnapshot ?? null },
    order: { id: order.id, poNumber: order.poNumber ?? null },
    line: { id: line.id, orderId: line.orderId, lineNumber: line.lineNumber, itemNo: line.itemNo ?? null,
      materialCode: line.materialCode ?? null, description: line.description ?? null, width: line.width ?? null,
      exMillDate: line.exMillDate ?? null, deliveryDate: line.deliveryDate ?? null, quantity: line.quantity,
      unit: line.unit ?? null, styleNo: line.styleNo ?? null, colorName: line.colorName ?? null,
      specSnapshot: line.specSnapshot ?? null },
  });
}

function releaseReviewBasis(input: { request: any; scope: any; line: any; order: any }) {
  const { request, scope, line, order } = input;
  const evidence = request.evidenceSnapshot && typeof request.evidenceSnapshot === 'object' ? request.evidenceSnapshot as any : null;
  return {
    orderReference: typeof order.poNumber === 'string' && order.poNumber.trim() ? order.poNumber : order.id,
    item: { itemNo: line.itemNo ?? null, description: line.description ?? null, materialCode: line.materialCode ?? null,
      quantity: line.quantity.toString(), unit: line.unit ?? null, deliveryDate: line.deliveryDate ?? null,
      exMillDate: line.exMillDate ?? null, styleNo: line.styleNo ?? null, colorName: line.colorName ?? null },
    productionScope: { quantity: scope.quantity.toString(), unit: scope.unit ?? '',
      batchCode: evidence?.productionBatchBinding?.batchCode ?? null,
      batchRevision: scope.productionBatchRevision ?? null },
    finalSpecification: request.specSnapshot ?? null,
    sampleEvidence: evidence ? { code: evidence.code ?? null, type: evidence.type ?? null,
      round: Number.isSafeInteger(evidence.round) ? evidence.round : null, status: evidence.status ?? null,
      qcStatus: evidence.qcStatus ?? null, customerStatus: evidence.customerStatus ?? null,
      supplierName: evidence.supplierName ?? null } : null,
  };
}

async function releaseReadActor(tx: any, prior: TokenPayload | null | undefined) {
  if (!prior?.userId) throw businessError('UNAUTHORIZED', '请登录后查看原放行请求。');
  let actor: TokenPayload;
  try {
    const user = await loadUserWithRoles(tx, prior.userId);
    if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
    actor = await buildLoadedAuthTokenPayload(tx, user);
    (actor as any).currentSigner = {
      userId: actor.userId,
      displayName: actor.displayName?.trim() || actor.userId,
      department: user.primaryDepartment?.name ?? null,
      positions: [...new Set((user.roles ?? []).map((entry: any) => entry.role?.name)
        .filter((name: unknown): name is string => typeof name === 'string' && !!name.trim()))].sort(),
    };
  } catch (error) {
    if (error instanceof ReleaseGateError) throw error;
    throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验放行权限，请稍后重试。');
  }
  if (prior.permissionCeiling !== undefined) actor.permissionCeiling = [...prior.permissionCeiling];
  if (!RELEASE_ROLES.some(role => hasScope(actor, releaseSignScope(role)))) throw businessError('FORBIDDEN', '当前账号没有放行签署权限。');
  return actor;
}
async function releaseReadParent(tx: any, actor: TokenPayload, orderId: string) {
  const cap = RELEASE_ROLES.find(role => hasScope(actor, releaseSignScope(role)))!;
  try {
    const authorized = await currentReleaseActor(tx, actor, releaseSignScope(cap), orderId);
    if ((actor as any).currentSigner) (authorized as any).currentSigner = (actor as any).currentSigner;
    return authorized;
  }
  catch (error) {
    // Only this exact requested parent's missing/hidden boundary is normalized;
    // other source failures keep their original finite producer meaning.
    if (error instanceof ReleaseBatchBindingError && error.code === 'ORDER_NOT_FOUND') throw businessError('NOT_FOUND', '放行请求不存在或不在当前可查看范围。');
    throw error;
  }
}
/** tx-bound leaf for Dashboard and exact request reads. Minimal native context,
 * including the actual pending side(s), never full Order/cost/sample payloads. */
export async function readReleaseRequestActionContext(tx: any, prior: TokenPayload | null | undefined,
  requestId: string): Promise<ReleaseRequestActionContext> {
  let actor = await releaseReadActor(tx, prior);
  if (typeof requestId !== 'string' || !requestId.trim()) throw businessError('VALIDATION_FAILED', '须提供原放行请求编号。');
  const request = await tx.releaseRequest.findUnique({ where: { id: requestId } });
  if (!request) throw businessError('NOT_FOUND', '放行请求不存在或不在当前可查看范围。');
  const scope = await tx.releaseScope.findFirst({ where: { id: request.scopeId, deletedAt: null } });
  if (!scope) throw businessError('NOT_FOUND', '放行请求不存在或不在当前可查看范围。');
  actor = await releaseReadParent(tx, actor, scope.orderId);
  const line = await tx.orderLine.findUnique({ where: { id: scope.orderLineId } });
  if (!line || line.orderId !== scope.orderId) throw businessError('NOT_FOUND', '原放行订单行不存在。');
  const order = await tx.order.findFirst({ where: { id: scope.orderId, deletedAt: null }, select: { id: true, poNumber: true } });
  if (!order) throw businessError('NOT_FOUND', '原放行订单不存在。');
  const signatures = await tx.releaseSignature.findMany({ where: { requestId: request.id }, orderBy: { role: 'asc' }, select: { role: true } });
  const classification = await classifyReleaseScope(tx, scope);
  const reasons: string[] = [];
  if (request.state !== 'pending') reasons.push('原请求已结束，不能再次签署');
  if (classification.classification !== 'current') reasons.push(classification.historyReason || '该范围属于历史来源，不能用于当前签署');
  if (scope.scopeRevision !== request.scopeRevision) reasons.push('范围修订已变化，须核对原申请');
  if (['revoked', 'invalidated'].includes(scope.state)) reasons.push('原放行范围已退出当前适用状态');
  if (!sameSource(scope.specSnapshot ?? null, request.specSnapshot ?? null)) reasons.push('范围规格与原请求依据不一致');
  try { assertReleaseBatchProof(await readReleaseBatchBinding(tx, scope), request.evidenceSnapshot); }
  catch (error) {
    if (!(error instanceof ReleaseBatchBindingError || error instanceof ProductionBatchFactsError) || !['CONFLICT', 'INVALID_INPUT'].includes(error.code)) throw error;
    reasons.push(safeRouteError(error, { fallbackCode: 'INTERNAL_ERROR' }).message);
  }
  reasons.push(...await scopeSourceReasons(tx, scope), ...await currentOrderMoqReasons(tx,scope.orderId), ...await requestSampleReasons(tx, request.evidenceSnapshot, [], scope.id));
  // Read authority is live; request/body roles and previous token role claims
  // cannot select a side or grant broad Order/production read.
  actor = await releaseReadParent(tx, await releaseReadActor(tx, prior), scope.orderId);
  const reviewFacts = { request, scope, line, order };
  const signer = (actor as any).currentSigner;
  if (!signer?.userId || !Array.isArray(signer.positions)) throw businessError('AUTHORIZATION_UNAVAILABLE', '当前签署人身份暂时无法核验。');
  const leaderCanSign = isLeaderPrincipal([...(actor.roleIds ?? []), ...(actor.roles ?? [])]);
  if (request.state === 'pending' && !leaderCanSign) reasons.push('PP 样放行单签仅限当前业务领导、销售主管或老板');
  const allowedRoles = request.state === 'pending' && leaderCanSign ? RELEASE_ROLES.filter(role =>
    hasScope(actor, releaseSignScope(role)) && !signatures.some((row: any) => row.role === role)) : [];
  if (!allowedRoles.length && request.state === 'pending') reasons.push('当前可签署侧已签署或没有当前签署权限');
  return {
    request: { id: request.id, scopeId: request.scopeId, scopeRevision: request.scopeRevision, requestRevision: request.requestRevision,
      state: request.state, createdAt: String(request.createdAt), updatedAt: String(request.updatedAt) },
    scope: { id: scope.id, orderId: scope.orderId, orderLineId: scope.orderLineId, scopeRevision: scope.scopeRevision, state: scope.state,
      classification: classification.classification, quantity: scope.quantity.toString(), unit: scope.unit ?? '',
      productionBatchId: scope.productionBatchId ?? null, productionBatchRevision: scope.productionBatchRevision ?? null },
    line: { id: line.id, orderId: line.orderId, label: line.description ?? line.itemNo ?? null, quantity: line.quantity.toString(), unit: line.unit ?? '' },
    signer,
    reviewContentFingerprint: releaseReviewFingerprint(reviewFacts),
    reviewBasis: releaseReviewBasis(reviewFacts),
    allowedRoles, canSign: allowedRoles.length > 0 && reasons.length === 0, blockedReasons: [...new Set(reasons)],
  };
}
/** All current visible pending native requests; same-scope requests retain their
 * own IDs. The caller's complete readonly observation/pagination fence applies. */
export async function pendingReleaseRequestActions(tx: any, prior: TokenPayload) {
  const actor = await releaseReadActor(tx, prior), where = await freshOrderLineScope(tx, actor);
  const orders = await tx.order.findMany({ where: { deletedAt: null, AND: [where] }, select: { id: true } });
  if (!orders.length) return [];
  const scopes = await tx.releaseScope.findMany({ where: { deletedAt: null, orderId: { in: orders.map((row: any) => row.id) } }, select: { id: true } });
  if (!scopes.length) return [];
  const requests = await tx.releaseRequest.findMany({ where: { scopeId: { in: scopes.map((row: any) => row.id) }, state: 'pending' }, orderBy: { id: 'asc' } });
  const items: ReleaseRequestActionContext[] = [];
  for (const request of requests) items.push(await readReleaseRequestActionContext(tx, prior, request.id));
  return items;
}
function releaseReadDigest(value: unknown, collection = false): string {
  const normalized = (input: any, set = false): any => {
    if (input === undefined) return ['undefined'];
    if (typeof input === 'bigint') return ['bigint', String(input)];
    if (Prisma.Decimal.isDecimal(input)) return ['decimal', input.toString()];
    if (input instanceof Date) return ['date', input.toISOString()];
    if (Array.isArray(input)) {
      const rows = input.map(row => normalized(row));
      return set ? rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : rows;
    }
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key,
      normalized(input[key], ['roles', 'permissions', 'roleIds', 'departmentIds', 'permissionCeiling', 'salesRepIds'].includes(key))]));
    if (typeof input === 'number' && !Number.isFinite(input)) throw businessError('AUTHORIZATION_UNAVAILABLE', '放行读取依赖无法核验。');
    return input;
  };
  const result = normalized(value, collection);
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
/** Observe only actual readonly delegates. A source/grant/L2/width lookup fault
 * cannot be converted to an empty set, and this reader can never invoke a lock. */
function observedReleaseRead(tx: any) {
  let failed = false;
  const reads: string[] = [], methods = new Set(['findMany', 'findFirst', 'findUnique', 'count']);
  const client = new Proxy(tx, { get(target, key) {
    const delegate = Reflect.get(target, key);
    if (typeof key !== 'string') return delegate;
    if (key.startsWith('$')) return () => { throw businessError('AUTHORIZATION_UNAVAILABLE', '放行读取依赖无法核验。'); };
    if (!delegate || typeof delegate !== 'object') return delegate;
    return new Proxy(delegate, { get(model, method) {
      const native = Reflect.get(model, method);
      if (typeof method !== 'string' || typeof native !== 'function') return native;
      if (!methods.has(method)) return () => { throw businessError('AUTHORIZATION_UNAVAILABLE', '放行读取依赖无法核验。'); };
      return async (...args: any[]) => {
        try { const result = await Reflect.apply(native, model, args);
          reads.push(`${key}.${method}:${releaseReadDigest(result, method === 'findMany')}`); return result; }
        catch (error) { failed = true; throw error; }
      };
    } });
  } });
  return { client, stamp: () => {
    if (failed) throw businessError('AUTHORIZATION_UNAVAILABLE', '放行读取依赖无法核验。');
    return releaseReadDigest([...reads].sort());
  } };
}
/** Separate consistent reads plus a complete source/projection comparison.
 * This does not certify a signature; the unchanged original writer rechecks. */
export async function getReleaseRequestActionContext(params: { prisma: PrismaClient; trustedActor: TokenPayload | null; requestId: string })
  : Promise<Result<{ item: ReleaseRequestActionContext }>> {
  try {
    const read = () => params.prisma.$transaction(async tx => {
      const observed = observedReleaseRead(tx);
      const item = await readReleaseRequestActionContext(observed.client, params.trustedActor, params.requestId);
      return { item, source: observed.stamp(), result: releaseReadDigest(item) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const first = await read(), final = await read();
    if (first.source !== final.source || first.result !== final.result) throw businessError('AUTHORIZATION_UNAVAILABLE', '原放行来源或权限已变化，请刷新后核对。');
    return ok({ item: final.item });
  } catch (error) {
    const known = knownReleaseFailure(error); if (known) return known;
    const safe = safeRouteError(new Error(), { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '原放行请求暂时无法核验，请稍后重试。' });
    return fail(safe.code, safe.message, safe.status);
  }
}
export async function rejectReleaseRequest(params: {
  prisma: PrismaClient; requestId: string; role: string; actorId: string; trustedActor?: TokenPayload | null;
  rejectionReason?: unknown; requestedChanges?: unknown; confirmedReviewedContent?: boolean;
  expectedRequestRevision?: number; expectedScopeRevision?: number; reviewContentFingerprint?: string;
}): Promise<Result<{ request: any; rejected: true; notificationStatus: 'persisted' | 'already_persisted' }>> {
  const { prisma, requestId, role, actorId } = params;
  if (!(RELEASE_ROLES as readonly string[]).includes(role)) return fail('INVALID_ROLE', `驳回侧必须是 ${RELEASE_ROLES.join('|')}`, 400);
  if (!params.trustedActor?.userId) return fail('UNAUTHORIZED', '驳回放行请求需要可信的当前登录主体。', 401);
  if (params.confirmedReviewedContent !== true) return fail('REVIEW_CONFIRMATION_REQUIRED', '请先核对原放行依据并明确确认后再驳回。', 400);
  if (typeof params.rejectionReason !== 'string' || !params.rejectionReason.trim()
    || typeof params.requestedChanges !== 'string' || !params.requestedChanges.trim()) {
    return fail('VALIDATION_FAILED', '驳回理由和明确待修改内容均须填写。', 400);
  }
  const rejectionReason = params.rejectionReason.trim();
  const requestedChanges = params.requestedChanges.trim();
  if (!Number.isSafeInteger(params.expectedRequestRevision) || Number(params.expectedRequestRevision) < 1
    || !Number.isSafeInteger(params.expectedScopeRevision) || Number(params.expectedScopeRevision) < 1
    || typeof params.reviewContentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(params.reviewContentFingerprint)) {
    return fail('REVIEW_CONTENT_CHANGED', '原申请或范围依据尚未完成核对，请重新读取后再驳回。', 409);
  }
  const cap = releaseSignScope(role as ReleaseRole);
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      const hint = await tx.releaseRequest.findUnique({ where: { id: requestId } });
      if (!hint) throw new ReleaseGateError('REQUEST_NOT_FOUND', '放行请求不存在', 404);
      if (hint.state !== 'pending') throw new ReleaseGateError('REQUEST_NOT_PENDING', `请求已 ${hint.state}`, 409);
      const hintScope = await tx.releaseScope.findFirst({ where: { id: hint.scopeId, deletedAt: null } });
      if (!hintScope) throw new ReleaseGateError('SCOPE_NOT_FOUND', '范围不存在', 404);
      await authorizePublicRelease(tx, params, cap, hintScope.orderId, { leaderOnly: true });
      const sampleId = hint.evidenceSnapshot?.sampleId;
      const { scope, locks } = await lockedReleaseScope(tx, hint.scopeId, { evidenceSampleIds: sampleId ? [String(sampleId)] : [] });
      await authorizePublicRelease(tx, params, cap, scope.orderId, { leaderOnly: true });
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ReleaseRequest" WHERE "id"=${requestId} FOR UPDATE`);
      const request = await tx.releaseRequest.findUnique({ where: { id: requestId } });
      if (!request) throw new ReleaseGateError('REQUEST_NOT_FOUND', '放行请求不存在', 404);
      if (request.scopeId !== hint.scopeId || request.requestRevision !== hint.requestRevision
        || !sameSource(request.evidenceSnapshot, hint.evidenceSnapshot) || !sameSource(request.specSnapshot, hint.specSnapshot)) {
        throw new DevelopmentDomainError('CONFLICT', '原放行申请在锁定时变化，请刷新后重新核对');
      }
      if (request.state !== 'pending') throw new ReleaseGateError('REQUEST_NOT_PENDING', `请求已 ${request.state}`, 409);

      // Reuse the exact native review projection: order/line, frozen spec/sample
      // evidence, scope classification and current source gates are read again
      // while the same source→Order→Line→Scope→batch→Request lock chain is held.
      const reviewed = await readReleaseRequestActionContext(tx, params.trustedActor, requestId);
      if (reviewed.request.requestRevision !== params.expectedRequestRevision
        || reviewed.request.scopeRevision !== params.expectedScopeRevision
        || reviewed.scope.scopeRevision !== params.expectedScopeRevision
        || reviewed.reviewContentFingerprint !== params.reviewContentFingerprint) {
        throw new ReleaseGateError('REVIEW_CONTENT_CHANGED', '原申请、订单规格、样品证据或放行范围已变化，请重新读取并核对。', 409);
      }
      const remainingBlockers = reviewed.blockedReasons.filter(reason =>
        reason !== '当前可签署侧已签署或没有当前签署权限'
          && reason !== 'PP 样放行单签仅限当前业务领导、销售主管或老板');
      if (remainingBlockers.length) throw new ReleaseGateError('SCOPE_NOT_ACTIVE', '原放行依据当前不可用，请刷新并核对原订单、规格、样品和范围。', 409);

      const actor = await authorizePublicRelease(tx, params, cap, scope.orderId, { leaderOnly: true });
      if (!actor?.userId) throw new ReleaseGateError('UNAUTHORIZED', '驳回放行请求需要可信的当前登录主体。', 401);
      const now = BigInt(Date.now());
      const updated = await tx.releaseRequest.update({ where: { id: requestId }, data: {
        state: 'rejected', rejectedBy: actor.userId, rejectedAt: now,
        rejectionReason, requestedChanges, updatedAt: now,
      } });
      await writeRouteAuditLog({ prisma: tx, actorId: actor.userId, source: 'route:release:request', operation: 'reject_release_request',
        targetType: 'ReleaseRequest', targetId: requestId,
        before: { state: request.state, requestRevision: request.requestRevision, scopeRevision: request.scopeRevision },
        after: { state: 'rejected', requestRevision: request.requestRevision, scopeRevision: request.scopeRevision,
          rejectedBy: actor.userId, rejectedAt: now.toString(), rejectionReason, requestedChanges }, ip: null });

      const id = `ntf_pp_release_rejected_${requestId}`;
      const title = `订单 ${reviewed.reviewBasis.orderReference} 开裁放行申请已驳回`;
      const body = '原申请的驳回理由与待改内容已保存，请修改后重新提交。';
      const link = `/orders?id=${encodeURIComponent(scope.orderId)}&tab=production`;
      const metadata = { orderId: scope.orderId, scopeId: scope.id, releaseRequestId: requestId, decisionStatus: 'rejected' };
      const notification = await tx.notification.createMany({ data: [{ id, userId: request.createdBy,
        type: 'approval_decided', title, body, level: 'warning', link, metadata: metadata as Prisma.InputJsonValue }], skipDuplicates: true });
      return { request: updated, rejected: true as const,
        notificationStatus: notification.count > 0 ? 'persisted' as const : 'already_persisted' as const,
        notificationReceipt: { id, userId: request.createdBy, title, body, link, metadata, created: notification.count > 0 },
        orderId: scope.orderId };
    });
    const { notificationReceipt, orderId, ...response } = result as any;
    if (notificationReceipt?.created) {
      try {
        publishNotificationEvent({ type: 'approval_decided', title: notificationReceipt.title,
          body: notificationReceipt.body, level: 'warning', link: notificationReceipt.link,
          eventId: notificationReceipt.id, eventType: 'approval_decided',
          recipientIds: [notificationReceipt.userId], metadata: notificationReceipt.metadata });
      } catch (error: any) {
        logger.warn('[Release] 驳回已持久化；通知 SSE 投递失败，员工仍可从通知列表读取', { requestId, error: error?.message });
      }
    }
    return ok(response);
  } catch (error: any) {
    logger.error('[Release] 驳回放行请求失败', { requestId, error: error?.message });
    const known = knownReleaseFailure(error); if (known) return known;
    return fail('REJECT_FAILED', '驳回放行请求未能完成，本次未确认任何改动，请刷新原申请后重试。', 500);
  }
}

/** The original requester can read their saved rejection and frozen request
 * snapshots using current order-read permission and the live L2 order scope. */
export async function getReleaseRequestRejectionContext(params: {
  prisma: PrismaClient; trustedActor: TokenPayload | null; requestId: string;
}): Promise<Result<{ item: any }>> {
  try {
    if (!params.trustedActor?.userId) throw businessError('UNAUTHORIZED', '请登录后查看原放行驳回详情。');
    const item = await (params.prisma as any).$transaction(async (tx: any) => {
      let actor: TokenPayload;
      try {
        const user = await loadUserWithRoles(tx, params.trustedActor!.userId);
        if (!user || user.status !== 'active' || user.deletedAt != null) throw businessError('ACCOUNT_DISABLED', '当前账号不可用。');
        actor = await buildLoadedAuthTokenPayload(tx, user);
      } catch (error) {
        if (error instanceof ReleaseGateError) throw error;
        throw businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验驳回详情的读取权限，请稍后重试。');
      }
      if (params.trustedActor!.permissionCeiling !== undefined) actor.permissionCeiling = [...params.trustedActor!.permissionCeiling];
      if (!hasScope(actor, 'orders:read')) throw businessError('FORBIDDEN', '当前账号没有读取原订单驳回详情的权限。');
      const request = await tx.releaseRequest.findUnique({ where: { id: params.requestId } });
      if (!request || request.createdBy !== actor.userId) throw businessError('NOT_FOUND', '驳回详情不存在或当前不可查看。');
      if (request.state !== 'rejected') throw new ReleaseGateError('REQUEST_NOT_REJECTED', '原放行申请尚无驳回详情。', 409);
      const scope = await tx.releaseScope.findFirst({ where: { id: request.scopeId, deletedAt: null } });
      if (!scope) throw businessError('NOT_FOUND', '驳回详情不存在或当前不可查看。');
      const orderWhere = await freshOrderLineScope(tx, actor);
      const order = await tx.order.findFirst({ where: { id: scope.orderId, deletedAt: null, AND: [orderWhere] }, select: { id: true, poNumber: true } });
      const line = await tx.orderLine.findUnique({ where: { id: scope.orderLineId } });
      if (!order || !line || line.orderId !== order.id) throw businessError('NOT_FOUND', '驳回详情不存在或当前不可查看。');
      return {
        request: { id: request.id, state: request.state, createdBy: request.createdBy, scopeId: request.scopeId,
          requestRevision: request.requestRevision, scopeRevision: request.scopeRevision, ruleVersion: request.ruleVersion,
          createdAt: String(request.createdAt), rejectedBy: request.rejectedBy ?? null,
          rejectedAt: request.rejectedAt == null ? null : String(request.rejectedAt),
          rejectionReason: request.rejectionReason ?? null, requestedChanges: request.requestedChanges ?? null,
          specSnapshot: request.specSnapshot ?? null, evidenceSnapshot: request.evidenceSnapshot ?? null },
        scope: { id: scope.id, orderId: scope.orderId, orderLineId: scope.orderLineId, scopeRevision: scope.scopeRevision,
          state: scope.state, quantity: scope.quantity, unit: scope.unit ?? null },
        order: { id: order.id, poNumber: order.poNumber ?? null },
        line: { id: line.id, itemNo: line.itemNo ?? null, description: line.description ?? null,
          materialCode: line.materialCode ?? null, quantity: line.quantity, unit: line.unit ?? null,
          specSnapshot: line.specSnapshot ?? null },
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return ok({ item });
  } catch (error) {
    const known = knownReleaseFailure(error); if (known) return known;
    const safe = safeRouteError(new Error(), { fallbackCode: 'INTERNAL_ERROR', fallbackMessage: '原放行驳回详情暂时无法读取，请稍后重试。' });
    return fail(safe.code, safe.message, safe.status);
  }
}
