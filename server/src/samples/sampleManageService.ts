import { lockShipmentSampleOrders } from './sampleShipmentGateSource';
import { assertGenericSampleMutationAllowed, assertGenericOrderSampleCreationAllowed } from './orderSampleManagedGuard';
/**
 * sampleManageService.ts — 样品管理域（DR-052）统一样品对象服务
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/样品管理域设计.md
 *
 * 覆盖：Sample CRUD + 双状态机（设计确认 dev/seal / 生产确认 pp/top/ship/head/pioneer）
 *      + 复刻（fork：确认样封存 → 产前样）+ 产物级开票触点（invoiceId）。
 *
 * 状态机：
 *   设计确认（dev/seal）：draft → making → sent → confirmed → sealed（封样终态）
 *                         revising（sent→revising → start round+1）
 *   生产确认（pp/top/...）：draft → making → qc(QC 通过) → submitted(客户) → confirmed → approved
 *                         rejected（客户不通过）/ needs_revision（→ revise 开新轮）
 *  - 产前样 approved = 开裁前置（生产放行门禁消费，语义对齐 DR-052 §4/§7）。
 *  - 所有 mutation 写审计（writeRouteAuditLog 同事务，fail closed）。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { createInvoice } from '../finance/invoiceMutationService';
import { invalidateScopesBySample } from '../production/releaseService';
import { logger } from '../lib/logger';
import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { garmentPpSampleFact, exactGarmentAssetForRound } from '../development/garmentSourceBindingService';
import { assertSampleBusinessContext, lockSampleBusinessSources, resolveSampleBusinessContext, resolveSampleBusinessContexts, SampleBusinessContext } from './sampleBusinessContext';
import { assertSampleOriginIdentity, assertSampleOriginMetadata, bindSampleOrigins, cloneSampleOrigins, loadSampleOriginCommand, loadSealSampleOriginCommand, lockSampleOriginParents, readSampleOriginContexts, sampleOriginLockHints, sampleProjectionKey, snapshotSampleOrigin, snapshotSealedGarmentOrigin, type SampleOriginCommand, type SampleSealOriginCommand } from './sampleOriginService';
import { assertNativeGarmentRound } from '../development/garmentNativeSourceEvidence';
import type { TokenPayload } from '../auth/service';
import { assertFabricCurrentWrite } from '../development/fabricBatchHistory';
import { assertGarmentSourceAccess } from '../development/garmentSourceBindingService';
import { exactJsonValue } from '../lib/exactJsonValue';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────────
// 常量与类型
// ────────────────────────────────────────────────────────────────────

export const SAMPLE_TYPES = ['dev', 'seal', 'pp', 'top', 'ship', 'head', 'pioneer'] as const;
export type SampleType = typeof SAMPLE_TYPES[number];

/** 设计确认样品：dev(开发样) / seal(确认样·封样) */
export const DESIGN_TYPES: readonly SampleType[] = ['dev', 'seal'];
/** 生产确认样品：pp(产前样) / top(大货样) / ship(船样) / head(匹头样) / pioneer(先锋样) */
export const PRODUCTION_TYPES: readonly SampleType[] = ['pp', 'top', 'ship', 'head', 'pioneer'];

export const SAMPLE_STATUSES = ['draft', 'making', 'sent', 'confirmed', 'sealed', 'qc', 'submitted', 'approved', 'rejected', 'revising'] as const;
export type SampleStatus = typeof SAMPLE_STATUSES[number];

export type SampleAction = 'start' | 'send' | 'confirm' | 'seal' | 'qc' | 'submit' | 'approve' | 'revise';

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });
const ok = <T>(data: T): Result<T> => ({ ok: true, data });

function assertType(value: unknown): SampleType {
  const s = String(value ?? '');
  if (!(SAMPLE_TYPES as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`非法样品类型 ${s}（可选 ${SAMPLE_TYPES.join(' | ')}）`), { code: 'INVALID_INPUT' , statusCode: 400 });
  }
  return s as SampleType;
}
function assertStatus(value: unknown): SampleStatus {
  const s = String(value ?? '');
  if (!(SAMPLE_STATUSES as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`非法状态 ${s}（可选 ${SAMPLE_STATUSES.join(' | ')}）`), { code: 'INVALID_INPUT' , statusCode: 400 });
  }
  return s as SampleStatus;
}
function str(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s || null;
}

function ser(v: any): any {
  return v == null ? v : Number(v);
}
function serializeSample(s: any, businessContext?: SampleBusinessContext) {
  return {
    ...s,
    ...(businessContext ? { businessContext } : {}),
    approvedAt: s.approvedAt ? ser(s.approvedAt) : null,
    createdAt: ser(s.createdAt),
    updatedAt: ser(s.updatedAt),
    deletedAt: s.deletedAt ? ser(s.deletedAt) : null,
  };
}

const sourceSnapshot = (sample: any) => JSON.stringify([sample.sourceCaseId ?? null, sample.sourceOrderId ?? null, sample.productAssetId ?? null]);
const businessFailure = (error: any): Result<never> | null => (['SAMPLE_BUSINESS_CONFLICT', 'SAMPLE_BUSINESS_UNRESOLVED'].includes(error?.code) || error instanceof DevelopmentDomainError && error.code === 'DEVELOPMENT_SOURCE_CHANGED')
  ? fail(error.code, error.message, 409) : null;
function assertSameSampleBusinessLine(original: SampleBusinessContext, proposed: SampleBusinessContext): void {
  if (original.status === 'resolved' && proposed.status === 'resolved' && original.businessLine !== proposed.businessLine) {
    throw Object.assign(new Error('不能通过编辑档案或复刻将样品转换到另一条业务线，请保留原样品来源并核对业务关系。'), { code: 'SAMPLE_BUSINESS_CONFLICT', statusCode: 409 });
  }
}

/** 动作 → (允许的前置状态 → 目标状态)；revising→start 时 round+1 */
const DESIGN_ACTIONS: Record<Exclude<SampleAction, 'qc' | 'submit' | 'approve'>, { from: SampleStatus[]; to: SampleStatus }> = {
  start: { from: ['draft', 'revising'], to: 'making' },
  send: { from: ['making'], to: 'sent' },
  confirm: { from: ['sent'], to: 'confirmed' },
  seal: { from: ['confirmed'], to: 'sealed' },
  revise: { from: ['sent'], to: 'revising' },
};
const PRODUCTION_ACTIONS: Record<SampleAction, { from: SampleStatus[]; to: SampleStatus }> = {
  start: { from: ['draft', 'revising'], to: 'making' },
  qc: { from: ['making', 'qc'], to: 'qc' },
  submit: { from: ['qc'], to: 'submitted' },
  confirm: { from: ['submitted'], to: 'confirmed' },
  approve: { from: ['confirmed'], to: 'approved' },
  // §10.3 封样口径（业务方 2026-09-12）：批准（approved）后才可封样留底；生产五类统一提供
  seal: { from: ['approved'], to: 'sealed' },
  send: { from: ['making'], to: 'making' }, // 占位（生产确认样品寄送在 submit 登记）
  revise: { from: ['making', 'qc', 'submitted'], to: 'revising' },
};

function genId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
async function genCode(db: any): Promise<string> {
  return nextBusinessNumber(db, 'SM', undefined, {
    occupied: async (code) => !!(await db.sample.findFirst({ where: { code }, select: { id: true } })),
  });
}

function actionRule(type: SampleType, action: SampleAction) {
  if (DESIGN_TYPES.includes(type)) {
    if (action === 'qc' || action === 'submit' || action === 'approve') return null;
    return DESIGN_ACTIONS[action as keyof typeof DESIGN_ACTIONS] ?? null;
  }
  return PRODUCTION_ACTIONS[action as keyof typeof PRODUCTION_ACTIONS] ?? null;
}

async function findLiveSample(prisma: PrismaClient, id: string) {
  return prisma.sample.findFirst({ where: { id, deletedAt: null } });
}

// ────────────────────────────────────────────────────────────────────
// 生产确认样品承接（DR-052 §10 #1 写通）：成衣 DR-008 产前样封存 → Sample(pp)
// ────────────────────────────────────────────────────────────────────

/** Each native sealed batch/round owns one immutable PP output. A later
 * round never overwrites earlier physical Samples, cards, finance or loans. */
export async function upsertPpSampleFromSealedRound(params: {
  prisma: any; devCase: any; round: any; sealedAt: number; sealedBy: string; actorId?: string;
}): Promise<{ sample: any }> {
  const { prisma, devCase, round, sealedAt, sealedBy, actorId = 'api' } = params;
  const native = await prisma.sampleBatch.findFirst({ where: { id: round.id, developmentCaseId: devCase.id, sampleType: 'garment-round', deletedAt: null } });
  if (!native || native.round !== round.round || native.attachments?.sealedRoundStatus !== 'sealed'
    || !native.sampleVersionId && (native.status !== 'approved' || native.qcStatus !== 'passed')) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '封样必须对应当前已通过双门禁的实际轮次');
  if (native.sampleVersionId) await assertNativeGarmentRound(prisma, native, true);
  const selectedVersionId = native.sampleVersionId ? native.attachments.sealedVersionId : undefined;
  const projectionKey = sampleProjectionKey('garment_pp', round.id, round.round, selectedVersionId);
  const frozen = native.sampleVersionId ? snapshotSealedGarmentOrigin(native, devCase) : snapshotSampleOrigin(native, devCase);
  const existing = await prisma.sample.findUnique({ where: { projectionKey } });
  if (existing) {
    if (existing.deletedAt != null || existing.type !== 'pp' || existing.sourceCaseId !== devCase.id || existing.sourceOrderId) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '原生封样投影的实物身份已失效，不能恢复或替换');
    const [priorOrigin] = await readSampleOriginContexts(prisma, [existing]);
    if (priorOrigin.status !== 'resolved' || priorOrigin.origins.length !== 1
      || priorOrigin.origins[0].sampleBatchId !== native.id || priorOrigin.origins[0].sourceRound !== native.round
      || priorOrigin.origins[0].sourceSealId || !['native','recorded_exact'].includes(priorOrigin.origins[0].provenance)) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '已有原生投影缺少准确的原批次身份，不能补造来源');
    // Same key with changed content is refused; metadata/status changes alone
    // never create a second output or reset existing approval/inventory facts.
    await bindSampleOrigins(prisma, existing, [frozen], actorId);
    const businessContext = await resolveSampleBusinessContext(prisma, existing);
    if (businessContext.status !== 'resolved' || businessContext.businessLine !== 'garment') throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '原生封样实物的业务来源有冲突，不能覆盖或恢复');
    return { sample: { ...existing, businessContext } };
  }
  let exactAssetId: string | null;
  if (selectedVersionId) {
    const assets = await prisma.productAsset.findMany({ where: { sourceDevelopmentCaseId: devCase.id,
      sourceSampleVersionId: selectedVersionId, sourceSampleBatchId: native.id, mainCategory: 'Garment', deletedAt: null }, orderBy: { id: 'asc' } });
    if (assets.length > 1) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '准确封样版本关联多个档案，请核对原成果');
    exactAssetId = assets[0]?.id ?? null;
  } else exactAssetId = await exactGarmentAssetForRound(prisma, devCase, round, devCase.productAssetId);
  const projectedSources = { sourceCaseId: devCase.id, sourceOrderId: null, productAssetId: exactAssetId };
  const businessContext = await resolveSampleBusinessContext(prisma, projectedSources, { lockSources: true });
  if (businessContext.status !== 'resolved' || businessContext.businessLine !== 'garment') throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '封存产前样的开发案或档案成衣来源尚未一致，请核对后再封存。');
  const now = BigInt(sealedAt);
  const sample = await prisma.sample.create({ data: { id: genId('SMP'), code: await genCode(prisma), projectionKey,
    type: 'pp', sourceCaseId: devCase.id, productAssetId: exactAssetId,
    supplierRelationId: native.supplierRelationId, supplierName: native.supplierName ?? null,
    customerRelationId: devCase.customerRelationId ?? null, status: 'approved', round: native.round,
    approvedAt: now, approvedBy: sealedBy, notes: `封存产前样 ${round.version ?? ''}（第 ${native.round} 轮）`, createdAt: now, updatedAt: now } });
  await bindSampleOrigins(prisma, sample, [frozen], actorId);
  await writeRouteAuditLog({ prisma, actorId, source: 'route:samples:garment-gate', operation: 'sync_pp_sample_create', targetType: 'Sample', targetId: sample.id,
    after: { code: sample.code, type: 'pp', status: 'approved', sourceCaseId: devCase.id, round: native.round,
      projectionKey, sourceRoundId: native.id, sampleId: sample.id, sampleFact: garmentPpSampleFact(sample) } });
  return { sample: { ...sample, businessContext } };
}

/** Pre-discover every origin parent, lock all kinds in the shared order, then
 * reject changed hints rather than acquiring newly found Batch after Sample. */
async function lockOriginsAndBusinessSources(tx: any, samples: any[]): Promise<void> {
  const sampleIds = samples.filter(s => s.id).map(s => s.id);
  const before = await sampleOriginLockHints(tx, sampleIds);
  const hints = { ...before, caseIds: [...new Set([...before.caseIds, ...samples.map(s => s.sourceCaseId).filter(Boolean)])].sort() };
  await lockSampleOriginParents(tx, hints);
  await lockSampleBusinessSources(tx, samples);
  if (JSON.stringify(await sampleOriginLockHints(tx, sampleIds)) !== JSON.stringify(before)) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '样品精确来源已变化，请重新读取后操作');
}

// ────────────────────────────────────────────────────────────────────
// CRUD
// ────────────────────────────────────────────────────────────────────

export async function listSamples(prisma: PrismaClient, query: {
  type?: string;
  status?: string;
  sourceCaseId?: unknown;
  sourceOrderId?: string;
  supplier?: string;
  search?: string;
  scope?: unknown;
  limit?: unknown;
  offset?: unknown;
}): Promise<Result<{ samples: any[]; total: number; scope?: 'fabric' | 'garment' | 'review'; sourceCaseId?: string }>> {
  const scope = query.scope;
  if (scope !== undefined && !['fabric','garment','review'].includes(scope as string)) return fail('INVALID_INPUT', '样品工作区须为 fabric、garment 或 review。', 400);
  const sourceCaseId = query.sourceCaseId;
  if (sourceCaseId !== undefined && (typeof sourceCaseId !== 'string' || !sourceCaseId.trim() || sourceCaseId.trim() !== sourceCaseId)) {
    return fail('INVALID_INPUT', 'sourceCaseId 须为非空的开发案 ID。', 400);
  }
  const pageNumber = (value: unknown, fallback: number): number | null => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  };
  const limit = pageNumber(query.limit, 50), offset = pageNumber(query.offset, 0);
  if (limit === null || limit > 200 || offset === null) return fail('INVALID_INPUT', 'limit 须为 0–200 的整数，offset 须为非负安全整数。', 400);
  const where: any = { deletedAt: null };
  if (query.type) where.type = String(query.type);
  if (query.status) where.status = String(query.status);
  if (sourceCaseId !== undefined) where.sourceCaseId = sourceCaseId;
  if (query.sourceOrderId) where.sourceOrderId = String(query.sourceOrderId);
  if (query.supplier) where.supplierRelationId = String(query.supplier);
  if (query.search) {
    where.OR = [
      { code: { contains: String(query.search), mode: 'insensitive' } },
      { subType: { contains: String(query.search), mode: 'insensitive' } },
      { notes: { contains: String(query.search), mode: 'insensitive' } },
    ];
  }
  // Classification/count/page/source readback share one stable MVCC snapshot.
  // Scoped lists scan N matching anchors in chunks: O(N) time, O(200 + page)
  // memory. No lane is persisted or inferred from a stage, name or origin tag.
  return (prisma as any).$transaction(async (tx: any) => {
    const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
    let rows: any[], total: number, contexts: SampleBusinessContext[];
    if (scope === undefined) {
      [rows, total] = await Promise.all([
        limit ? tx.sample.findMany({ where, orderBy, take: limit, skip: offset }) : [],
        tx.sample.count({ where }),
      ]);
      contexts = await resolveSampleBusinessContexts(tx, rows);
    } else {
      total = 0;
      const selectedIds: string[] = [], selectedContexts: SampleBusinessContext[] = [];
      let cursor: string | undefined;
      while (true) {
        const candidates = await tx.sample.findMany({ where, orderBy, take: 200,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, createdAt: true, sourceCaseId: true, sourceOrderId: true, productAssetId: true },
        });
        if (!candidates.length) break;
        const resolved = await resolveSampleBusinessContexts(tx, candidates);
        for (let index = 0; index < candidates.length; index++) {
          const context = resolved[index];
          const belongs = scope === 'review' ? context.status !== 'resolved' : context.status === 'resolved' && context.businessLine === scope;
          if (!belongs) continue;
          if (total >= offset && selectedIds.length < limit) { selectedIds.push(candidates[index].id); selectedContexts.push(context); }
          total++;
        }
        cursor = candidates[candidates.length - 1].id;
        if (candidates.length < 200) break;
      }
      rows = selectedIds.length ? await tx.sample.findMany({ where: { id: { in: selectedIds }, deletedAt: null }, orderBy }) : [];
      const byId = new Map<string, any>(rows.map(row => [row.id, row]));
      if (selectedIds.some(id => !byId.has(id))) throw new Error('样品列表快照中的原记录未能读回');
      rows = selectedIds.map(id => byId.get(id));
      contexts = selectedContexts;
    }
    const origins = await readSampleOriginContexts(tx, rows);
    return ok({ samples: rows.map((sample, index) => ({ ...serializeSample(sample, contexts[index]), sourceContext: origins[index] })), total,
      ...(scope !== undefined ? { scope: scope as 'fabric' | 'garment' | 'review' } : {}),
      ...(sourceCaseId !== undefined ? { sourceCaseId: sourceCaseId as string } : {}),
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 30000 });
}

export async function getSample(prisma: PrismaClient, id: string): Promise<Result<{ sample: any }>> {
  const row = await findLiveSample(prisma, id);
  if (!row) return fail('NOT_FOUND', `样品 ${id} 不存在`, 404);
  const [businessContext, originContexts] = await Promise.all([resolveSampleBusinessContext(prisma, row), readSampleOriginContexts(prisma, [row])]);
  return ok({ sample: { ...serializeSample(row, businessContext), sourceContext: originContexts[0] } });
}

/** 登记样品（可先登记再推进；type 必填，其余渐进披露） */
export type CreateSampleParams = {
  prisma: PrismaClient;
  input: {
    type: string;
    subType?: string;
    sourceCaseId?: string;
    sourceOrderId?: string;
    productAssetId?: string;
    supplierRelationId?: string;
    supplierName?: string;
    customerRelationId?: string;
    status?: string;
    notes?: string;
    // DR-054 阶段 G：大货生产样明细（ship/head/pioneer）——sampleQuantity/sampleUnit/batchNo/rollNos/cuttingDate/productionStage/producedMeterage/millName
    attachments?: Record<string, any>;
    origin?: SampleOriginCommand;
    sealOrigin?: SampleSealOriginCommand;
  };
  trustedActor?: TokenPayload;
  actorId: string;
  ip?: string | null;
};

/** Native producer kernel: caller owns the transaction; approval/inventory are unchanged. */
export async function createSampleInTx(tx: any, params: Omit<CreateSampleParams, 'prisma'>, options: { sampleId?: string; auditAnchor?: { transactionId?: string; registrationRequest?: Record<string, unknown> } } = {}) {
  const { input, actorId, ip } = params;
  if (['registrationVersion','requestKey','expectedCaseUpdatedAt','expectedCaseContentFingerprint','projectionKey','sourceBindings','sourceSnapshot','sourceFingerprint'].some(key => (input as any)?.[key] !== undefined)) throw new DevelopmentDomainError('INVALID_INPUT', '精确登记协议须使用专用入口；样品来源身份与证明由服务端生成，不能手工指定。');
  const type = assertType(input?.type);
  assertGenericOrderSampleCreationAllowed(input);
  const status = input?.status ? assertStatus(input.status) : 'draft';
  // Public registration never substitutes for workflow QC/customer approval.
  if (status !== 'draft') throw new DevelopmentDomainError('INVALID_INPUT', '新样品须从草稿登记，再通过对应业务流程推进状态。');
  const now = BigInt(Date.now());
  const caseId = str(input?.sourceCaseId);
  if (caseId && DESIGN_TYPES.includes(type)) {
    await assertDevelopmentOperationalWrite(tx, caseId, 'sample');
  } else if (caseId) {
    const cases = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!cases.length) throw Object.assign(new Error('来源开发案不存在'), { code: 'NOT_FOUND' , statusCode: 404 });
  }
  if (input.origin && input.sealOrigin) throw new DevelopmentDomainError('INVALID_INPUT', '批次与组合封样来源请明确选择一种');
  let sealOrigin: Awaited<ReturnType<typeof loadSealSampleOriginCommand>> | null = null;
  if (input.sealOrigin) {
    if (!caseId) throw new DevelopmentDomainError('INVALID_INPUT', '组合封样登记须明确开发案');
    await assertFabricCurrentWrite(tx, caseId, actorId, params.trustedActor);
    sealOrigin = await loadSealSampleOriginCommand(tx, caseId, input.sealOrigin);
    if (str(input.supplierRelationId) && str(input.supplierRelationId) !== sealOrigin.factoryId) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '实物工厂与组合封样不同');
  }
  let exactOrigin: Awaited<ReturnType<typeof loadSampleOriginCommand>> | null = null;
  if (input.origin) {
    if (!caseId) throw new DevelopmentDomainError('INVALID_INPUT', '精确来源登记须明确开发案');
    exactOrigin = await loadSampleOriginCommand(tx, caseId, input.origin);
    if (exactOrigin.development.type === 'fabric') await assertFabricCurrentWrite(tx, caseId, actorId, params.trustedActor);
    else await assertGarmentSourceAccess(tx, params.trustedActor, caseId);
    if (str(input.supplierRelationId) && str(input.supplierRelationId) !== exactOrigin.batch.supplierRelationId) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '登记工厂与来源批次不同');
  }
  if (type === 'ship') await lockShipmentSampleOrders(tx, [str(input?.sourceOrderId)]);
  const businessContext = await resolveSampleBusinessContext(tx, input, { lockSources: true });
  const hasSource = !!(str(input?.sourceCaseId) || str(input?.sourceOrderId) || str(input?.productAssetId));
  const hasFacts = input.attachments != null && Object.keys(input.attachments).length > 0;
  assertSampleBusinessContext(businessContext, !hasSource && !hasFacts);
  const created = await tx.sample.create({
    data: {
      id: options.sampleId ?? genId('SMP'),
      projectionKey: null,
      code: await genCode(tx),
      type,
      subType: str(input?.subType),
      sourceCaseId: str(input?.sourceCaseId),
      sourceOrderId: str(input?.sourceOrderId),
      productAssetId: str(input?.productAssetId),
      supplierRelationId: exactOrigin?.batch.supplierRelationId ?? sealOrigin?.factoryId ?? str(input?.supplierRelationId),
      supplierName: str(input?.supplierName),
      customerRelationId: str(input?.customerRelationId),
      status,
      round: 1,
      attachments: input?.attachments && typeof input.attachments === 'object' ? input.attachments : undefined,
      notes: str(input?.notes),
      createdAt: now,
      updatedAt: now,
    },
  });
  if (exactOrigin) await bindSampleOrigins(tx, created, [exactOrigin.snapshot], actorId, options.auditAnchor);
  if (sealOrigin) await bindSampleOrigins(tx, created, sealOrigin.snapshots, actorId, { sourceSealId: sealOrigin.seal.id, ...options.auditAnchor });
  const createAuditId = await writeRouteAuditLog({
    prisma: tx, actorId, source: 'route:samples:manage', operation: 'create_sample',
    targetType: 'Sample', targetId: created.id,
    after: { code: created.code, type, status, ...(options.auditAnchor?.registrationRequest ? {
      registrationRequest: options.auditAnchor.registrationRequest, registrationSampleFact: exactJsonValue({ ...created, businessContext }),
    } : {}) },
    transactionId: options.auditAnchor?.transactionId ?? null,
    ip: ip ?? null,
  });
  return { sample: { ...created, businessContext }, createAuditId };
}

export async function createSample(params: CreateSampleParams): Promise<Result<{ sample: any }>> {
  const { prisma, input, actorId } = params;
  try {
    const made = await (prisma as any).$transaction((tx: any) => createSampleInTx(tx, params));
    return ok({ sample: serializeSample(made.sample) });
  } catch (e: any) {
    const sourceFailure = businessFailure(e); if (sourceFailure) return sourceFailure;
    if (e?.code === 'NOT_FOUND') return fail(e.code, e.message, 404);
    if (e instanceof DevelopmentDomainError && ['FORBIDDEN','UNAUTHORIZED','AUTHORIZATION_UNAVAILABLE','DEVELOPMENT_NOT_ACCESSIBLE'].includes(e.code)) return fail(e.code, e.message, e.status);
    if (['DEVELOPMENT_PAUSED', 'DEVELOPMENT_CLOSED', 'INVALID_LIFECYCLE_STATE'].includes(e?.code)) return fail(e.code, e.message, 409);
    if (e?.code === 'INVALID_INPUT') return fail('INVALID_INPUT', e.message, 400);
    logger.error('[SampleManage] create failed', { type: input?.type, actorId, error: e?.message ?? e });
    return fail('SAMPLE_CREATE_FAILED', '样品登记未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该样品的登记记录。', 500);
  }
}

export async function updateSample(params: {
  prisma: PrismaClient;
  sampleId: string;
  input: Record<string, any>;
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ sample: any }>> {
  const { prisma, sampleId, input, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    const sample = await (prisma as any).$transaction(async (tx: any) => {
      let existing = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
      if (!existing) throw Object.assign(new Error('样品不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const originalCaseId = existing.sourceCaseId ?? null;
      const originalSources = sourceSnapshot(existing);
      if (originalCaseId) {
        const cases = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${originalCaseId} AND "deletedAt" IS NULL FOR UPDATE`);
        if (!cases.length) throw Object.assign(new Error('来源开发案不存在'), { code: 'NOT_FOUND' , statusCode: 404 });
      }
      const proposedSources = { ...existing, ...(input.productAssetId !== undefined ? { productAssetId: str(input.productAssetId) } : {}) };
      await lockOriginsAndBusinessSources(tx, [existing, proposedSources]);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id" = ${sampleId} FOR UPDATE`);
      existing = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
      if (!existing) throw Object.assign(new Error('样品不存在'), { code: 'NOT_FOUND' , statusCode: 404 });
      await assertGenericSampleMutationAllowed(tx, existing, '变更');
      if ((existing.sourceCaseId ?? null) !== originalCaseId) throw Object.assign(new Error('样品来源已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED' , statusCode: 409 });
      if (sourceSnapshot(existing) !== originalSources) throw Object.assign(new Error('样品来源已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED', statusCode: 409 });
      if (existing.type === 'ship') await lockShipmentSampleOrders(tx, [existing.sourceOrderId]);
      // Source corrections must not silently move historical costs or development responsibility.
      for (const key of ['sourceCaseId', 'sourceOrderId'] as const) {
        if (input[key] !== undefined && str(input[key]) !== (existing[key] ?? null)) {
          throw Object.assign(new Error('来源变更须核对历史费用和关联业务，不能通过普通编辑改动'), { code: 'SAMPLE_SOURCE_CHANGED' , statusCode: 409 });
        }
      }
      const [originalContext, businessContext] = await resolveSampleBusinessContexts(tx, [existing, proposedSources]);
      const notesOnly = Object.keys(input).every(key => input[key] === undefined || key === 'notes');
      assertSampleBusinessContext(originalContext, true);
      assertSampleBusinessContext(businessContext, notesOnly);
      assertSameSampleBusinessLine(originalContext, businessContext);
      const factualFields = new Set(['courier', 'trackingNumber', 'sentDate', 'shippingFee']);
      const changesDevelopment = Object.keys(input).some(key => input[key] !== undefined && !factualFields.has(key));
      if (originalCaseId && DESIGN_TYPES.includes(existing.type as SampleType) && changesDevelopment) {
        await assertDevelopmentOperationalWrite(tx, originalCaseId, 'sample');
      }
      if (['origin','sealOrigin','projectionKey','sourceBindings','sourceSnapshot','sourceFingerprint'].some(key => input[key] !== undefined)) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '来源身份不可通过普通编辑替换');
      const [originContext] = await readSampleOriginContexts(tx, [existing]);
      assertSampleOriginMetadata(originContext, existing, { ...existing, ...input });
      if (originContext.origins.length && input.productAssetId !== undefined && str(input.productAssetId) !== (existing.productAssetId ?? null)) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '已绑定实物的档案关联须通过原来源关联流程核对');
      const data: any = { updatedAt: now };
      const scalar = ['subType', 'sourceCaseId', 'sourceOrderId', 'productAssetId', 'supplierRelationId', 'supplierName', 'customerRelationId', 'notes'] as const;
      for (const k of scalar) {
        if (input[k] !== undefined) data[k] = str(input[k]);
      }
      for (const k of ['courier', 'trackingNumber', 'feedback', 'feedbackDate', 'sentDate'] as const) {
        if (input[k] !== undefined) data[k] = str(input[k]);
      }
      // DR-054 阶段 G：大货生产样明细（attachments JSON 整块替换）
      if (input.attachments !== undefined) {
        data.attachments = input.attachments === null ? null : (typeof input.attachments === 'object' ? input.attachments : undefined);
      }
      if (input.shippingFee !== undefined) {
        const fee = input.shippingFee === null ? null : Number(input.shippingFee);
        if (fee != null && (!Number.isFinite(fee) || fee < 0)) throw Object.assign(new Error('邮寄费必须是非负数值'), { code: 'INVALID_INPUT' , statusCode: 400 });
        data.shippingFee = fee;
      }
      const updated = await tx.sample.update({ where: { id: sampleId }, data });
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:samples:manage', operation: 'update_sample',
        targetType: 'Sample', targetId: sampleId,
        before: { code: existing.code }, after: { code: existing.code, ...data },
        ip: ip ?? null,
      });
      return { ...updated, businessContext };
    });
    return ok({ sample: serializeSample(sample) });
  } catch (e: any) {
    const sourceFailure = businessFailure(e); if (sourceFailure) return sourceFailure;
    if (['DEVELOPMENT_PAUSED', 'DEVELOPMENT_CLOSED', 'INVALID_LIFECYCLE_STATE', 'SAMPLE_SOURCE_CHANGED'].includes(e?.code)) return fail(e.code, e.message, 409);
    if (e?.code === 'NOT_FOUND') return fail('NOT_FOUND', e.message, 404);
    if (e?.code === 'INVALID_INPUT') return fail('INVALID_INPUT', e.message, 400);
    logger.error('[SampleManage] update failed', { sampleId, actorId, error: e?.message ?? e });
    return fail('SAMPLE_UPDATE_FAILED', '样品信息更新未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该样品的变更记录。', 500);
  }
}

export async function deleteSample(params: {
  prisma: PrismaClient;
  sampleId: string;
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ sample: { id: string } }>> {
  const { prisma, sampleId, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    await (prisma as any).$transaction(async (tx: any) => {
      let existing = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
      if (!existing) throw Object.assign(new Error('样品不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const caseId = existing.sourceCaseId ?? null;
      const originalSources = sourceSnapshot(existing);
      if (caseId) {
        const cases = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
        if (!cases.length) throw Object.assign(new Error('来源开发案不存在'), { code: 'NOT_FOUND' , statusCode: 404 });
      }
      await lockOriginsAndBusinessSources(tx, [existing]);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id" = ${sampleId} FOR UPDATE`);
      existing = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
      if (!existing) throw Object.assign(new Error('样品不存在'), { code: 'NOT_FOUND' , statusCode: 404 });
      await assertGenericSampleMutationAllowed(tx, existing, '变更');
      if ((existing.sourceCaseId ?? null) !== caseId) throw Object.assign(new Error('样品来源已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED' , statusCode: 409 });
      if (sourceSnapshot(existing) !== originalSources) throw Object.assign(new Error('样品来源已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED', statusCode: 409 });
      const businessContext = await resolveSampleBusinessContext(tx, existing);
      assertSampleBusinessContext(businessContext, existing.status === 'draft');
      if (existing.type === 'ship') await lockShipmentSampleOrders(tx, [existing.sourceOrderId]);
      if (caseId && DESIGN_TYPES.includes(existing.type as SampleType)) await assertDevelopmentOperationalWrite(tx, caseId, 'sample');
      const source = { sourceType: 'Sample', sourceId: sampleId };
      const [cost, pending, billing, invoice, fork, card, lengthMovement, release, orderLine, releaseScope] = await Promise.all([
        tx.costRecord.findFirst({ where: source }),
        tx.developmentPendingExpense.findFirst({ where: source }),
        tx.billingItem.findFirst({ where: source }),
        tx.invoice.findFirst({ where: source }),
        tx.sample.findFirst({ where: { forkedFromSampleId: sampleId } }),
        tx.sampleCardItem.findFirst({ where: { sampleId } }),
        tx.sampleLengthMovement.findFirst({ where: { sampleId } }),
        tx.ppSampleRelease.findFirst({ where: { sampleId } }),
        tx.orderLine.findFirst({ where: { confirmedSourceType: 'Sample', confirmedSourceId: sampleId } }),
        tx.releaseScope.findFirst({ where: { confirmedSourceType: 'Sample', confirmedSourceId: sampleId } }),
      ]);
      if (existing.invoiceId || cost || pending || billing || invoice || fork || card || lengthMovement || release || orderLine || releaseScope) {
        throw Object.assign(new Error('样品已有费用、实物、订单或放行引用，须保留追溯依据，不能删除'), { code: 'SAMPLE_HAS_HISTORY' , statusCode: 409 });
      }
      await tx.sample.update({ where: { id: sampleId }, data: { deletedAt: now, updatedAt: now } });
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:samples:manage', operation: 'delete_sample',
        targetType: 'Sample', targetId: sampleId,
        before: { code: existing.code, type: existing.type }, after: { code: existing.code, deletedAt: Number(now) },
        ip: ip ?? null,
      });
    });
    return ok({ sample: { id: sampleId } });
  } catch (e: any) {
    const sourceFailure = businessFailure(e); if (sourceFailure) return sourceFailure;
    if (['DEVELOPMENT_PAUSED', 'DEVELOPMENT_CLOSED', 'INVALID_LIFECYCLE_STATE', 'SAMPLE_SOURCE_CHANGED', 'SAMPLE_HAS_HISTORY'].includes(e?.code)) return fail(e.code, e.message, 409);
    if (e?.code === 'NOT_FOUND') return fail('NOT_FOUND', e.message, 404);
    logger.error('[SampleManage] delete failed', { sampleId, actorId, error: e?.message ?? e });
    return fail('SAMPLE_DELETE_FAILED', '样品删除未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对该样品的删除记录。', 500);
  }
}

// ────────────────────────────────────────────────────────────────────
// 状态机推进（设计确认 / 生产确认 双语境）
// ────────────────────────────────────────────────────────────────────

export async function advanceSampleStage(params: {
  prisma: PrismaClient;
  sampleId: string;
  action: SampleAction;
  input?: {
    sentDate?: string;
    courier?: string;
    trackingNumber?: string;
    shippingFee?: number;
    recipientName?: string;
    recipientCompany?: string;
    recipientAddress?: string;
    recipientPhone?: string;
    feedback?: string;
    feedbackDate?: string;
    qcStatus?: string;
    qcInspectionReportId?: string;
    customerStatus?: string;
    notes?: string;
    retainLocation?: string; // §10.3 封样留存位置（样上登记）
  };
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ sample: any }>> {
  const { prisma, sampleId, action, input = {}, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    const sample = await (prisma as any).$transaction(async (tx: any) => {
      let existing = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
      if (!existing) throw Object.assign(new Error('样品不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const caseId = existing.sourceCaseId ?? null;
      const originalSources = sourceSnapshot(existing);
      if (caseId) {
        const cases = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
        if (!cases.length) throw Object.assign(new Error('来源开发案不存在'), { code: 'NOT_FOUND' , statusCode: 404 });
      }
      await lockOriginsAndBusinessSources(tx, [existing]);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id" = ${sampleId} FOR UPDATE`);
      existing = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
      if (!existing) throw Object.assign(new Error('样品不存在'), { code: 'NOT_FOUND' , statusCode: 404 });
      await assertGenericSampleMutationAllowed(tx, existing, '变更');
      if ((existing.sourceCaseId ?? null) !== caseId) throw Object.assign(new Error('样品来源已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED' , statusCode: 409 });
      if (sourceSnapshot(existing) !== originalSources) throw Object.assign(new Error('样品来源已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED', statusCode: 409 });
      const businessContext = await resolveSampleBusinessContext(tx, existing);
      assertSampleBusinessContext(businessContext);
      if (existing.type === 'ship') await lockShipmentSampleOrders(tx, [existing.sourceOrderId]);
      if (caseId && DESIGN_TYPES.includes(existing.type as SampleType)) {
        await assertDevelopmentOperationalWrite(tx, caseId, 'sample');
      }
      const type = existing.type as SampleType;
      const rule = actionRule(type, action);
      if (!rule) {
        throw Object.assign(new Error(`${type === 'seal' || type === 'dev' ? '设计确认' : '生产确认'}样品不支持动作 ${action}`), { code: 'INVALID_ACTION', statusCode: 400 });
      }
      const current = existing.status as SampleStatus;
      if (!rule.from.includes(current)) {
        throw Object.assign(new Error(`当前状态 ${current} 不允许执行 ${action}`), { code: 'INVALID_TRANSITION', statusCode: 409 });
      }
      const data: any = { status: rule.to, updatedAt: now };
      if (action === 'start' && current === 'revising') data.round = existing.round + 1;
      if (action === 'send') {
        data.sentDate = input.sentDate ?? todayLocalKey();
        if (input.courier !== undefined) data.courier = str(input.courier);
        if (input.trackingNumber !== undefined) data.trackingNumber = str(input.trackingNumber);
        if (input.shippingFee !== undefined) {
          const fee = input.shippingFee === null ? null : Number(input.shippingFee);
          if (fee != null && (!Number.isFinite(fee) || fee < 0)) throw Object.assign(new Error('邮寄费必须是非负数值'), { code: 'INVALID_INPUT' , statusCode: 400 });
          data.shippingFee = fee;
        }
        for (const k of ['recipientName', 'recipientCompany', 'recipientAddress', 'recipientPhone'] as const) {
          if (input[k] !== undefined) data[k] = str(input[k]);
        }
      }
      if (action === 'qc') {
        const qc = String(input.qcStatus ?? 'passed');
        if (!['passed', 'failed'].includes(qc)) throw Object.assign(new Error('qcStatus 必须是 passed | failed'), { code: 'INVALID_INPUT' , statusCode: 400 });
        data.qcStatus = qc;
        data.qcInspectionReportId = str(input.qcInspectionReportId);
        if (qc === 'failed') data.status = 'revising'; // QC 不通过 → 回退重做（开新轮）
      }
      if (action === 'submit') {
        data.sentDate = input.sentDate ?? existing.sentDate ?? todayLocalKey();
        if (input.courier !== undefined) data.courier = str(input.courier);
        if (input.trackingNumber !== undefined) data.trackingNumber = str(input.trackingNumber);
      }
      if (action === 'confirm') {
        const cs = String(input.customerStatus ?? 'approved');
        if (!['approved', 'rejected', 'needs_revision'].includes(cs)) {
          throw Object.assign(new Error('customerStatus 必须是 approved | rejected | needs_revision'), { code: 'INVALID_INPUT' , statusCode: 400 });
        }
        data.customerStatus = cs;
        data.feedback = str(input.feedback);
        data.feedbackDate = input.feedbackDate ?? todayLocalKey();
        // 客户不通过 → 该轮终止（rejected）或开新轮（needs_revision → revising）
        if (cs === 'rejected') data.status = 'rejected';
        if (cs === 'needs_revision') data.status = 'revising';
      }
      if (action === 'approve') {
        data.approvedAt = now;
        data.approvedBy = actorId;
      }
      if (action === 'seal') {
        data.approvedAt = now;
        data.approvedBy = actorId;
        // 留存位置随样品登记（attachments.retainLocation；merge 不覆盖阶段 G 大货样明细等既有键）
        const loc = str((input as any).retainLocation);
        if (loc) {
          const base = existing.attachments && typeof existing.attachments === 'object' ? { ...(existing.attachments as Record<string, any>) } : {};
          base.retainLocation = loc;
          data.attachments = base;
        }
      }
      if (input.notes !== undefined) data.notes = str(input.notes);
      const updated = await tx.sample.update({ where: { id: sampleId }, data });
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:samples:manage', operation: 'advance_sample_stage',
        targetType: 'Sample', targetId: sampleId,
        before: { code: existing.code, status: current, round: existing.round },
        after: { code: existing.code, status: updated.status, round: updated.round, action },
        ip: ip ?? null,
      });
      return { ...updated, businessContext };
    });
    // DR-053 阶段 2 返修联动：样品进入 revising（返修/QC 不通过/客户需修改）→ 失效引用该样品的放行范围
    // （事务外调用 releaseService；联动失败**不阻断**样品状态更新——资格判定有 round 兜底，见 §14.4）
    // 但失败必须留痕：静默吞掉会让「失效没生效」无人知晓，一旦兜底也失效（如批准未锁 sampleRound）
    // 就会出现返修过的 PP 样仍被放行投产，且无任何线索可追查。
    if (sample?.status === 'revising') {
      const invalidation: any = await invalidateScopesBySample({
        prisma, sampleId, reason: `样品返修（第 ${sample.round} 轮进入 revising）`, actorId,
      }).catch((e: any) => ({ ok: false, error: { message: String(e?.message ?? e) } }));
      if (!invalidation?.ok) {
        logger.error('[samples] 样品返修联动失效放行范围失败（资格判定有 round 兜底，仍需人工确认）', {
          sampleId,
          round: sample.round,
          error: invalidation?.error?.message ?? 'unknown',
        });
      }
    }
    return ok({ sample: serializeSample(sample) });
  } catch (e: any) {
    const sourceFailure = businessFailure(e); if (sourceFailure) return sourceFailure;
    if (['DEVELOPMENT_PAUSED', 'DEVELOPMENT_CLOSED', 'INVALID_LIFECYCLE_STATE', 'SAMPLE_SOURCE_CHANGED'].includes(e?.code)) return fail(e.code, e.message, 409);
    if (e?.code === 'NOT_FOUND') return fail('NOT_FOUND', e.message, 404);
    if (e?.code === 'INVALID_ACTION') return fail('INVALID_ACTION', e.message, 400);
    if (e?.code === 'INVALID_TRANSITION') return fail('INVALID_TRANSITION', e.message, 409);
    if (e?.code === 'INVALID_INPUT') return fail('INVALID_INPUT', e.message, 400);
    logger.error('[SampleManage] stage advance failed', { sampleId, action, actorId, error: e?.message ?? e });
    // 此处不承诺「未确认任何改动」：提交后那段联动的拒绝被调用点 `.catch` 与 `invalidateScopesBySample`
    // 自带 catch 双重吸收 ⇒ 更强的承诺其实成立，但它依赖一条**无守卫的跨文件不变量**（复核 7i 提出）
    // ⇒ 保守只让用户核对状态（状态机动作本就该核对）。将来该不变量若被加守卫，可回头加强。
    return fail('SAMPLE_STAGE_FAILED', '样品状态推进未能确认完成，请刷新后核对该样品当前状态；若状态未变化可重试，持续失败请联系管理员核对该样品的状态变更记录。', 500);
  }
}

// ────────────────────────────────────────────────────────────────────
// 复刻（类型演进：确认样封存 → 产前样；开发样 → 生产确认样品）
// ────────────────────────────────────────────────────────────────────

export async function forkSample(params: {
  prisma: PrismaClient;
  sampleId: string;
  input: { toType: string; sourceOrderId?: string; productAssetId?: string; supplierRelationId?: string; supplierName?: string; notes?: string };
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ sample: any }>> {
  const { prisma, sampleId, input, actorId, ip } = params;
  try {
    const toType = assertType(input?.toType);
    const now = BigInt(Date.now());
    const sample = await (prisma as any).$transaction(async (tx: any) => {
      let src = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
      if (!src) throw Object.assign(new Error('源样品不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const caseId = src.sourceCaseId ?? null;
      const originalSources = sourceSnapshot(src);
      if (caseId) await assertDevelopmentOperationalWrite(tx, caseId, 'convert');
      const proposedSources = { ...src, sourceOrderId: str(input?.sourceOrderId) ?? src.sourceOrderId ?? null, productAssetId: str(input?.productAssetId) ?? src.productAssetId ?? null };
      await lockOriginsAndBusinessSources(tx, [src, proposedSources]);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id" = ${sampleId} FOR UPDATE`);
      src = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
      if (!src) throw Object.assign(new Error('源样品不存在或已删除'), { code: 'NOT_FOUND' , statusCode: 404 });
      await assertGenericSampleMutationAllowed(tx, src, '复刻');
      if ((src.sourceCaseId ?? null) !== caseId) throw Object.assign(new Error('源样品归属已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED' , statusCode: 409 });
      if (sourceSnapshot(src) !== originalSources) throw Object.assign(new Error('源样品归属已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED', statusCode: 409 });
      const contexts = await resolveSampleBusinessContexts(tx, [src, proposedSources]);
      contexts.forEach(context => assertSampleBusinessContext(context));
      assertSameSampleBusinessLine(contexts[0], contexts[1]);
      assertGenericOrderSampleCreationAllowed({ type: toType, sourceCaseId: src.sourceCaseId, sourceOrderId: input.sourceOrderId ?? src.sourceOrderId });
      const businessContext = contexts[1];
      const [originContext] = await readSampleOriginContexts(tx, [src]);
      assertSampleOriginIdentity(originContext);
      assertSampleOriginMetadata(originContext, src, { ...src, ...input });
      if (originContext.origins.length && (['sourceOrderId','productAssetId'] as const).some(key => input[key] !== undefined && str(input[key]) !== (src[key] ?? null))) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '复刻不能替换原实物的订单或档案来源');
      // 复刻方向守卫：设计确认（dev/seal）→ 生产确认（pp/top...）
      if (!DESIGN_TYPES.includes(src.type as SampleType)) {
        throw Object.assign(new Error(`仅设计确认样品（dev/seal）可复刻，当前 ${src.type}`), { code: 'INVALID_FORK_SOURCE', statusCode: 400 });
      }
      if (!PRODUCTION_TYPES.includes(toType)) {
        throw Object.assign(new Error(`复刻目标必须是生产确认类型（${PRODUCTION_TYPES.join('|')}）`), { code: 'INVALID_FORK_TARGET', statusCode: 400 });
      }
      if (toType === 'ship') await lockShipmentSampleOrders(tx, [str(input?.sourceOrderId) ?? src.sourceOrderId]);
      const created = await tx.sample.create({
        data: {
          id: genId('SMP'),
          code: await genCode(tx),
          type: toType,
          subType: src.subType ?? null,
          sourceCaseId: src.sourceCaseId ?? null,
          sourceOrderId: str(input?.sourceOrderId) ?? src.sourceOrderId ?? null,
          productAssetId: str(input?.productAssetId) ?? src.productAssetId ?? null,
          supplierRelationId: str(input?.supplierRelationId) ?? src.supplierRelationId ?? null,
          supplierName: str(input?.supplierName) ?? src.supplierName ?? null,
          customerRelationId: src.customerRelationId ?? null,
          status: 'draft',
          round: 1,
          forkedFromSampleId: src.id,
          notes: str(input?.notes),
          createdAt: now,
          updatedAt: now,
        },
      });
      await cloneSampleOrigins(tx, src.id, created.id, actorId);
      await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:samples:manage', operation: 'fork_sample',
        targetType: 'Sample', targetId: created.id,
        after: { code: created.code, type: toType, forkedFromSampleId: src.id },
        ip: ip ?? null,
      });
      return { ...created, businessContext };
    });
    return ok({ sample: serializeSample(sample) });
  } catch (e: any) {
    const sourceFailure = businessFailure(e); if (sourceFailure) return sourceFailure;
    if (['DEVELOPMENT_PAUSED', 'DEVELOPMENT_CLOSED', 'INVALID_LIFECYCLE_STATE', 'SAMPLE_SOURCE_CHANGED'].includes(e?.code)) return fail(e.code, e.message, 409);
    if (e?.code === 'NOT_FOUND') return fail('NOT_FOUND', e.message, 404);
    if (e?.code === 'INVALID_FORK_SOURCE') return fail('INVALID_FORK_SOURCE', e.message, 400);
    if (e?.code === 'INVALID_FORK_TARGET') return fail('INVALID_FORK_TARGET', e.message, 400);
    if (e?.code === 'INVALID_INPUT') return fail('INVALID_INPUT', e.message, 400);
    logger.error('[SampleManage] fork failed', { sampleId, toType: input?.toType, actorId, error: e?.message ?? e });
    return fail('SAMPLE_FORK_FAILED', '样品复刻未能完成，本次未确认任何改动，请稍后重试；持续失败请联系管理员核对源样品与复刻目标类型。', 500);
  }
}

// ────────────────────────────────────────────────────────────────────
// 产物级开票触点（DR-052 §6）：每个样品对象可独立开票
// ────────────────────────────────────────────────────────────────────

/** 回填与审计必须由调用者放进同一事务；任一失败都回滚关联。 */
async function backfillSampleInvoiceId(prisma: PrismaClient, sample: any, invoice: any, actorId: string, ip: string | null): Promise<any> {
  const updated = await prisma.sample.update({
    where: { id: sample.id },
    data: { invoiceId: invoice.id, updatedAt: BigInt(Date.now()) },
  });
  await writeRouteAuditLog({
    prisma, actorId, source: 'route:samples:manage', operation: 'invoice_sample_link_backfill',
    targetType: 'Sample', targetId: sample.id,
    before: { code: sample.code, invoiceId: sample.invoiceId ?? null },
    after: { code: sample.code, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
    ip: ip ?? null,
  });
  return serializeSample(updated);
}

/**
 * 样品开票：从样品自动带出客户（customerRelationId）与默认金额（shippingFee 或显式入参），
 * 调 finance createInvoice → 回填 Sample.invoiceId。
 *
 * 幂等与失败恢复（DR-053 阶段 0，修复"回填失败静默成功 + 并发/重试重复建票"）：
 *  - 来源幂等：发票带 sourceType='Sample' + sourceId=sampleId，Invoice 表
 *    @@unique([sourceType, sourceId]) 数据库层兜底并发；
 *  - 已回填：sample.invoiceId 非空 → 409 ALREADY_INVOICED（不重复建票）；
 *  - 重试恢复：建票成功但回填失败 → 明确 500 BACKFILL_FAILED（可重试）；
 *    重试先查 sourceType+sourceId 已有票 → 回填恢复并返回（recovered=true），不重复建票；
 *  - 并发兜底：两个请求同时建票 → 后者 createInvoice 唯一冲突（CREATE_FAILED）
 *    → 转查已有票回填恢复。
 */
export async function invoiceSample(params: {
  prisma: PrismaClient;
  sampleId: string;
  input: {
    amount?: number;
    currency?: string;
    issueDate?: string;
    notes?: string;
  };
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ invoice: any; sample: any; recovered?: boolean }>> {
  const { prisma, sampleId, input, actorId, ip } = params;
  const sample = await findLiveSample(prisma, sampleId);
  if (!sample) return fail('NOT_FOUND', `样品 ${sampleId} 不存在`, 404);
  if (sample.invoiceId) return fail('ALREADY_INVOICED', `样品 ${sample.code} 已开票（${sample.invoiceId}），不可重复开票`, 409);
  const guardedTransaction = async <T>(work: (tx: any) => Promise<T>): Promise<T> => (prisma as any).$transaction(async (tx: any) => {
    await lockOriginsAndBusinessSources(tx, [sample]);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id" = ${sampleId} FOR UPDATE`);
    const current = await tx.sample.findFirst({ where: { id: sampleId, deletedAt: null } });
    if (!current) throw Object.assign(new Error('样品不存在'), { code: 'NOT_FOUND', statusCode: 404 });
    if (sourceSnapshot(current) !== sourceSnapshot(sample)) throw Object.assign(new Error('样品来源已变化，请刷新'), { code: 'SAMPLE_SOURCE_CHANGED', statusCode: 409 });
    assertSampleBusinessContext(await resolveSampleBusinessContext(tx, current));
    return work(tx);
  });
  const restoreLink = async (invoice: any, recovered: boolean): Promise<Result<{ invoice: any; sample: any; recovered: boolean }>> => {
    try {
      const updated = await guardedTransaction(tx => backfillSampleInvoiceId(tx, sample, invoice, actorId, ip ?? null));
      return ok({ invoice, sample: updated, recovered });
    } catch (e: any) {
      logger.error('[SampleManage] invoice link backfill failed', {
        sampleId, invoiceId: invoice?.id, invoiceNumber: invoice?.invoiceNumber, error: e?.message ?? e,
      });
      return fail('BACKFILL_FAILED', `发票 ${invoice.invoiceNumber} 已创建但样品回填失败，可重试，将自动恢复关联且不会重复建票；持续失败请联系管理员核对该发票与样品的关联。`, 500);
    }
  };
  class InvoiceCreationAbort extends Error {
    constructor(readonly result: Awaited<ReturnType<typeof createInvoice>>) { super('Invoice creation transaction must roll back'); }
  }
  try {
  // 来源幂等恢复：该样品已有发票（如先前建票后回填失败）→ 回填并返回，不重复建票
  const existingBySource = await (prisma as any).invoice?.findFirst?.({ where: { sourceType: 'Sample', sourceId: sampleId, deletedAt: null } }).catch(() => null) ?? null;
  if (existingBySource) {
    return restoreLink(existingBySource, true);
  }

  // 自动带出客户名称（Relation 解析；未挂档案则仅按快照）
  let customerName: string | undefined;
  if (sample.customerRelationId) {
    const rel = await (prisma as any).relation?.findFirst?.({ where: { id: sample.customerRelationId } }).catch(() => null) ?? null;
    customerName = rel?.name ?? undefined;
  }

  const amount = input.amount !== undefined ? input.amount : (sample.shippingFee ?? 0);
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return fail('INVALID_AMOUNT', '开票金额必须是非负数值', 400);
  }
  const currency = String(input.currency ?? 'CNY').trim() || 'CNY';
  const issueDate = String(input.issueDate ?? '').trim() || todayLocalKey();

  const afterCommit: Array<() => Promise<void>> = [];
  const r = await guardedTransaction(async tx => {
    const result = await createInvoice({
    prisma,
    input: {
      invoiceNumber: `SMP-INV-${Date.now().toString(36).toUpperCase()}`,
      type: 'Receivable',
      status: 'Draft',
      amount: Number(amount),
      currency,
      issueDate,
      customerRelationId: sample.customerRelationId ?? undefined,
      customerName,
      notes: input.notes ?? `样品 ${sample.code} 开票`,
      sourceType: 'Sample',
      sourceId: sampleId,
    },
    actorId,
    ip: ip ?? null,
    transaction: { tx, deferAfterCommit: work => afterCommit.push(work) },
    });
    // Canonical invoice creation catches errors as a Result. Reusing our tx
    // requires a throw, otherwise failure after a write would commit half a bill.
    if (!result.ok) throw new InvoiceCreationAbort(result);
    return result;
  }).catch((e: unknown) => {
    if (e instanceof InvoiceCreationAbort) return e.result;
    throw e;
  });
  if (!r.ok) {
    // 并发兜底：唯一冲突（CREATE_FAILED）时查已有票并恢复
    if (r.error?.code === 'CREATE_FAILED') {
      const dup = await (prisma as any).invoice?.findFirst?.({ where: { sourceType: 'Sample', sourceId: sampleId, deletedAt: null } }).catch(() => null) ?? null;
      if (dup) {
        return restoreLink(dup, true);
      }
    }
    return fail(r.error?.code ?? 'INVOICE_CREATE_FAILED', r.error?.message ?? '创建发票失败', 400);
  }
  for (const work of afterCommit) await work();
  const invoice = r.data!.invoice;

  // 回填 Sample.invoiceId；失败 → 明确 BACKFILL_FAILED（可重试，重试走来源幂等恢复路径）
  return restoreLink(invoice, false);
  } catch (e: any) {
    const sourceFailure = businessFailure(e); if (sourceFailure) return sourceFailure;
    if (e?.code === 'SAMPLE_SOURCE_CHANGED') return fail(e.code, e.message, 409);
    if (e?.code === 'NOT_FOUND') return fail(e.code, e.message, 404);
    logger.error('[SampleManage] invoice source validation failed', { sampleId, error: e?.message ?? e });
    return fail('INVOICE_CREATE_FAILED', '样品开票来源未能核验，请刷新核对样品与财务记录后重试。', 500);
  }
}
