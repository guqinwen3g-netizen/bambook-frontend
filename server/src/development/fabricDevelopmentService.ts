import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from './developmentOperationalGuard';
/**
 * fabricDevelopmentService.ts — 面料开发链（DR-050，type=fabric 专用）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/Development-开发/面料开发流程.md
 *
 * 覆盖：开发供应商（多工厂试样）↔ 统一样品批次（色样/手织样/米样）↔ 封样（同厂组合）
 *      ↔ 强制转面料档案（convert-to-asset）。
 *
 * 关键业务规则：
 *  - 批次按工厂归属；封样只能组合同一工厂的批次（CROSS_SUPPLIER_SEAL 强校验）；
 *  - 一个开发案可并存多个封样，各自/批次可直接转成不同面料档案；
 *  - 面料开发案转大货前必须先转档（ASSET_REQUIRED，见 convertService）。
 *  - 所有 mutation 写审计（writeRouteAuditLog 同事务，fail closed）。
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { shipPhysicalSampleInTransaction, PhysicalShipmentError, type PhysicalShipmentInput } from '../samples/samplePhysicalShipment';
import { SampleCustodyAuthorizationError, authorizeSampleCustody, type SampleCustodyAuthorization } from '../samples/sampleCustodyAuthorization';
import { readBatchReceiptSnapshot } from '../samples/sampleBatchReceipt';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { syncDevelopmentCaseReferences } from '../entities/sync';
// ★ G-5：开发来源的取值/映射真源（本文件曾自持 DEV_SOURCES 与 DEV_SOURCE_MAP 两份）
import { assetSourceFromDevCase } from './devSource';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { isBusinessError } from '../shared/errorCodes';
import { safeRouteError } from '../shared/routeError';
import { logger } from '../lib/logger';
import { createDevelopmentAssetWithSku } from '../products/developmentSkuAllocator';
import type { TokenPayload } from '../auth/service';
import { appendFabricEvent, assertFabricSealEligible,
  assertFabricBatchEvidence, checkFabricCommand, fabricBatchEligibility, fabricBatchSnapshot, invalidateFabricProjection, lockFabricBatch,
  type FabricCommand } from './fabricBatchHistory';
import { lockSampleOriginParents, readSampleOriginContexts, sampleOriginFingerprint, sampleOriginLockHints, snapshotSampleOrigin } from '../samples/sampleOriginService';
import { ensureDevelopmentSampleMajorVersion, ensureDevelopmentSampleRound } from './developmentSampleVersionService';
import { assertReviewSourceCurrent } from './developmentSampleQualityService';
import { assertDevelopmentVersionQualityPass, developmentQualityReviewSummary, readDevelopmentArchiveReceipt, readDevelopmentVersionDecisions, recordDevelopmentArchiveReceipt, resolveDevelopmentVersionForBatch } from './developmentVersionGate';
import { authorizeDevelopmentSource } from './developmentConversionAuthority';
import { findDevelopmentFabricVersionAsset, linkDevelopmentPhysicalSamplesToAsset } from './developmentPhysicalArchiveLink';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────────
// 常量与校验
// ────────────────────────────────────────────────────────────────────

export const SAMPLE_BATCH_TYPES = ['lab-dip', 'handloom', 'yardage'] as const;
export const SAMPLE_BATCH_STATUSES = ['pending', 'making', 'sent', 'approved', 'revising'] as const;
export type SampleBatchType = typeof SAMPLE_BATCH_TYPES[number];
export type SampleBatchStatus = typeof SAMPLE_BATCH_STATUSES[number];
export type SampleBatchAction = 'start' | 'send' | 'approve' | 'revise';

export const SEAL_STATUSES = ['draft', 'sealed', 'converted'] as const;
export const CUSTOMER_STATUSES = ['approved', 'rejected', 'needs_recast'] as const;
export const DEFECT_CAUSES = ['red_cast', 'blue_cast', 'lighter', 'darker'] as const;
export const TECH_REVIEW_STATUSES = ['pass', 'adjust', 'reject'] as const;
export const DYE_METHODS = ['top_fiber_dyed', 'yarn_dyed', 'piece_dyed'] as const;
export const TRIAL_CONCLUSIONS = ['ok', 'fail'] as const;

/** action → (允许的前置状态 → 目标状态)；start 从 revising 进入时 round+1 */
const ACTION_RULES: Record<SampleBatchAction, { from: SampleBatchStatus[]; to: SampleBatchStatus }> = {
  start: { from: ['pending', 'revising'], to: 'making' },
  send: { from: ['making'], to: 'sent' },
  approve: { from: ['sent'], to: 'approved' },
  revise: { from: ['sent', 'making'], to: 'revising' },
};

type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): Result<never> => ({ ok: false, error: { code, message, status } });

const OPERATIONAL_ERROR_CODES = Object.freeze([
  'DEVELOPMENT_PAUSED', 'DEVELOPMENT_CLOSED', 'INVALID_LIFECYCLE_STATE',
  'LIFECYCLE_HISTORY_EXISTS', 'DEVELOPMENT_SOURCE_CHANGED', 'DEVELOPMENT_NOT_READY', 'FORBIDDEN', 'REQUEST_CONFLICT', 'DEVELOPMENT_NOT_ACCESSIBLE',
] as const);

/** Preserve each operation's existing finite business boundary. Status and public
 * message come from its deliberate producer, including this module's 409
 * INVALID_TRANSITION (the generic registry entry has a different contract).
 * A storage error merely carrying a code, or a different coded error outside
 * that operation's boundary, cannot become a public business rejection.
 */
function failFabricOperation(
  error: unknown, fallbackCode: string, fallbackMessage: string,
  operationCodes: readonly string[] = [],
): Result<never> {
  const business = isBusinessError(error)
    && ([...OPERATIONAL_ERROR_CODES, ...operationCodes] as readonly string[]).includes(error.code);
  if (!business) logger.error('[FabricDevelopment] operation failed', { operation: fallbackCode, error });
  const safe = safeRouteError(business ? error : undefined, { fallbackCode: 'INTERNAL_ERROR', fallbackMessage });
  return fail(business ? safe.code : fallbackCode, safe.message, safe.status);
}

function todayYmd(): string {
  return todayLocalKey();
}


function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const s = String(value ?? '').trim();
  if (!(allowed as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`${field} 非法（可选 ${allowed.join(' | ')}）`), { code: 'INVALID_INPUT' , statusCode: 400 });
  }
  return s as T;
}

function assertRating(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw Object.assign(new Error('色差评级必须是 1-5 整数（5=与标样一致 … 1=完全不符）'), { code: 'INVALID_INPUT' , statusCode: 400 });
  }
  return n;
}

export function sanitizeDefectCauses(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error('疵点原因必须是数组'), { code: 'INVALID_INPUT' , statusCode: 400 });
  const out: string[] = [];
  for (const v of value) {
    const s = String(v).trim();
    if (!s) continue;
    if (!(DEFECT_CAUSES as readonly string[]).includes(s)) {
      throw Object.assign(new Error(`非法疵点原因：${s}（允许 ${DEFECT_CAUSES.join(' | ')}）`), { code: 'INVALID_INPUT' , statusCode: 400 });
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// 序列化（BigInt → Number，供 JSON 响应）
function ser(v: any): any {
  return v == null ? v : Number(v);
}
function serializeSupplier(s: any) {
  return { ...s, createdAt: ser(s.createdAt), updatedAt: ser(s.updatedAt), deletedAt: s.deletedAt ? ser(s.deletedAt) : null };
}
export function serializeBatch(b: any) {
  return { ...b, ...(b.sampleType !== 'garment-round' ? { eligibility: fabricBatchEligibility(b) } : {}), approvedAt: b.approvedAt ? ser(b.approvedAt) : null, createdAt: ser(b.createdAt), updatedAt: ser(b.updatedAt), deletedAt: b.deletedAt ? ser(b.deletedAt) : null, convertedAt: b.convertedAt ? ser(b.convertedAt) : null, photos: b.photos ?? null,
    // DR-054 阶段 B：计划/实际数量 + 批次级确认（Decimal/BigInt 序列化）
    planQuantity: b.planQuantity != null ? Number(b.planQuantity) : null,
    actualQuantity: b.actualQuantity != null ? b.actualQuantity.toString() : null,
    confirmedAt: b.confirmedAt ? ser(b.confirmedAt) : null,
    returnedAt: b.returnedAt ? ser(b.returnedAt) : null,
    // Only the explicit factory-return event proves result capture. Legacy
    // receipt-derived flags can outlive missing or incomplete result data.
    resultsRecorded: b.returnedAt != null,
  };
}

/** Actual sample length is Decimal(18,4), never a physical card count.
 * String input retains precision; existing numeric PATCH clients remain valid
 * only when their represented value fits the same explicit decimal grammar.
 */
export function parseActualSampleBatchQuantity(value: unknown): Prisma.Decimal | null {
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new DevelopmentDomainError('INVALID_INPUT', '实际数量须为非负十进制数或 null');
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(text)) throw new DevelopmentDomainError('INVALID_INPUT', '实际数量须为非负十进制数，最多14位整数及4位小数');
  return new Prisma.Decimal(text);
}
function serializeSeal(s: any) {
  return { ...s, createdAt: ser(s.createdAt), updatedAt: ser(s.updatedAt), deletedAt: s.deletedAt ? ser(s.deletedAt) : null, convertedAt: s.convertedAt ? ser(s.convertedAt) : null };
}

async function guardedSource(tx:any, model:string, id:string) {
  const initial=await tx[model].findFirst({where:{id,deletedAt:null}});
  if(!initial) return null;
  await assertDevelopmentOperationalWrite(tx,initial.developmentCaseId,'sample');
  const current=await tx[model].findFirst({where:{id,deletedAt:null}});
  if(!current || current.developmentCaseId!==initial.developmentCaseId) throw Object.assign(new Error('来源归属已变化，请刷新后重试'),{code:'DEVELOPMENT_SOURCE_CHANGED',statusCode:409});
  return current;
}

/** Discover exact related physical targets before source locks. Composite
 * parents follow Case→Seal→Batch, never acquire Batch after Sample. */
async function lockFabricOriginTargets(tx: any, batch: any, custody?: SampleCustodyAuthorization) {
  const bindings = await tx.sampleSource.findMany({ where: { sampleBatchId: batch.id, sourceRound: batch.round } });
  const sampleIds = [...new Set<string>(bindings.map((row: any) => row.sampleId))].sort();
  const hints = await sampleOriginLockHints(tx, sampleIds);
  if (custody) {
    // Union all discovered parents before locking the physical row. The ordinary
    // custody order places Relation before Batch; never acquire it afterwards.
    const tables = { case: 'DevelopmentCase', relation: 'Relation', seal: 'SealSample', batch: 'SampleBatch', order: 'Order', asset: 'ProductAsset', warehouse: 'Warehouse', sample: 'Sample', card: 'SampleCardItem' };
    const refs: Array<{ kind: keyof typeof tables; id: string }> = [...custody.lockRefs,
      ...[...hints.caseIds, batch.developmentCaseId].map(id => ({ kind: 'case' as const, id })),
      ...hints.sealIds.map(id => ({ kind: 'seal' as const, id })),
      ...[...hints.batchIds, batch.id].map(id => ({ kind: 'batch' as const, id }))];
    const order = Object.keys(tables), seen = new Set<string>();
    for (const ref of refs.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id))) {
      const key = `${ref.kind}:${ref.id}`; if (seen.has(key)) continue; seen.add(key);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${tables[ref.kind]}"`)} WHERE "id" = ${ref.id} FOR UPDATE`);
    }
  } else {
    await lockSampleOriginParents(tx, { caseIds: [...new Set([...hints.caseIds, batch.developmentCaseId])].sort(), sealIds: hints.sealIds,
      batchIds: [...new Set([...hints.batchIds, batch.id])].sort() });
  }
  if (JSON.stringify(await sampleOriginLockHints(tx, sampleIds)) !== JSON.stringify(hints)) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '样品精确来源集合已变化，请刷新');
  return sampleIds;
}

/** All required component origins must match current round/version and real
 * approval evidence. Unbound/case-only records are intentionally untouched. */
async function refreshFabricOriginConfirmation(tx: any, sampleIds: string[], now: bigint) {
  if (!sampleIds.length) return 0;
  const samples = await tx.sample.findMany({ where: { id: { in: sampleIds }, deletedAt: null, type: { in: ['dev','seal'] } }, orderBy: { id: 'asc' } });
  for (const sample of samples) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Sample" WHERE "id"=${sample.id} FOR UPDATE`);
  const fresh = await tx.sample.findMany({ where: { id: { in: samples.map((row: any) => row.id) }, deletedAt: null, type: { in: ['dev','seal'] } }, orderBy: { id: 'asc' } });
  const contexts = await readSampleOriginContexts(tx, fresh);
  const batchIds = [...new Set(contexts.flatMap(context => context.origins.map(origin => origin.sampleBatchId)))];
  const current = await tx.sampleBatch.findMany({ where: { id: { in: batchIds }, deletedAt: null } });
  let confirmed = 0;
  for (let i=0; i<fresh.length; i++) {
    const context = contexts[i];
    const allConfirmed = context.status === 'resolved' && context.currentUsable && context.origins.every(origin => current.some((batch: any) => batch.id === origin.sampleBatchId && batch.round === origin.sourceRound && batch.confirmStatus === 'confirmed'));
    const value = allConfirmed ? 'batch-confirmed' : null;
    if ((fresh[i].designConfirmStatus ?? null) !== value) await tx.sample.update({ where: { id: fresh[i].id }, data: { designConfirmStatus: value, updatedAt: now } });
    if (allConfirmed) confirmed++;
  }
  return confirmed;
}

async function findLiveCase(prisma: PrismaClient, caseId: string): Promise<any | null> {
  return prisma.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
}

// ────────────────────────────────────────────────────────────────────
// 开发供应商 DevelopmentSupplier
// ────────────────────────────────────────────────────────────────────

export async function listDevelopmentSuppliers(prisma: PrismaClient, caseId: string): Promise<Result<{ suppliers: any[] }>> {
  const devCase = await findLiveCase(prisma, caseId);
  if (!devCase) return fail('DEV_CASE_NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
  const suppliers = await prisma.developmentSupplier.findMany({
    where: { developmentCaseId: caseId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return { ok: true, data: { suppliers: suppliers.map(serializeSupplier) } };
}

export async function addDevelopmentSupplier(params: {
  prisma: PrismaClient;
  caseId: string;
  input: { supplierRelationId: string; supplierName?: string };
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ supplier: any }>> {
  const { prisma, caseId, input, actorId, ip } = params;
  const devCase = await findLiveCase(prisma, caseId);
  if (!devCase) return fail('DEV_CASE_NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
  const supplierRelationId = String(input?.supplierRelationId || '').trim();
  if (!supplierRelationId) return fail('INVALID_INPUT', 'supplierRelationId 必填（关系智库供应商档案）');
  const supplierName = String(input?.supplierName || '').trim() || null;
  const now = BigInt(Date.now());
  try {
    const supplier = await (prisma as any).$transaction(async (tx: any) => {
      await assertDevelopmentOperationalWrite(tx,caseId,'sample');
      if (!await findLiveCase(tx,caseId)) throw Object.assign(new Error('开发案不存在'),{code:'NOT_FOUND',statusCode:404});
      // This relation no longer has a composite unique constraint: a factory can
      // be associated repeatedly across real sampling rounds. Keep adding the
      // factory itself idempotent by reusing its latest association row.
      const existing = await tx.developmentSupplier.findFirst({
        where: { developmentCaseId: caseId, supplierRelationId, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
      }) ?? await tx.developmentSupplier.findFirst({
        where: { developmentCaseId: caseId, supplierRelationId, deletedAt: { not: null } },
        orderBy: { updatedAt: 'desc' },
      });
      const record = existing
        ? await tx.developmentSupplier.update({
            where: { id: existing.id },
            data: { supplierName: supplierName ?? existing.supplierName ?? null, deletedAt: null, updatedAt: now },
          })
        : await tx.developmentSupplier.create({
            data: {
              id: `DS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              developmentCaseId: caseId,
              supplierRelationId,
              supplierName,
              createdAt: now,
              updatedAt: now,
            },
          });
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-supplier',
        operation: existing ? 'update_development_supplier' : 'add_development_supplier',
        targetType: 'DevelopmentSupplier',
        targetId: record.id,
        before: existing ? { supplierRelationId } : undefined,
        after: { developmentCaseId: caseId, supplierRelationId, supplierName },
        ip: ip || null,
      });
      return record;
    });
    return { ok: true, data: { supplier: serializeSupplier(supplier) } };
  } catch (e: any) {
    return failFabricOperation(e, 'SUPPLIER_ADD_FAILED', '追加工厂失败，请稍后重试。');
  }
}

export async function updateDevelopmentSupplier(params: {
  prisma: PrismaClient;
  supplierId: string;
  input: { quoteNote?: string; leadTime?: string; trialConclusion?: string; notes?: string };
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ supplier: any }>> {
  const { prisma, supplierId, input, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    if (input.trialConclusion != null && input.trialConclusion !== '') {
      assertEnum(input.trialConclusion, TRIAL_CONCLUSIONS, '试样结论');
    }
    const supplier = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await guardedSource(tx,'developmentSupplier',supplierId);
      if (!existing) throw Object.assign(new Error('工厂试样记录不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const data: any = { updatedAt: now };
      for (const k of ['quoteNote', 'leadTime', 'trialConclusion', 'notes'] as const) {
        if (input[k] !== undefined) data[k] = input[k] === '' ? null : input[k];
      }
      const updated = await tx.developmentSupplier.update({ where: { id: supplierId }, data });
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-supplier',
        operation: 'update_development_supplier',
        targetType: 'DevelopmentSupplier',
        targetId: supplierId,
        before: { supplierRelationId: existing.supplierRelationId },
        after: { supplierRelationId: existing.supplierRelationId, ...data },
        ip: ip || null,
      });
      return updated;
    });
    return { ok: true, data: { supplier: serializeSupplier(supplier) } };
  } catch (e: any) {
    return failFabricOperation(e, 'SUPPLIER_UPDATE_FAILED', '更新工厂试样失败，请稍后重试。', ['NOT_FOUND', 'INVALID_INPUT']);
  }
}

export async function removeDevelopmentSupplier(params: {
  prisma: PrismaClient;
  supplierId: string;
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ supplier: { id: string } }>> {
  const { prisma, supplierId, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    await (prisma as any).$transaction(async (tx: any) => {
      const existing = await guardedSource(tx,'developmentSupplier',supplierId);
      if (!existing) throw Object.assign(new Error('工厂试样记录不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      await tx.developmentSupplier.update({ where: { id: supplierId }, data: { deletedAt: now, updatedAt: now } });
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-supplier',
        operation: 'remove_development_supplier',
        targetType: 'DevelopmentSupplier',
        targetId: supplierId,
        before: { supplierRelationId: existing.supplierRelationId },
        after: { supplierRelationId: existing.supplierRelationId, deletedAt: Number(now) },
        ip: ip || null,
      });
    });
    return { ok: true, data: { supplier: { id: supplierId } } };
  } catch (e: any) {
    return failFabricOperation(e, 'SUPPLIER_REMOVE_FAILED', '移除工厂失败，请稍后重试。', ['NOT_FOUND']);
  }
}

// ────────────────────────────────────────────────────────────────────
// 统一样品批次 SampleBatch
// ────────────────────────────────────────────────────────────────────

export async function listSampleBatches(prisma: PrismaClient, caseId: string, trustedActor?: TokenPayload): Promise<Result<{ batches: any[] }>> {
  try { await authorizeDevelopmentSource(prisma, trustedActor?.userId, trustedActor, caseId, { write: false }); }
  catch (error) {
    if (error instanceof DevelopmentDomainError) return fail(error.code, error.message, error.statusCode);
    return fail('BATCH_LIST_FAILED', '开发样品来源权限未能完整核对，请稍后重试。', 500);
  }
  const devCase = await findLiveCase(prisma, caseId);
  if (!devCase) return fail('DEV_CASE_NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
  const batches = await prisma.sampleBatch.findMany({
    where: { developmentCaseId: caseId, deletedAt: null },
    orderBy: [{ sampleType: 'asc' }, { createdAt: 'asc' }],
  });
  const roundRows = (prisma as any).developmentSampleRound?.findMany
    ? await (prisma as any).developmentSampleRound.findMany({ where: { developmentCaseId: caseId, round: { in: [...new Set(batches.map((batch: any) => batch.round))] }, deletedAt: null } })
    : [];
  const notesByRound = new Map((roundRows as any[]).map(round => [Number(round.round), round.notes ?? null]));
  const roundByNumber = new Map((roundRows as any[]).map(round => [Number(round.round), round]));
  const nativeVersionIds = [...new Set(batches.map((batch: any) => batch.sampleVersionId).filter(Boolean))];
  const versions = (prisma as any).developmentSampleVersion?.findMany && batches.length
    ? await (prisma as any).developmentSampleVersion.findMany({ where: { OR: [{ id: { in: nativeVersionIds } }, { parentVersionId: { in: nativeVersionIds } }], deletedAt: null } }) : [];
  const versionById = new Map((versions as any[]).map(version => [version.id, version]));
  const decisions = await readDevelopmentVersionDecisions(prisma, caseId, (versions as any[]).map(version => version.id));
  const assets = versions.length ? await (prisma as any).productAsset.findMany({ where: { sourceDevelopmentCaseId: caseId,
    sourceSampleVersionId: { in: (versions as any[]).map(version => version.id) }, deletedAt: null },
    orderBy: { id: 'asc' }, select: { id: true, sku: true, name: true, sourceSampleVersionId: true } }) : [];
  const assetByVersion = new Map<string, any>(assets.map((asset: any) => [asset.sourceSampleVersionId, { id: asset.id, sku: asset.sku, name: asset.name }]));
  const reviews = (prisma as any).developmentSampleQualityReview?.findMany && batches.length
    ? await (prisma as any).developmentSampleQualityReview.findMany({ where: { sampleBatchId: { in: batches.map((batch: any) => batch.id) }, sampleVersionId: null }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] })
    : [];
  return { ok: true, data: { batches: batches.map((batch: any) => {
    return serializeBatch({ ...batch, roundNotes: notesByRound.get(Number(batch.round)) ?? null,
      ...(decisions.get(batch.sampleVersionId) ?? { versionIdentityStatus: 'unknown', developmentQcReview: null, latestFormalQcReview: null, developmentQcHistory: [], versionConfirmation: null, versionConfirmationHistory: [] }),
      linkedAsset: assetByVersion.get(batch.sampleVersionId) ?? null,
      legacyDevelopmentQcReviews: (reviews as any[]).filter(review => review.sampleBatchId === batch.id).map(developmentQualityReviewSummary),
      microVersions: (versions as any[]).filter(version => version.parentVersionId === batch.sampleVersionId).map(version => ({ id: version.id, versionId: version.id,
        versionLabel: version.versionLabel, factoryCode: version.factoryCode ?? null, physicalSequence: version.physicalSequence ?? null, sourceVersionId: version.sourceVersionId ?? null, note: version.minorChangeNote, createdBy: version.createdBy, createdAt: Number(version.createdAt),
        linkedAsset: assetByVersion.get(version.id) ?? null, ...(decisions.get(version.id) ?? {}) })),
      ...(batch.sampleVersionId && versionById.has(batch.sampleVersionId) ? { trialTask: (() => {
        const version: any = versionById.get(batch.sampleVersionId);
        const roundInfo: any = roundByNumber.get(Number(batch.round));
        return { id: version.id, roundId: version.roundId, factoryCode: version.factoryCode ?? null, physicalSequence: version.physicalSequence ?? null, sourceVersionId: version.sourceVersionId ?? null, roundRequirementsSnapshot: version.roundRequirementsSnapshot ?? null,
          currentRoundRequirements: roundInfo?.notes ?? null, roundUpdatedAt: String(roundInfo?.updatedAt ?? 0),
          factoryRequirements: version.factoryRequirements ?? null, targetCompletionDate: version.targetCompletionDate ?? null,
          referenceAttachments: Array.isArray(version.referenceAttachments) ? version.referenceAttachments : [], updatedAt: String(version.updatedAt) };
      })() } : {}),
      resultsRecorded: batch.returnedAt != null,
    });
  }) } };
}

export async function createSampleBatch(params: {
  prisma: PrismaClient;
  caseId: string;
  input: {
    sampleType?: string;
    sampleTypes?: string[];
    supplierRelationId: string;
    supplierName?: string;
    specNote?: string;
    dyeLotNo?: string;
    colorRating?: number | null;
    sideDiff?: number;
    endDiff?: number;
    defectCauses?: string[];
    photos?: any;
    notes?: string;
    roundNotes?: string;
    factoryRequirements?: string;
    targetCompletionDate?: string;
    referenceAttachments?: string[];
    samplePlans?: Array<{ sampleType: string; quantity: number; unit: string }>;
    // DR-054 阶段 B：打样计划数量（开发案侧，不进样品间）
    planQuantity?: number;
    planUnit?: string;
    round?: number;
    sourceVersionId?: string;
  };
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ batch: any; batches?: any[] }>> {
  const { prisma, caseId, input, actorId, ip } = params;
  const devCase = await findLiveCase(prisma, caseId);
  if (!devCase) return fail('DEV_CASE_NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
  if (devCase.type !== 'fabric') return fail('NOT_FABRIC_CASE', `样品批次仅适用于面料开发案（当前类型 ${devCase.type}）`);
  const supplierRelationId = String(input?.supplierRelationId || '').trim();
  if (!supplierRelationId) return fail('INVALID_INPUT', 'supplierRelationId 必填（归属工厂）');
    const supplierName = String(input?.supplierName || '').trim() || null;
    const factoryRequirements = input.factoryRequirements == null ? null : String(input.factoryRequirements).trim();
    const targetCompletionDate = input.targetCompletionDate == null || input.targetCompletionDate === '' ? null : String(input.targetCompletionDate);
    const referenceAttachments = input.referenceAttachments ?? [];
    if (factoryRequirements && factoryRequirements.length > 8000) return fail('INVALID_INPUT', '工厂打样要求不能超过 8000 字');
    if (targetCompletionDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetCompletionDate)) return fail('INVALID_INPUT', '要求完成日期格式须为 YYYY-MM-DD');
    if (!Array.isArray(referenceAttachments) || referenceAttachments.length > 20 || referenceAttachments.some((item: unknown) => typeof item !== 'string' || !item.trim() || item.length > 2048)) return fail('INVALID_INPUT', '参考附件最多 20 项，每项须为有效链接');
  const now = BigInt(Date.now());
  try {
    const sampleTypes = [...new Set((Array.isArray(input?.sampleTypes) ? input.sampleTypes : [input?.sampleType]).filter(Boolean))] as string[];
    if (!sampleTypes.length || sampleTypes.length > SAMPLE_BATCH_TYPES.length || sampleTypes.some(type => !SAMPLE_BATCH_TYPES.includes(type as any))) {
      throw new DevelopmentDomainError('INVALID_INPUT', '请至少选择一种有效的试样形态');
    }
    const samplePlans = input.samplePlans;
    if (samplePlans !== undefined && (!Array.isArray(samplePlans) || samplePlans.length !== sampleTypes.length
      || sampleTypes.some(type => {
        const plan = samplePlans.find(item => item.sampleType === type);
        const expectedUnit = type === 'yardage' ? '米' : '份';
        return !plan || !Number.isFinite(plan.quantity) || plan.quantity <= 0 || type !== 'yardage' && !Number.isInteger(plan.quantity) || plan.unit !== expectedUnit;
      }))) throw new DevelopmentDomainError('INVALID_INPUT', '色样/手织样须按“份”登记，米样须按“米”登记；每种形态须填写有效数量');
    const planByType = new Map((samplePlans ?? []).map(plan => [plan.sampleType, plan]));
    const batches = await (prisma as any).$transaction(async (tx: any) => {
      await assertDevelopmentOperationalWrite(tx,caseId,'sample');
      if (!await findLiveCase(tx,caseId)) throw Object.assign(new Error('开发案不存在'),{code:'NOT_FOUND',statusCode:404});
      // 归属工厂未在开发供应商列表时自动登记（保证每批都有工厂归属留痕）
      const existingSupplier = await tx.developmentSupplier.findFirst({
        where: { developmentCaseId: caseId, supplierRelationId, deletedAt: null },
      });
      if (!existingSupplier || existingSupplier.deletedAt) {
        await tx.developmentSupplier.create({
          data: {
            id: `DS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            developmentCaseId: caseId,
            supplierRelationId,
            supplierName,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      const existingBatches = await tx.sampleBatch.findMany({
        where: { developmentCaseId: caseId, deletedAt: null, sampleType: { in: [...SAMPLE_BATCH_TYPES] } },
        orderBy: [{ round: 'asc' }, { createdAt: 'asc' }],
      });
      const requestedRound = input.round == null ? Math.max(0, ...existingBatches.map((b: any) => Number(b.round) || 0)) + 1 : Number(input.round);
      if (!Number.isInteger(requestedRound) || requestedRound < 1) throw new DevelopmentDomainError('INVALID_INPUT', '轮次号必须是大于 0 的整数');
      const roundRecord = await ensureDevelopmentSampleRound(tx, { developmentCaseId: caseId, round: requestedRound, notes: input?.roundNotes ? String(input.roundNotes).trim() : null, actorId, now });
      const versionRecord = await ensureDevelopmentSampleMajorVersion(tx, {
        round: roundRecord, supplierRelationId, supplierName, sourceVersionId: input.sourceVersionId, factoryRequirements,
        targetCompletionDate, referenceAttachments, actorId, now,
      });
      const versionLabel = versionRecord.versionLabel;
      let formIndex = 0;
      const createdBatches = [];
      for (const sampleType of sampleTypes) {
        const created = await tx.sampleBatch.create({
          data: {
          id: `SB-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          batchCode: await nextBusinessNumber(tx, 'SB', undefined, {
            occupied: async batchCode => !!(await tx.sampleBatch.findFirst({ where: { batchCode }, select: { id: true } })),
          }),
          developmentCaseId: caseId,
          supplierRelationId,
          supplierName,
          sampleType,
          specNote: input?.specNote || null,
          round: requestedRound,
          versionLabel,
          sampleVersionId: versionRecord.id,
          formIndex,
          status: 'pending',
          // Result-only fields stay empty until the factory returns the sample.
          dyeLotNo: null,
          colorRating: null,
          sideDiff: null,
          endDiff: null,
          defectCauses: [],
          photos: null,
          notes: null,
          returnedAt: null,
          returnedBy: null,
          returnRequestKey: null,
          returnFingerprint: null,
          planQuantity: planByType.has(sampleType) ? new Prisma.Decimal(String(planByType.get(sampleType)!.quantity)) : sampleType === 'yardage' && input?.planQuantity != null ? new Prisma.Decimal(String(input.planQuantity)) : null,
          planUnit: planByType.get(sampleType)?.unit ?? (sampleType === 'yardage' && input?.planUnit ? String(input.planUnit).trim() || null : null),
          createdAt: now,
          updatedAt: now,
          },
        });
        await writeRouteAuditLog({
          prisma: tx, actorId, source: 'route:dev:fabric-batch', operation: 'create_sample_batch',
          targetType: 'SampleBatch', targetId: created.id,
          after: { developmentCaseId: caseId, batchCode: created.batchCode, sampleType, supplierRelationId, round: requestedRound, versionLabel, formIndex, sampleVersionId: versionRecord.id, sourceVersionId: versionRecord.sourceVersionId, physicalSequence: versionRecord.physicalSequence },
          ip: ip || null,
        });
        createdBatches.push(created);
        formIndex++;
      }
      return createdBatches;
    });
    const roundNotes = input?.roundNotes?.trim() || null;
    return { ok: true, data: { batch: serializeBatch({ ...batches[0], roundNotes }), batches: batches.map((batch: any) => serializeBatch({ ...batch, roundNotes })) } };
  } catch (e: any) {
    return failFabricOperation(e, 'BATCH_CREATE_FAILED', '登记样品批次失败，请稍后重试。', ['INVALID_INPUT']);
  }
}

export async function updateSampleBatch(params: {
  prisma: PrismaClient;
  batchId: string;
  input: {
    specNote?: string;
    dyeLotNo?: string;
    colorRating?: number | null;
    sideDiff?: number;
    endDiff?: number;
    defectCauses?: string[];
    photos?: any;
    notes?: string;
    // DR-054 阶段 B：计划数量（打样时）/ 实际数量（收到结果时）
    planQuantity?: number;
    planUnit?: string;
    actualQuantity?: number | string | null;
    actualUnit?: string;
  };
  actorId: string;
  ip?: string | null;
  /** External receipt transaction owns rollback, including both mandatory audits. */
  tx?: any;
}): Promise<Result<{ batch: any }>> {
  const { prisma, batchId, input, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    const mutate = async (tx: any) => {
      const existing = await guardedSource(tx,'sampleBatch',batchId);
      if (!existing) throw Object.assign(new Error('样品批次不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const data: any = { updatedAt: now };
      if (input.specNote !== undefined) data.specNote = input.specNote === '' ? null : input.specNote;
      if (input.notes !== undefined) data.notes = input.notes === '' ? null : input.notes;
      if (input.photos !== undefined) data.photos = input.photos;
      if (input.dyeLotNo !== undefined) data.dyeLotNo = input.dyeLotNo === '' ? null : input.dyeLotNo;
      if (input.colorRating !== undefined) data.colorRating = assertRating(input.colorRating) ?? null;
      if (input.sideDiff !== undefined) data.sideDiff = assertRating(input.sideDiff) ?? null;
      if (input.endDiff !== undefined) data.endDiff = assertRating(input.endDiff) ?? null;
      if (input.defectCauses !== undefined) data.defectCauses = sanitizeDefectCauses(input.defectCauses);
      // DR-054 阶段 B：数量字段（非负数值校验；单位去空白）
      if (input.planQuantity !== undefined) data.planQuantity = input.planQuantity === null || Number.isNaN(Number(input.planQuantity)) ? null : new Prisma.Decimal(String(Math.max(0, Number(input.planQuantity))));
      if (input.planUnit !== undefined) data.planUnit = input.planUnit === '' ? null : String(input.planUnit).trim();
      if (input.actualQuantity !== undefined) data.actualQuantity = parseActualSampleBatchQuantity(input.actualQuantity);
      if (input.actualUnit !== undefined) data.actualUnit = input.actualUnit === '' ? null : String(input.actualUnit).trim();
      const outcomeMutationRequested = (['specNote','planQuantity','planUnit','actualQuantity','actualUnit','dyeLotNo','colorRating','sideDiff','endDiff','defectCauses','photos','notes'] as const).some(key => input[key] !== undefined);
      const qualityReview = tx.developmentSampleQualityReview?.findFirst
        ? await tx.developmentSampleQualityReview.findFirst({ where: { sampleBatchId: batchId }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] }) : null;
      if (outcomeMutationRequested && (existing.returnedAt != null || qualityReview)) {
        throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '返样成果已登记并冻结；若要修改，请保留原版本并新建下一轮/版本');
      }
      const physicalContentChanged = (['specNote','dyeLotNo','colorRating','sideDiff','endDiff','defectCauses','photos','notes'] as const).some(key => data[key] !== undefined && JSON.stringify(data[key]) !== JSON.stringify(existing[key] ?? null));
      if (physicalContentChanged) {
        const origins = await tx.sampleSource.findMany({ where: { sampleBatchId: batchId, sourceRound: existing.round } });
        if (origins.length || existing.status === 'approved') throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '本轮已有认可或实物来源，规格变更须先明确复样并进入新轮，不能覆盖原实物版本');
      }
      const updated = await tx.sampleBatch.update({ where: { id: batchId }, data });
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-batch',
        operation: 'update_sample_batch',
        targetType: 'SampleBatch',
        targetId: batchId,
        before: { batchCode: existing.batchCode, status: existing.status },
        after: { batchCode: existing.batchCode, ...data, updatedAt: now.toString(),
          ...(data.actualQuantity !== undefined ? { actualQuantity: data.actualQuantity?.toString() ?? null } : {}) },
        ip: ip || null,
      });
      return updated;
    };
    const batch = params.tx ? await mutate(params.tx) : await (prisma as any).$transaction(mutate);
    return { ok: true, data: { batch: serializeBatch(batch) } };
  } catch (e: any) {
    return failFabricOperation(e, 'BATCH_UPDATE_FAILED', '更新样品批次失败，请稍后重试。', ['NOT_FOUND', 'INVALID_INPUT']);
  }
}

/**
 * DR-054 阶段 B：批次级确认（确认锚点 = 打样批次）。
 * 批次内所有样品一起被确认；已确认批次不可重复确认（幂等）。
 * 确认不驱动实物创建（实物在收到实际结果时登记）。
 * 同步仅消费精确 SampleSource 的批次/轮次/冻结版本；组合必须全部确认。
 */
export async function confirmSampleBatch(params: {
  prisma: PrismaClient;
  batchId: string;
  actorId: string;
  trustedActor?: TokenPayload;
  input?: FabricCommand;
  ip?: string | null;
}): Promise<Result<{ batch: any; sampleCount: number }>> {
  const { prisma, batchId, actorId, ip, trustedActor, input = {} } = params;
  const now = BigInt(Date.now());
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      let existing = await guardedSource(tx,'sampleBatch',batchId);
      if (!existing) throw Object.assign(new Error('样品批次不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const originTargetIds = await lockFabricOriginTargets(tx, existing);
      existing = await lockFabricBatch(tx, batchId);
      await authorizeDevelopmentSource(tx, actorId, trustedActor, existing.developmentCaseId);
      const replay = checkFabricCommand(existing, actorId, 'confirm', input);
      if (replay) return { updated: { ...existing, commandAck: replay }, sampleCount: 0 };
      if (existing.confirmStatus === 'confirmed') {
        throw Object.assign(new Error(`批次 ${existing.batchCode} 已确认，不可重复确认`), { code: 'ALREADY_CONFIRMED', statusCode: 409 });
      }
      if (existing.status !== 'approved') {
        throw Object.assign(new Error('请先完成样品认可，再确认设计批次；待打样、制作中和需复样的批次不能确认'), { code: 'BATCH_NOT_APPROVED', statusCode: 409 });
      }
      await assertFabricBatchEvidence(tx, existing);
      const updated = await tx.sampleBatch.update({
        where: { id: batchId },
        data: { confirmStatus: 'confirmed', confirmedAt: now, confirmedBy: actorId, updatedAt: now },
      });
      const sampleCount = await refreshFabricOriginConfirmation(tx, originTargetIds, now);
      const auditId = await writeRouteAuditLog({
        prisma: tx, actorId, source: 'route:dev:fabric-batch', operation: 'confirm_sample_batch',
        targetType: 'SampleBatch', targetId: batchId,
        before: { batchCode: existing.batchCode, confirmStatus: existing.confirmStatus },
        after: { batchCode: existing.batchCode, confirmStatus: 'confirmed', sampleCount,
          roundFact: { kind: 'confirm', before: fabricBatchSnapshot(existing), after: fabricBatchSnapshot(updated) } },
        ip: ip || null,
      });
      const recorded = await appendFabricEvent(tx, existing, updated, 'confirm', actorId, auditId, input);
      return { updated: recorded, sampleCount };
    });
    return { ok: true, data: { batch: serializeBatch(result.updated), sampleCount: result.sampleCount } };
  } catch (e: any) {
    return failFabricOperation(e, 'BATCH_CONFIRM_FAILED', '确认样品批次失败，请稍后重试。', ['NOT_FOUND', 'ALREADY_CONFIRMED', 'BATCH_NOT_APPROVED']);
  }
}

export async function deleteSampleBatch(params: {
  prisma: PrismaClient;
  batchId: string;
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ batch: { id: string } }>> {
  const { prisma, batchId, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    await (prisma as any).$transaction(async (tx: any) => {
      const existing = await guardedSource(tx,'sampleBatch',batchId);
      if (!existing) throw Object.assign(new Error('样品批次不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const originTargetIds = await lockFabricOriginTargets(tx, existing);
      const qualityReview = tx.developmentSampleQualityReview?.findFirst
        ? await tx.developmentSampleQualityReview.findFirst({ where: { sampleBatchId: batchId }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] }) : null;
      const physicalCards = tx.sampleCardItem?.findMany
        ? await tx.sampleCardItem.findMany({ where: { batchId, deletedAt: null }, select: { id: true } }) : [];
      if (existing.returnedAt != null || qualityReview || physicalCards.length)
        throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '返样结果、QC 评审或样品仓库已有留痕，不可删除原试样；请建立新版本');
      const inSeal = await tx.sealSampleBatch.findFirst({ where: { sampleBatchId: batchId } });
      if (inSeal) throw Object.assign(new Error('该批次已被封样引用，不可删除（可先调整封样组合）'), { code: 'REFERENCED_BY_SEAL', statusCode: 409 });
      await tx.sampleBatch.update({ where: { id: batchId }, data: { deletedAt: now, updatedAt: now } });
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-batch',
        operation: 'delete_sample_batch',
        targetType: 'SampleBatch',
        targetId: batchId,
        before: { batchCode: existing.batchCode, status: existing.status },
        after: { batchCode: existing.batchCode, deletedAt: Number(now) },
        ip: ip || null,
      });
      await refreshFabricOriginConfirmation(tx, originTargetIds, now);
    });
    return { ok: true, data: { batch: { id: batchId } } };
  } catch (e: any) {
    return failFabricOperation(e, 'BATCH_DELETE_FAILED', '删除样品批次失败，请稍后重试。', ['NOT_FOUND', 'REFERENCED_BY_SEAL']);
  }
}

/** 推进批次状态机（start/send/approve/revise），revising→making 时 round+1 */
export async function advanceSampleBatchStage(params: {
  prisma: PrismaClient;
  batchId: string;
  action: SampleBatchAction;
  input: FabricCommand & {
    physicalShipment?: PhysicalShipmentInput;
    sentDate?: string;
    courier?: string;
    trackingNumber?: string;
    shippingFee?: number;
    feedback?: string;
    feedbackDate?: string;
    notes?: string;
  };
  actorId: string;
  trustedActor?: TokenPayload;
  ip?: string | null;
}): Promise<Result<{ batch: any }>> {
  const { prisma, batchId, action, input, actorId, ip, trustedActor } = params;
  const rule = ACTION_RULES[action];
  if (!rule) return fail('INVALID_ACTION', `非法动作：${action}（可选 start/send/approve/revise）`);
  const now = BigInt(Date.now());
  try {
    const batch = await (prisma as any).$transaction(async (tx: any) => {
      let existing = await guardedSource(tx,'sampleBatch',batchId);
      if (!existing) throw Object.assign(new Error('样品批次不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const custody = action === 'send' && input.physicalShipment && trustedActor
        ? await authorizeSampleCustody({ db: tx, actor: trustedActor, subject: { kind: 'card', id: input.physicalShipment.itemId }, mode: 'write' }) : undefined;
      const originTargetIds = await lockFabricOriginTargets(tx, existing, custody);
      existing = await lockFabricBatch(tx, batchId);
      await authorizeDevelopmentSource(tx, actorId, trustedActor, existing.developmentCaseId);
      const replay = checkFabricCommand(existing, actorId, action, input);
      if (replay) return { ...existing, commandAck: replay };
      const current = existing.status as SampleBatchStatus;
      if (action === 'revise' && existing.sampleVersionId) {
        throw new DevelopmentDomainError('NEW_VERSION_REQUIRED', '这条实物样版本必须保留原记录；复样请新建下一轮/工厂版本，不能把原样改成新样');
      }
      const invalidatedApproval = action === 'revise' && current === 'approved' && !fabricBatchEligibility(existing).eligible;
      if (!rule.from.includes(current) && !invalidatedApproval) {
        throw Object.assign(new Error(`当前状态 ${current} 不允许执行 ${action}`), { code: 'INVALID_TRANSITION', statusCode: 409 });
      }
      if (action === 'approve' && !fabricBatchEligibility(existing).approvalAllowed) {
        throw new DevelopmentDomainError('DEVELOPMENT_NOT_READY', '客户当前要求重打或已拒绝，请先处理复样和本轮反馈，不能确认原样品');
      }
      if (action === 'revise' && !input.feedback?.trim()) throw new DevelopmentDomainError('INVALID_INPUT', '请填写本轮复样原因');
      const data: any = { status: rule.to, updatedAt: now };
      if (action === 'start' && current === 'revising') {
        data.round = existing.round + 1;
        Object.assign(data, invalidateFabricProjection(), { sentDate: null, courier: null, trackingNumber: null, shippingFee: null,
          customerStatus: null, customerFeedbackNote: null, customerFeedbackDate: null, feedback: null, feedbackDate: null });
      }
      let physicalShipment: Awaited<ReturnType<typeof shipPhysicalSampleInTransaction>> | null = null;
      if (action === 'send') {
        const cards = await tx.sampleCardItem.findMany({ where: { batchId, deletedAt: null }, orderBy: { id: 'asc' } });
        if (cards.some((card: any) => !readBatchReceiptSnapshot(card.receiptSnapshot)))
          throw new PhysicalShipmentError('PHYSICAL_RECEIPT_UNVERIFIED', '本批次存在来源不完整的实物，请先核对原收样记录。');
        const currentCards = cards.filter((card: any) => readBatchReceiptSnapshot(card.receiptSnapshot)?.sourceRound === existing.round);
        if (existing.sampleVersionId && !currentCards.length)
          throw new PhysicalShipmentError('PHYSICAL_SHIPMENT_REQUIRED', '该版本尚未登记对应实物样，请先在开发返样成果中登记。');
        if (currentCards.length && !input.physicalShipment)
          throw new PhysicalShipmentError('PHYSICAL_SHIPMENT_REQUIRED', '请选择本轮实际寄出的实物及数量，寄样会同步更新样品仓库。');
        if (input.physicalShipment) {
          if (!trustedActor || trustedActor.userId !== actorId) throw new PhysicalShipmentError('UNAUTHORIZED', '寄样须使用当前登录账号。', 401);
          if (!input.requestKey) throw new PhysicalShipmentError('INVALID_INPUT', '实物寄样须携带原操作编号和版本。', 400);
          const owner = await tx.developmentCase.findFirst({ where: { id: existing.developmentCaseId, deletedAt: null } });
          if (input.physicalShipment.relationId && input.physicalShipment.relationId !== owner?.customerRelationId)
            throw new PhysicalShipmentError('PHYSICAL_SOURCE_MISMATCH', '收件客户与当前开发案不一致。');
          physicalShipment = await shipPhysicalSampleInTransaction(tx, trustedActor, input.physicalShipment, {
            source: { batchId, devCaseId: existing.developmentCaseId }, eventId: `fabric-batch:${batchId}:${actorId}:${input.requestKey}`,
            occurredAt: Number(now), expectedGuard: custody?.guard, assertSource: (card) => {
              const receipt = readBatchReceiptSnapshot(card.receiptSnapshot);
              if (!receipt || receipt.sourceRound !== existing.round || receipt.batchId !== existing.id
                || receipt.developmentCaseId !== existing.developmentCaseId || receipt.factoryId !== existing.supplierRelationId
                || receipt.sampleType !== existing.sampleType || receipt.batchCode !== existing.batchCode
                || receipt.cardType !== card.cardType || receipt.physicalUnit !== card.unit
                || receipt.sourceFingerprint !== sampleOriginFingerprint(snapshotSampleOrigin(existing, owner)))
                throw new PhysicalShipmentError('PHYSICAL_SOURCE_MISMATCH', '所选实物缺少当前轮次的准确收样证明，请核对来源。');
            },
          });
        }
        data.sentDate = input.sentDate ?? todayYmd();
        if (input.courier !== undefined) data.courier = input.courier || null;
        if (input.trackingNumber !== undefined) data.trackingNumber = input.trackingNumber || null;
        if (input.shippingFee !== undefined) {
          const fee = input.shippingFee === null ? null : Number(input.shippingFee);
          if (fee != null && (!Number.isFinite(fee) || fee < 0)) throw Object.assign(new Error('邮寄费必须是非负数值'), { code: 'INVALID_INPUT' , statusCode: 400 });
          data.shippingFee = fee;
        }
      }
      if (action === 'approve') {
        data.approvedAt = now;
        data.approvedBy = actorId;
        if (input.feedback !== undefined) data.feedback = input.feedback || null;
        if (input.feedbackDate !== undefined) data.feedbackDate = input.feedbackDate || null;
      }
      if (action === 'revise') {
        if (input.feedback !== undefined) data.feedback = input.feedback || null;
        data.feedbackDate = input.feedbackDate ?? todayYmd();
        Object.assign(data, invalidateFabricProjection());
      }
      if (input.notes !== undefined) data.notes = input.notes || null;
      const updated = await tx.sampleBatch.update({ where: { id: batchId }, data });
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-batch',
        operation: 'advance_sample_batch',
        targetType: 'SampleBatch',
        targetId: batchId,
        before: { batchCode: existing.batchCode, status: current, round: existing.round },
        after: { batchCode: existing.batchCode, status: rule.to, round: updated.round, action, physicalShipment,
          roundFact: { kind: action, before: fabricBatchSnapshot(existing), after: fabricBatchSnapshot(updated) },
          ...(action === 'approve' ? { originSnapshot: snapshotSampleOrigin(updated, await tx.developmentCase.findFirst({ where: { id: updated.developmentCaseId, deletedAt: null } })) } : {}) },
        ip: ip || null,
      });
      const recorded = await appendFabricEvent(tx, existing, updated, action, actorId, auditId, input);
      if (action === 'revise' || action === 'start') await refreshFabricOriginConfirmation(tx, originTargetIds, now);
      return recorded;
    });
    return { ok: true, data: { batch: serializeBatch(batch) } };
  } catch (e: any) {
    if (e instanceof PhysicalShipmentError || e instanceof SampleCustodyAuthorizationError) return fail(e.code, e.message, e.status);
    return failFabricOperation(e, 'BATCH_STAGE_FAILED', '推进样品批次失败，请稍后重试。', ['NOT_FOUND', 'INVALID_TRANSITION', 'INVALID_INPUT']);
  }
}

/** lab-dip 客户判定（approved/rejected/needs_recast）；approved + asSealed → 该开发案唯一封样基准（自动切换） */
export async function submitBatchCustomerFeedback(params: {
  prisma: PrismaClient;
  batchId: string;
  input: FabricCommand & { status: string; note?: string; feedbackDate?: string; asSealed?: boolean };
  actorId: string;
  trustedActor?: TokenPayload;
  ip?: string | null;
}): Promise<Result<{ batch: any }>> {
  const { prisma, batchId, input, actorId, ip, trustedActor } = params;
  const now = BigInt(Date.now());
  try {
    const status = assertEnum(input?.status, CUSTOMER_STATUSES, '客户判定');
    const batch = await (prisma as any).$transaction(async (tx: any) => {
      let existing = await guardedSource(tx,'sampleBatch',batchId);
      if (!existing) throw Object.assign(new Error('样品批次不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      const originTargetIds = await lockFabricOriginTargets(tx, existing);
      existing = await lockFabricBatch(tx, batchId);
      await authorizeDevelopmentSource(tx, actorId, trustedActor, existing.developmentCaseId);
      const replay = checkFabricCommand(existing, actorId, 'feedback', input);
      if (replay) return { ...existing, commandAck: replay };
      if (existing.sampleType !== 'lab-dip') {
        throw Object.assign(new Error('客户判定仅适用于色样（lab-dip）批次'), { code: 'NOT_LAB_DIP', statusCode: 400 });
      }
      if (!['sent', 'approved'].includes(existing.status)) throw new DevelopmentDomainError('DEVELOPMENT_NOT_READY', '请先完成本轮制作与寄送，再登记本轮客户批色');
      const data: any = {
        customerStatus: status,
        customerFeedbackNote: input.note || null,
        customerFeedbackDate: input.feedbackDate ?? todayYmd(),
        updatedAt: now,
      };
      const replacedBaselines = status === 'approved' && input.asSealed
        ? await tx.sampleBatch.findMany({ where: { developmentCaseId: existing.developmentCaseId, id: { not: batchId }, deletedAt: null, approvedAsSealed: true } }) : [];
      // New customer feedback replaces current permission, never the prior fact.
      // Even a positive revision must be recognized explicitly before reuse.
      Object.assign(data, invalidateFabricProjection());
      if (existing.status === 'approved') data.status = 'sent';
      if (status === 'approved' && input.asSealed) {
        data.approvedAsSealed = true;
        // 同开发案唯一基准：清空其他批次的封样基准
        await tx.sampleBatch.updateMany({
          where: { developmentCaseId: existing.developmentCaseId, id: { not: batchId }, deletedAt: null },
          data: { approvedAsSealed: false, updatedAt: now },
        });
      }
      const updated = await tx.sampleBatch.update({ where: { id: batchId }, data });
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-batch',
        operation: 'submit_batch_customer_feedback',
        targetType: 'SampleBatch',
        targetId: batchId,
        before: { batchCode: existing.batchCode, customerStatus: existing.customerStatus },
        after: { batchCode: existing.batchCode, customerStatus: status, asSealed: data.approvedAsSealed ?? false,
          replacedBaselines: replacedBaselines.map((batch: any) => ({ batchId: batch.id, before: fabricBatchSnapshot(batch), after: fabricBatchSnapshot({ ...batch, approvedAsSealed: false, updatedAt: now }) })),
          roundFact: { kind: 'feedback', before: fabricBatchSnapshot(existing), after: fabricBatchSnapshot(updated) } },
        ip: ip || null,
      });
      for (const baseline of replacedBaselines) await appendFabricEvent(tx, baseline, { ...baseline, approvedAsSealed: false, updatedAt: now }, 'baseline_replaced', actorId, auditId);
      const recorded = await appendFabricEvent(tx, existing, updated, 'feedback', actorId, auditId, input);
      await refreshFabricOriginConfirmation(tx, originTargetIds, now);
      return recorded;
    });
    return { ok: true, data: { batch: serializeBatch(batch) } };
  } catch (e: any) {
    return failFabricOperation(e, 'BATCH_FEEDBACK_FAILED', '客户判定结果暂不可确认，请核对原批次后重试。', ['NOT_FOUND', 'NOT_LAB_DIP', 'INVALID_INPUT']);
  }
}

// ────────────────────────────────────────────────────────────────────
// 封样 SealSample（同厂批次组合）
// ────────────────────────────────────────────────────────────────────

export async function listSealSamples(prisma: PrismaClient, caseId: string): Promise<Result<{ seals: any[] }>> {
  const devCase = await findLiveCase(prisma, caseId);
  if (!devCase) return fail('DEV_CASE_NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
  const seals = await prisma.sealSample.findMany({
    where: { developmentCaseId: caseId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  const links = await prisma.sealSampleBatch.findMany({
    where: { sealSampleId: { in: seals.map((s: any) => s.id) } },
  });
  const bySeal = new Map<string, string[]>();
  for (const l of links) {
    const arr = bySeal.get(l.sealSampleId) ?? [];
    arr.push(l.sampleBatchId);
    bySeal.set(l.sealSampleId, arr);
  }
  return {
    ok: true,
    data: {
      seals: seals.map((s: any) => ({ ...serializeSeal(s), batchIds: bySeal.get(s.id) ?? [] })),
    },
  };
}

export async function createSealSample(params: {
  prisma: PrismaClient;
  caseId: string;
  input: { batchIds: string[]; name?: string; standardNo?: string; retainLocation?: string; qualityNote?: string; customerRelationId?: string; customerName?: string; notes?: string };
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ seal: any }>> {
  const { prisma, caseId, input, actorId, ip } = params;
  const devCase = await findLiveCase(prisma, caseId);
  if (!devCase) return fail('DEV_CASE_NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
  const batchIds = Array.isArray(input?.batchIds) ? [...new Set(input.batchIds.map((b: any) => String(b)))] : [];
  if (batchIds.length === 0) return fail('INVALID_INPUT', '封样至少选择 1 个样品批次');
  const now = BigInt(Date.now());
  try {
    const seal = await (prisma as any).$transaction(async (tx: any) => {
      await assertDevelopmentOperationalWrite(tx,caseId,'sample');
      if (!await findLiveCase(tx,caseId)) throw Object.assign(new Error('开发案不存在'),{code:'NOT_FOUND',statusCode:404});
      const batches = await tx.sampleBatch.findMany({ where: { id: { in: batchIds }, developmentCaseId: caseId, deletedAt: null } });
      if (batches.length !== batchIds.length) {
        throw Object.assign(new Error('存在不属于本开发案或已删除的样品批次'), { code: 'BATCH_NOT_IN_CASE', statusCode: 400 });
      }
      const suppliers = new Set(batches.map((b: any) => b.supplierRelationId));
      if (suppliers.size !== 1) {
        throw Object.assign(new Error('封样只能组合同一工厂的样品批次（跨厂组合禁止）'), { code: 'CROSS_SUPPLIER_SEAL', statusCode: 400 });
      }
      const supplierRelationId = batches[0].supplierRelationId;
      const supplierName = batches[0].supplierName || null;
      const created = await tx.sealSample.create({
        data: {
          id: `SEAL-${randomUUID()}`,
          sealCode: await nextBusinessNumber(tx, 'SEAL', undefined, {
            occupied: async sealCode => !!(await tx.sealSample.findFirst({ where: { sealCode }, select: { id: true } })),
          }),
          developmentCaseId: caseId,
          supplierRelationId,
          name: input?.name || null,
          standardNo: input?.standardNo || null,
          retainLocation: input?.retainLocation || null,
          qualityNote: input?.qualityNote || null,
          customerRelationId: input?.customerRelationId || null,
          customerName: input?.customerName || null,
          status: 'draft',
          notes: input?.notes || null,
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const b of batches) {
        await tx.sealSampleBatch.create({
          data: {
            id: `SSB-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            sealSampleId: created.id,
            sampleBatchId: b.id,
          },
        });
      }
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-seal',
        operation: 'create_seal_sample',
        targetType: 'SealSample',
        targetId: created.id,
        after: { developmentCaseId: caseId, sealCode: created.sealCode, supplierRelationId, batchIds },
        ip: ip || null,
      });
      return created;
    });
    return { ok: true, data: { seal: { ...serializeSeal(seal), batchIds } } };
  } catch (e: any) {
    return failFabricOperation(e, 'SEAL_CREATE_FAILED', '封样创建结果暂不可确认，请核对原开发案后重试。',
      ['NOT_FOUND', 'BATCH_NOT_IN_CASE', 'CROSS_SUPPLIER_SEAL']);
  }
}

export async function updateSealSample(params: {
  prisma: PrismaClient;
  sealId: string;
  input: {
    batchIds?: string[];
    name?: string;
    standardNo?: string;
    retainLocation?: string;
    qualityNote?: string;
    customerRelationId?: string;
    customerName?: string;
    notes?: string;
  };
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ seal: any }>> {
  const { prisma, sealId, input, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    const seal = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await guardedSource(tx,'sealSample',sealId);
      if (!existing) throw Object.assign(new Error('封样不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      if (existing.status === 'converted') {
        throw Object.assign(new Error('已转档的封样不可修改'), { code: 'LOCKED', statusCode: 409 });
      }
      if (input.batchIds !== undefined && existing.status === 'sealed') {
        throw Object.assign(new Error('已封样的封样不可调整批次组合'), { code: 'LOCKED', statusCode: 409 });
      }
      const data: any = { updatedAt: now };
      for (const k of ['name', 'standardNo', 'retainLocation', 'qualityNote', 'customerRelationId', 'customerName', 'notes'] as const) {
        if (input[k] !== undefined) data[k] = input[k] === '' ? null : input[k];
      }
      let batchIds: string[] | undefined;
      if (input.batchIds !== undefined) {
        batchIds = [...new Set(input.batchIds.map((b: any) => String(b)))];
        if (batchIds.length === 0) throw Object.assign(new Error('封样至少保留 1 个样品批次'), { code: 'INVALID_INPUT' , statusCode: 400 });
        const batches = await tx.sampleBatch.findMany({ where: { id: { in: batchIds }, developmentCaseId: existing.developmentCaseId, deletedAt: null } });
        if (batches.length !== batchIds.length) throw Object.assign(new Error('存在不属于本开发案或已删除的样品批次'), { code: 'BATCH_NOT_IN_CASE', statusCode: 400 });
        const suppliers = new Set(batches.map((b: any) => b.supplierRelationId));
        if (suppliers.size !== 1) throw Object.assign(new Error('封样只能组合同一工厂的样品批次（跨厂组合禁止）'), { code: 'CROSS_SUPPLIER_SEAL', statusCode: 400 });
        data.supplierRelationId = batches[0].supplierRelationId;
        data.supplierName = batches[0].supplierName || null;
      }
      const updated = await tx.sealSample.update({ where: { id: sealId }, data });
      if (batchIds) {
        await tx.sealSampleBatch.deleteMany({ where: { sealSampleId: sealId } });
        for (const b of batchIds) {
          await tx.sealSampleBatch.create({
            data: { id: `SSB-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, sealSampleId: sealId, sampleBatchId: b },
          });
        }
      }
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-seal',
        operation: 'update_seal_sample',
        targetType: 'SealSample',
        targetId: sealId,
        before: { sealCode: existing.sealCode, status: existing.status, supplierRelationId: existing.supplierRelationId },
        after: { sealCode: existing.sealCode, ...data, ...(batchIds ? { batchIds } : {}) },
        ip: ip || null,
      });
      return updated;
    });
    const links = await prisma.sealSampleBatch.findMany({ where: { sealSampleId: sealId } });
    return { ok: true, data: { seal: { ...serializeSeal(seal), batchIds: links.map((l: any) => l.sampleBatchId) } } };
  } catch (e: any) {
    return failFabricOperation(e, 'SEAL_UPDATE_FAILED', '封样更新结果暂不可确认，请核对原开发案后重试。',
      ['NOT_FOUND', 'LOCKED', 'BATCH_NOT_IN_CASE', 'CROSS_SUPPLIER_SEAL']);
  }
}

export async function deleteSealSample(params: {
  prisma: PrismaClient;
  sealId: string;
  actorId: string;
  ip?: string | null;
}): Promise<Result<{ seal: { id: string } }>> {
  const { prisma, sealId, actorId, ip } = params;
  const now = BigInt(Date.now());
  try {
    await (prisma as any).$transaction(async (tx: any) => {
      const existing = await guardedSource(tx,'sealSample',sealId);
      if (!existing) throw Object.assign(new Error('封样不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      if (existing.status === 'converted') {
        throw Object.assign(new Error('已转档的封样不可删除'), { code: 'ALREADY_CONVERTED', statusCode: 409 });
      }
      await tx.sealSample.update({ where: { id: sealId }, data: { deletedAt: now, updatedAt: now } });
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-seal',
        operation: 'delete_seal_sample',
        targetType: 'SealSample',
        targetId: sealId,
        before: { sealCode: existing.sealCode, status: existing.status },
        after: { sealCode: existing.sealCode, deletedAt: Number(now) },
        ip: ip || null,
      });
    });
    return { ok: true, data: { seal: { id: sealId } } };
  } catch (e: any) {
    return failFabricOperation(e, 'SEAL_DELETE_FAILED', '封样删除结果暂不可确认，请核对原开发案后重试。',
      ['NOT_FOUND', 'ALREADY_CONVERTED']);
  }
}

/** draft → sealed（至少 1 个组合批次）；sealed → converted 由 convertToFabricAsset 完成 */
export async function sealSampleConfirm(params: {
  prisma: PrismaClient;
  sealId: string;
  actorId: string;
  trustedActor?: TokenPayload;
  ip?: string | null;
}): Promise<Result<{ seal: any }>> {
  const { prisma, sealId, actorId, ip, trustedActor } = params;
  const now = BigInt(Date.now());
  try {
    const seal = await (prisma as any).$transaction(async (tx: any) => {
      const existing = await guardedSource(tx,'sealSample',sealId);
      if (!existing) throw Object.assign(new Error('封样不存在'), { code: 'NOT_FOUND', statusCode: 404 });
      await authorizeDevelopmentSource(tx, actorId, trustedActor, existing.developmentCaseId);
      if (existing.status !== 'draft') {
        throw Object.assign(new Error(`当前状态 ${existing.status} 不允许执行封样动作`), { code: 'INVALID_TRANSITION', statusCode: 409 });
      }
      const links = await tx.sealSampleBatch.findMany({ where: { sealSampleId: sealId } });
      if (links.length === 0) throw Object.assign(new Error('封样至少选择 1 个样品批次后才能封存'), { code: 'INVALID_INPUT' , statusCode: 400 });
      const approved = await tx.sampleBatch.findMany({ where: { id: { in: links.map((link: any) => link.sampleBatchId) }, developmentCaseId: existing.developmentCaseId, deletedAt: null }, select: { id: true, sampleVersionId: true } });
      if (approved.length !== links.length || approved.some((batch: any) => !batch.sampleVersionId)) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '封样须引用记录准确工厂版本的返样，历史未知来源不能补算通过');
      await assertFabricSealEligible(tx, existing);
      const sealBatches = [];
      const sealVersionProofs = new Map<string, any>();
      for (const link of [...links].sort((a: any, b: any) => a.sampleBatchId.localeCompare(b.sampleBatchId))) {
        const batch = await lockFabricBatch(tx, link.sampleBatchId);
        const accurate = await assertFabricBatchEvidence(tx, batch);
        if (accurate) sealVersionProofs.set(batch.id, accurate.exactDevelopmentVersionProof);
        sealBatches.push(batch);
      }
      const sealDevelopment = await tx.developmentCase.findFirst({ where: { id: existing.developmentCaseId, deletedAt: null } });
      const updated = await tx.sealSample.update({ where: { id: sealId }, data: { status: 'sealed', updatedAt: now } });
      const auditId = await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-seal',
        operation: 'seal_sample_confirm',
        targetType: 'SealSample',
        targetId: sealId,
        before: { sealCode: existing.sealCode, status: 'draft' },
        after: { sealCode: existing.sealCode, status: 'sealed', batchFacts: sealBatches.map(batch => ({ batchId: batch.id, snapshot: fabricBatchSnapshot(batch),
          originSnapshot: snapshotSampleOrigin(batch, sealDevelopment), exactDevelopmentVersionProof: sealVersionProofs.get(batch.id) ?? null })) },
        ip: ip || null,
      });
      for (const batch of sealBatches) {
        await appendFabricEvent(tx, batch, batch, 'seal', actorId, auditId, { sealId });
      }
      // Return the actual, validated relation set from this transaction. A seal
      // status DTO replaces a full frontend record and must retain its combination.
      return { ...updated, batchIds: links.map((link: any) => link.sampleBatchId) };
    });
    return { ok: true, data: { seal: serializeSeal(seal) } };
  } catch (e: any) {
    return failFabricOperation(e, 'SEAL_CONFIRM_FAILED', '封样结果暂不可确认，请核对原封样记录后重试。', ['NOT_FOUND', 'INVALID_TRANSITION', 'INVALID_INPUT']);
  }
}

// ────────────────────────────────────────────────────────────────────
// 强制转面料档案（批次直接转 / 封样转）
// ────────────────────────────────────────────────────────────────────

/**
 * 转档：创建 ProductAsset(Fabric) + FabricProfile，字段从开发案规格要求透传；
 * 回填 batch/seal 的 converted* 字段；开发案 productAssetId 为空时回填首个档案。
 * 强制建档后转：convertService 在面料案转大货前校验 productAssetId（ASSET_REQUIRED）。
 */
export async function convertToFabricAsset(params: {
  prisma: PrismaClient;
  caseId: string;
  sourceType: 'batch' | 'seal';
  sourceId: string;
  sourceVersionId?: string;
  actorId: string;
  trustedActor?: TokenPayload;
  input?: FabricCommand;
  ip?: string | null;
}): Promise<Result<{ asset: any; case: any; batch?: any; seal?: any; conversionReceipt?: any }>> {
  const { prisma, caseId, sourceType, sourceId, sourceVersionId, actorId, ip, trustedActor, input = {} } = params;
  const devCase = await findLiveCase(prisma, caseId);
  if (!devCase) return fail('DEV_CASE_NOT_FOUND', `开发单 ${caseId} 不存在`, 404);
  if (devCase.type !== 'fabric') return fail('NOT_FABRIC_CASE', `转档仅适用于面料开发案（当前类型 ${devCase.type}）`);

  // 事务外读源（先校验 gate）
  let sourceBatch: any = null;
  let sourceSeal: any = null;
  if (sourceType === 'batch') {
    sourceBatch = await prisma.sampleBatch.findFirst({ where: { id: sourceId, developmentCaseId: caseId, deletedAt: null } });
    if (!sourceBatch) return fail('BATCH_NOT_FOUND', '样品批次不存在或不属于本开发案', 404);
    // Product archive eligibility is formal QC pass on this exact physical version.
    // Customer/design confirmation remains a separate business decision and is
    // deliberately not promoted into the archive gate.
  } else {
    sourceSeal = await prisma.sealSample.findFirst({ where: { id: sourceId, developmentCaseId: caseId, deletedAt: null } });
    if (!sourceSeal) return fail('SEAL_NOT_FOUND', '封样不存在或不属于本开发案', 404);
    if (!['sealed', 'converted'].includes(sourceSeal.status)) {
      return fail('SEAL_NOT_SEALED', `封样 ${sourceSeal.sealCode} 未封存（当前 ${sourceSeal.status}），封存后方可转档`, 409);
    }
  }

  const now = BigInt(Date.now());
  // DR-054 阶段 D：转档自动带入产品来源——DR-050 面料立项 source（internal→development、
  // customer-sample/customer-colorcard→customer_sample）映射；无立案来源默认 development；
  // sourceDetail 溯源到开发案编号。
  // ★ G-5：映射表已挪进 devSource.ts 唯一真源（成衣侧此前硬编码 'development' ⇒ 两份迟早改一处漏一处）
  try {
    const result = await (prisma as any).$transaction(async (tx: any) => {
      await assertDevelopmentOperationalWrite(tx,caseId,'convert');
      await authorizeDevelopmentSource(tx, actorId, trustedActor, caseId);
      const liveCase = await findLiveCase(tx, caseId);
      if (!liveCase) throw Object.assign(new Error('开发案不存在'),{code:'NOT_FOUND',statusCode:404});
      if (liveCase.type !== 'fabric') throw Object.assign(new Error('开发案类型已变化，请刷新'),{code:'DEVELOPMENT_SOURCE_CHANGED',statusCode:409});
      const liveSource=sourceType === 'batch' ? await lockFabricBatch(tx, sourceId) : await tx.sealSample.findFirst({where:{id:sourceId,developmentCaseId:caseId,deletedAt:null}});
      if(!liveSource || liveSource.developmentCaseId !== caseId || (sourceType === 'seal' && !['sealed', 'converted'].includes(liveSource.status))) throw Object.assign(new Error('转档来源已变化，请刷新'),{code:'DEVELOPMENT_SOURCE_CHANGED',statusCode:409});
      let physicalBatch = liveSource;
      if (sourceType === 'seal') {
        const links = await tx.sealSampleBatch.findMany({ where: { sealSampleId: liveSource.id }, orderBy: { sampleBatchId: 'asc' } });
        const batches = await tx.sampleBatch.findMany({ where: { id: { in: links.map((link: any) => link.sampleBatchId) }, developmentCaseId: caseId, deletedAt: null }, orderBy: { id: 'asc' } });
        const versionIds = new Set(batches.map((batch: any) => batch.sampleVersionId));
        if (!batches.length || batches.length !== links.length || versionIds.size !== 1 || !batches[0].sampleVersionId)
          throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '封样组合没有唯一且已记录的准确开发版本，不能推算转档来源');
        physicalBatch = batches[0];
      }
      const { version: selectedVersion } = await resolveDevelopmentVersionForBatch(tx, { caseId, batch: physicalBatch, sampleVersionId: sourceVersionId, lock: true });
      const archiveCommand = { caseId, sampleVersionId: selectedVersion.id, sampleBatchId: physicalBatch.id, sourceType, sourceId, actorId, requestKey: input.requestKey };
      const receipt = await readDevelopmentArchiveReceipt(tx, archiveCommand);
      if (receipt) return { ...receipt, case: liveCase, batch: sourceType === 'batch' ? liveSource : undefined };
      const review = await assertDevelopmentVersionQualityPass(tx, caseId, selectedVersion.id);
      await assertReviewSourceCurrent(tx, review);
      const commandInput = { ...input, sourceType, sourceId, sourceVersionId: selectedVersion.id };
      const replay = sourceType === 'batch' ? checkFabricCommand(liveSource, actorId, 'convert', commandInput) : null;
      if (replay) {
        const asset = await tx.productAsset.findFirst({ where: { id: replay.after.convertedProductAssetId, deletedAt: null } });
        if (!asset) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '原转档记录的档案已不可用，请核对历史记录');
        const conversionReceipt = await recordDevelopmentArchiveReceipt(tx, archiveCommand, asset.id);
        return { asset, case: liveCase, batch: { ...liveSource, commandAck: replay }, conversionReceipt };
      }
      // The parent lock may have waited for a specification edit or another
      // batch conversion. Only the locked records define this new asset.
      const name = (liveCase.productName || liveCase.name || '面料').trim();
      // The current return/QC contract has no structured, unit-verified fabric
      // measurements. Preserve its evidence; never promote case targets as actuals.
      const targetRequirements = review.sourceSnapshot?.case?.requirements ?? null;
      const returnedPhotos = review.sourceSnapshot?.results?.photos;
      const actualImage = Array.isArray(returnedPhotos) ? returnedPhotos.find((photo: unknown) => typeof photo === 'string' && photo.trim()) ?? null : null;
      const assetSource = assetSourceFromDevCase(liveCase.source);
      const assetSourceDetail = `${liveCase.code}（${liveCase.name || ''}）`;
      const physicalReferences = await linkDevelopmentPhysicalSamplesToAsset(tx, physicalBatch, liveCase, selectedVersion.id, now, { referenceOnly: true });
      let created = await findDevelopmentFabricVersionAsset(tx, physicalBatch, liveCase, selectedVersion.id);
      if (!created) {
        created = await createDevelopmentAssetWithSku(tx, 'FB', {
          id: `PROD-${Date.now()}`,
          name,
          mainCategory: 'Fabric',
          subCategoryId: 'uncategorized',
          season: '',
          // A development target is not confirmed unit cost. Keep the unknown explicit.
          cost: null,
          status: 'Development',
          source: assetSource,
          sourceDetail: assetSourceDetail,
          sourceDevelopmentCaseId: caseId,
          sourceSampleBatchId: physicalBatch.id,
          sourceSampleVersionId: selectedVersion.id,
          sourceVersionLabel: selectedVersion.versionLabel,
          sourceSpecSnapshot: {
            sourceType,
            sampleVersionId: selectedVersion.id,
            versionLabel: selectedVersion.versionLabel,
            versionKind: selectedVersion.versionKind,
            minorChangeNote: selectedVersion.minorChangeNote ?? null,
            sampleBatchId: physicalBatch.id,
            physicalCardIds: physicalReferences.physicalCardIds,
            qualityReviewId: review.id,
            qualityResult: review.result,
            qualityOpinion: review.opinion ?? null,
            qualityEvidence: review.evidence ?? null,
            qualityMeasurements: review.measurements ?? null,
            actualResults: review.sourceSnapshot?.results ?? null,
            targetRequirements,
            sampleType: sourceType === 'batch' ? liveSource.sampleType : null,
            formIndex: sourceType === 'batch' ? liveSource.formIndex ?? 0 : null,
            specNote: sourceType === 'batch' ? liveSource.specNote ?? null : null,
            sealId: sourceType === 'seal' ? liveSource.id : null,
            sealCode: sourceType === 'seal' ? liveSource.sealCode : null,
          },
          techPackUrl: null,
          imageUrl: actualImage,
          updatedAt: now,
          deletedAt: null,
        });
        await tx.fabricProfile.create({
        data: {
          id: `FAB-${Date.now()}`,
          productAssetId: created.id,
          construction: null,
          weightValue: null,
          weightUnit: null,
          widthValue: null,
          widthUnit: null,
          widthText: null,
          // 2b 字段契约：档案联动"确认版批次号/封样号"，溯源该档案来自哪个确认批次（呼应 dev/sample 分界）
          referenceBatch: sourceType === 'batch' ? liveSource.batchCode : liveSource.sealCode,
          millOrganizationId: liveSource.supplierRelationId || null,
          millName: liveSource.supplierName || null,
          moqValue: null,
          specialNote: null,
          updatedAt: now,
          deletedAt: null,
        },
        });
      }
      if (selectedVersion.versionKind !== 'minor') await linkDevelopmentPhysicalSamplesToAsset(tx, physicalBatch, liveCase, created.id, now);
      const physicalCardId = physicalReferences.physicalCardId;
      const conversionAuditId = await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-convert-asset',
        operation: 'convert_fabric_to_asset',
        targetType: 'ProductAsset',
        targetId: created.id,
        after: { sku: created.sku, name, mainCategory: 'Fabric', fromCase: caseId, sourceType, sourceId, physicalCardId,
          sourceSampleVersionId: selectedVersion.id, sourceVersionLabel: selectedVersion.versionLabel,
          physicalCardIds: physicalReferences.physicalCardIds, qualityReviewId: review.id,
          ...(sourceType === 'batch' ? { roundFact: { kind: 'convert', before: fabricBatchSnapshot(liveSource),
            after: fabricBatchSnapshot({ ...liveSource, convertedProductAssetId: created.id, convertedAt: now, updatedAt: now }) } } : {}) },
        ip: ip || null,
      });

      // 回填源
      let resultBatch: any;
      if (sourceType === 'batch' && selectedVersion.versionKind !== 'minor') {
        const convertedBatch = await tx.sampleBatch.update({
          where: { id: liveSource.id },
          data: { convertedProductAssetId: created.id, convertedAt: now, updatedAt: now },
        });
        resultBatch = await appendFabricEvent(tx, liveSource, convertedBatch, 'convert', actorId, conversionAuditId, commandInput);
      } else if (sourceType === 'seal') {
        await tx.sealSample.update({
          where: { id: liveSource.id },
          data: { status: 'converted', convertedProductAssetId: created.id, convertedAt: now, updatedAt: now },
        });
      } else resultBatch = { ...liveSource, convertedVersionAsset: { sampleVersionId: selectedVersion.id, productAssetId: created.id } };

      // 开发案 productAssetId 为空时回填首个档案（对齐转大货/完备度引擎的档案锚点）
      const caseData: any = { updatedAt: now };
      if (!liveCase.productAssetId || liveCase.productAssetId === liveSource.convertedProductAssetId) {
        caseData.productAssetId = created.id;
        caseData.productName = name;
      }
      const updatedCase = await tx.developmentCase.update({ where: { id: caseId }, data: caseData });
      await syncDevelopmentCaseReferences(prisma, { ...updatedCase, productAssetId: updatedCase.productAssetId }, { source: 'dev:fabric-convert-asset' }, tx);
      await writeRouteAuditLog({
        prisma: tx,
        actorId,
        source: 'route:dev:fabric-convert-asset',
        operation: 'convert_fabric_asset_link_case',
        targetType: 'DevelopmentCase',
        targetId: caseId,
        before: { productAssetId: liveCase.productAssetId ?? null },
        after: { productAssetId: updatedCase.productAssetId ?? null },
        ip: ip || null,
      });

      const conversionReceipt = await recordDevelopmentArchiveReceipt(tx, archiveCommand, created.id);
      return { asset: created, case: updatedCase, batch: resultBatch, conversionReceipt };
    });

    const { asset, case: updatedCase, batch, conversionReceipt } = result as any;
    return {
      ok: true,
      data: {
        ...(batch ? { batch: serializeBatch(batch) } : {}),
        ...(conversionReceipt ? { conversionReceipt } : {}),
        asset: {
          ...asset,
          updatedAt: Number(asset.updatedAt),
          deletedAt: asset.deletedAt ? Number(asset.deletedAt) : null,
        },
        case: {
          ...updatedCase,
          createdAt: Number(updatedCase.createdAt),
          updatedAt: Number(updatedCase.updatedAt),
          deletedAt: updatedCase.deletedAt ? Number(updatedCase.deletedAt) : null,
          convertedAt: updatedCase.convertedAt ? Number(updatedCase.convertedAt) : null,
        },
      },
    };
  } catch (e: any) {
    return failFabricOperation(e, 'CONVERT_ASSET_FAILED', '转档结果暂不可确认，请核对原样品和档案后重试。', ['NOT_FOUND', 'CONFLICT', 'QC_PASS_REQUIRED']);
  }
}
