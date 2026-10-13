import { normalizeDevelopmentQcMeasurements } from './developmentQcMeasurements';
import { resolveDevelopmentQcRouting, assertDevelopmentQcMember, developmentQcMember } from './developmentQcRouting';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { parseActualSampleBatchQuantity, sanitizeDefectCauses, serializeBatch } from './fabricDevelopmentService';
import { assertDevelopmentOperationalWrite, DevelopmentDomainError } from './developmentOperationalGuard';
import { sampleOriginFingerprint, snapshotSampleOrigin } from '../samples/sampleOriginService';
import { buildDevelopmentQualitySourceSnapshot as buildSourceSnapshot, assertDevelopmentQualitySourceCurrent as assertReviewSourceCurrent, latestDevelopmentVersionQualityReview, resolveDevelopmentVersionForBatch } from './developmentVersionGate';
import type { TokenPayload } from '../auth/service';
import { authorizeDevelopmentSource, currentConversionActor } from './developmentConversionAuthority';
import { hasScope } from '../auth/permissionService';
import { hasActualQcScope } from '../qc/qcExecutionScope';
import { normalizeQcEvidenceIds, readQcEvidenceInTx } from '../qc/qcEvidenceStorage';
import { QcAssignmentError } from '../qc/qcAssignmentAccess';
import { businessNowMs } from '../shared/businessClock';

type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number } };
const fail = (code: string, message: string, status = 400): ServiceResult<never> => ({ ok: false, error: { code, message, status } });
const timestamp = () => BigInt(Date.now());
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function inputString(value: unknown, field: string, max: number, optional = false): string | null {
  if (value == null && optional) return null;
  if (typeof value !== 'string') throw new DevelopmentDomainError('INVALID_INPUT', `${field}格式不正确`);
  const normalized = value.trim();
  if (!normalized && optional) return null;
  if (!normalized || normalized.length > max) throw new DevelopmentDomainError('INVALID_INPUT', `${field}不能为空且不能超过 ${max} 个字符`);
  return normalized;
}

function normalizeRating(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new DevelopmentDomainError('INVALID_INPUT', `${field}必须是 1-5 的整数`);
  return n;
}

function normalizeDefectCount(value: unknown, field: string): number {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2147483647) throw new DevelopmentDomainError('INVALID_INPUT', `${field}必须是非负整数`);
  return n;
}

function returnPlacement(input: any) {
  const warehouseId = inputString(input?.warehouseId, '实物存放仓库', 200, true);
  const location = inputString(input?.location, '实物存放位置', 200, true);
  let locationDetail: Record<string, string | null> | null = null;
  if (input?.locationDetail != null) {
    const fields = ['zone', 'shelf', 'level', 'bin'];
    const value = input.locationDetail;
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
      throw new DevelopmentDomainError('INVALID_INPUT', '详细库位只能包含 zone、shelf、level、bin');
    }
    locationDetail = Object.fromEntries(fields.map(field => [field, inputString(value[field], '详细库位', 80, true)]));
  }
  return { warehouseId, location, locationDetail };
}

export function serializeDevelopmentQualityReview(row: any, developmentType?: string | null) {
  const asNumber = (value: unknown) => value == null ? null : Number(value);
  const source = row.sourceSnapshot && typeof row.sourceSnapshot === 'object' ? row.sourceSnapshot as any : {};
  return {
    ...row,
    measurements: row.measurements ?? null,
    executorId: row.startedBy ?? null,
    routingTeamId: row.routingTeamId ?? null,
    responsibleHeadId: row.responsibleHeadId ?? null,
    sampleVersionId: row.sampleVersionId ?? null,
    versionIdentityStatus: row.sampleVersionId ? 'recorded_exact' : 'unknown',
    // The queue gets its authoritative, current DevelopmentCase type as a
    // separate read-only projection. Keep it out of the frozen source snapshot
    // so existing source fingerprints and QC write checks remain unchanged.
    ...(developmentType === undefined ? {} : { developmentType }),
    requestedAt: asNumber(row.requestedAt), startedAt: asNumber(row.startedAt), reviewedAt: asNumber(row.reviewedAt),
    acknowledgedAt: asNumber(row.acknowledgedAt), createdAt: asNumber(row.createdAt), updatedAt: asNumber(row.updatedAt),
    reviewId: row.id,
    reportId: row.id,
    caseCode: source.case?.code ?? '', caseName: source.case?.name ?? '', customerName: source.case?.customerName ?? '',
    caseRequirements: source.case?.requirements ?? {},
    round: source.round ?? null, versionLabel: source.versionLabel ?? '', supplierName: source.supplierName ?? '',
    supplierRelationId: source.supplierRelationId ?? '', sampleType: source.sampleType ?? '', batchCode: source.batchCode ?? '',
    specNote: source.specNote ?? '', returnedAt: source.returnedAt ?? null,
    results: source.results ?? {}, physicalItems: source.physicalItems ?? [],
  };
}
const serializeReview = serializeDevelopmentQualityReview;

export async function authorizeDevelopmentQualityExecution(tx: any, caseId: string, actorId: string, trustedActor?: TokenPayload) {
  const access = await authorizeDevelopmentSource(tx, actorId, trustedActor, caseId, { scope: 'qc:inspect', write: false });
  if (!['fabric', 'garment'].includes(access.development.type)) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '开发类别未明确，暂不能执行正式 QC');
  if (!hasActualQcScope(access.actor, 'qc:inspect')
    || !hasActualQcScope(access.actor, access.development.type === 'fabric' ? 'qc:fabric_chain:write' : 'qc:garment_chain:write'))
    throw new DevelopmentDomainError('FORBIDDEN', '当前账号没有该开发类别的专业 QC 评审权限');
  return access;
}

async function lockBatch(tx: any, caseId: string, batchId: string, actorId: string, trustedActor?: TokenPayload, qc = false, historyReplay = false) {
  if (historyReplay) {
    const rows = await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentCase" WHERE "id" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
    if (!rows.length) throw new DevelopmentDomainError('NOT_FOUND', '开发案不存在或已删除');
  } else await assertDevelopmentOperationalWrite(tx, caseId, 'sample');
  if (qc) await authorizeDevelopmentQualityExecution(tx, caseId, actorId, trustedActor);
  else await authorizeDevelopmentSource(tx, actorId, trustedActor, caseId, { scope: 'products:write', write: true });
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "SampleBatch" WHERE "id" = ${batchId} AND "developmentCaseId" = ${caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  const batch = await tx.sampleBatch.findFirst({ where: { id: batchId, developmentCaseId: caseId, deletedAt: null } });
  if (!batch) throw new DevelopmentDomainError('NOT_FOUND', '开发样品不存在或不属于当前开发案');
  return batch;
}

/** Source locks precede the review lock. Every execution re-loads the current
 * account, chain grant, credential ceiling and source visibility after locks. */
export async function lockDevelopmentQualityReview(tx: any, params: { reviewId: string; actorId: string; trustedActor?: TokenPayload; historyReplay?: boolean }) {
  const hint = await tx.developmentSampleQualityReview.findUnique({ where: { id: params.reviewId } });
  if (!hint) throw new DevelopmentDomainError('NOT_FOUND', '开发样品 QC 任务不存在');
  await lockBatch(tx, hint.developmentCaseId, hint.sampleBatchId, params.actorId, params.trustedActor, true, params.historyReplay);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleQualityReview" WHERE "id" = ${params.reviewId} FOR UPDATE`);
  const review = await tx.developmentSampleQualityReview.findUnique({ where: { id: params.reviewId } });
  if (!review || review.developmentCaseId !== hint.developmentCaseId || review.sampleBatchId !== hint.sampleBatchId)
    throw new DevelopmentDomainError('NOT_FOUND', '开发样品 QC 任务不存在或来源已变化');
  const access = await authorizeDevelopmentQualityExecution(tx, review.developmentCaseId, params.actorId, params.trustedActor);
  await assertDevelopmentQcMember(tx, review, params.actorId, access.development.type);
  return { ...access, review };
}

export { assertDevelopmentQualitySourceCurrent as assertReviewSourceCurrent } from './developmentVersionGate';

export async function recordDevelopmentSampleReturnResults(params: {
  prisma: PrismaClient; caseId: string; batchId: string; actorId: string; trustedActor?: TokenPayload; ip?: string | null; input: any;
}): Promise<ServiceResult<{ batch: any }>> {
  const { prisma, caseId, batchId, actorId, ip, input } = params;
  try {
    const requestKey = inputString(input?.requestKey, '原请求编号', 128)!;
    const expectedBatchUpdatedAt = inputString(input?.expectedBatchUpdatedAt, '批次版本', 32)!;
    if (!/^\d+$/.test(expectedBatchUpdatedAt)) throw new DevelopmentDomainError('INVALID_INPUT', '批次版本格式不正确');
    const results = {
      dyeLotNo: inputString(input?.dyeLotNo, '缸号', 120, true),
      colorRating: normalizeRating(input?.colorRating, '色差评级'),
      sideDiff: normalizeRating(input?.sideDiff, '边差评级'),
      endDiff: normalizeRating(input?.endDiff, '头尾差评级'),
      defectCauses: sanitizeDefectCauses(input?.defectCauses ?? []),
      photos: input?.photos == null ? null : input.photos,
      notes: inputString(input?.notes, '返样备注', 4000, true),
      actualQuantity: input?.actualQuantity === undefined ? null : parseActualSampleBatchQuantity(input.actualQuantity)?.toString() ?? null,
      actualUnit: inputString(input?.actualUnit, '实际数量单位', 30, true),
    };
    if (results.photos != null && (!Array.isArray(results.photos) || results.photos.length > 30
      || results.photos.some((photo: unknown) => typeof photo !== 'string' || photo.trim().length > 2048)))
      throw new DevelopmentDomainError('INVALID_INPUT', '样品照片需使用不超过 30 项的有效链接列表');
    const placement = returnPlacement(input);
    const placementSupplied = ['warehouseId', 'location', 'locationDetail'].some(key => input?.[key] !== undefined);
    // Omitted placement keeps the original fingerprint contract for exact
    // replay of receipts recorded before optional placement was supported.
    const payloadFingerprint = digest(placementSupplied ? { ...results, placement } : results);
    const item = await (prisma as any).$transaction(async (tx: any) => {
      const batch = await lockBatch(tx, caseId, batchId, actorId, params.trustedActor);
      if (batch.returnedAt != null) {
        if (batch.returnRequestKey === requestKey && batch.returnFingerprint === payloadFingerprint && batch.returnedBy === actorId) return serializeBatch(batch);
        throw new DevelopmentDomainError('RETURN_RESULTS_ALREADY_RECORDED', '这件试样的返样成果已登记。若需复样，请建立新的开发轮次/版本，保留原样记录。');
      }
      if (batch.status !== 'making') throw new DevelopmentDomainError('INVALID_TRANSITION', '请先将安排推进到“开工打样”，收到工厂返样后再登记成果');
      if (batch.sampleType === 'yardage' && (results.actualQuantity == null || !results.actualUnit))
        throw new DevelopmentDomainError('INVALID_INPUT', '米样返样必须登记实际米数及单位');
      if (batch.sampleType !== 'yardage' && (results.actualQuantity == null || !results.actualUnit))
        throw new DevelopmentDomainError('INVALID_INPUT', '返样必须登记实际数量和单位，服装单位按实际填写');
      if (batch.sampleType !== 'yardage' && (!Number.isSafeInteger(Number(results.actualQuantity)) || Number(results.actualQuantity) < 1 || Number(results.actualQuantity) > 2147483647))
        throw new DevelopmentDomainError('INVALID_INPUT', '非米样实物数量必须是正整数');
      if (batch.sampleType === 'yardage' && results.actualUnit !== '米')
        throw new DevelopmentDomainError('INVALID_INPUT', '米样实物库存统一以米登记');
      if (['lab-dip', 'handloom'].includes(batch.sampleType) && results.actualUnit !== '份')
        throw new DevelopmentDomainError('INVALID_INPUT', '色样和手织样实物单位统一为份');
      if (String(batch.updatedAt) !== expectedBatchUpdatedAt) throw new DevelopmentDomainError('REQUEST_CONFLICT', '打样安排已变化，请刷新后再登记返样成果');
      const existingReview = await tx.developmentSampleQualityReview.findFirst({ where: { sampleBatchId: batchId } });
      if (existingReview) throw new DevelopmentDomainError('REQUEST_CONFLICT', '该试样已进入 QC，不能覆盖返样成果');
      if (placement.warehouseId) {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Warehouse" WHERE "id" = ${placement.warehouseId} FOR UPDATE`);
        const warehouse = await tx.warehouse.findUnique({ where: { id: placement.warehouseId } });
        if (!warehouse || warehouse.deletedAt != null || warehouse.isActive !== true) {
          throw new DevelopmentDomainError('INVALID_INPUT', '实物存放仓库不存在或已停用，请核对实际位置');
        }
      }
      const occurredAt = BigInt(businessNowMs()), now = timestamp();
      const actualQuantity = results.actualQuantity == null ? null : new Prisma.Decimal(results.actualQuantity);
      const devCase = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
      if (!devCase) throw new DevelopmentDomainError('NOT_FOUND', '开发案不存在或已归档');
      const updated = await tx.sampleBatch.update({ where: { id: batchId }, data: {
        dyeLotNo: results.dyeLotNo, colorRating: results.colorRating, sideDiff: results.sideDiff, endDiff: results.endDiff,
        defectCauses: results.defectCauses, photos: results.photos as any, notes: results.notes,
        actualQuantity, actualUnit: results.actualUnit, returnedAt: occurredAt, returnedBy: actorId,
        returnRequestKey: requestKey, returnFingerprint: payloadFingerprint, updatedAt: now,
      } });
      const frozenSource = snapshotSampleOrigin(updated, devCase);
      const sourceFingerprint = sampleOriginFingerprint(frozenSource);
      // Development is the first and only creator of the physical sample stock
      // record. The Sample Management module reads the same SampleCardItem row.
      // Yardage uses decimal length columns; counted forms use integer units.
      const cardType = batch.sampleType === 'lab-dip' ? 'colorcard'
        : ['handloom', 'yardage'].includes(batch.sampleType) ? 'fabric'
          : batch.sampleType === 'trim' ? 'trim' : 'garment';
      const physicalUnit = results.actualUnit!;
      const isGarment = batch.sampleType === 'garment-round';
      const physicalQuantity = batch.sampleType === 'yardage' ? 1 : Number(results.actualQuantity);
      const receiptSnapshot = { version: 2, nativeFamily: batch.sampleType === 'garment-round' ? 'garment-round' : 'fabric-batch',
        batchId, batchCode: batch.batchCode, developmentCaseId: caseId, factoryId: batch.supplierRelationId, sourceRound: batch.round,
        sampleType: batch.sampleType, sourceSnapshot: frozenSource, sourceFingerprint, cardType,
        actualQuantity: String(results.actualQuantity), actualUnit: physicalUnit, colorRating: results.colorRating,
        resultSnapshot: { dyeLotNo: results.dyeLotNo, sideDiff: results.sideDiff, endDiff: results.endDiff, defectCauses: results.defectCauses, notes: results.notes },
        batchUpdatedAt: String(updated.updatedAt), initialPhysicalCardCount: isGarment ? 1 : physicalQuantity, physicalUnit,
        receivedAt: occurredAt.toString(), recordedAt: now.toString(), receivedBy: actorId, ...placement };
      const physicalItems = [] as any[];
      const itemCount = isGarment ? physicalQuantity : 1;
      for (let index = 0; index < itemCount; index++) {
        const itemQuantity = isGarment ? 1 : physicalQuantity;
        const itemReceiptSnapshot = isGarment
          ? { ...receiptSnapshot, physicalItemIndex: index + 1, physicalItemCount: itemCount }
          : receiptSnapshot;
        const card = await tx.sampleCardItem.create({ data: {
          id: `SCI_DEV_${randomUUID()}`, code: `SC-DEV-${randomUUID()}`, name: [devCase.code, batch.versionLabel, batch.batchCode, batch.sampleType, ...(isGarment ? [`第 ${index + 1} 件`] : [])].filter(Boolean).join(' · '),
          cardType, status: 'in_stock', quantity: itemQuantity, availableQty: itemQuantity, unit: physicalUnit,
          ...(batch.sampleType === 'yardage' ? { physicalLengthQty: actualQuantity, availableLengthQty: actualQuantity } : {}),
          photos: Array.isArray(results.photos) ? results.photos : [], devCaseId: caseId, batchId, sampleId: null,
          warehouseId: placement.warehouseId, location: placement.location,
          ...(placement.locationDetail ? { locationDetail: placement.locationDetail } : {}),
          receiptSnapshot: itemReceiptSnapshot as any,
          createdAt: now, updatedAt: now,
        } });
        physicalItems.push(card);
        await writeRouteAuditLog({ prisma: tx, actorId, source: 'development:sample-return', operation: 'sample_card_create',
          targetType: 'SampleCardItem', targetId: card.id, after: { code: card.code, name: card.name, cardType, quantity: itemQuantity,
            availableQty: itemQuantity, unit: physicalUnit, devCaseId: caseId, batchId, receiptSnapshot: card.receiptSnapshot,
            physicalLengthQty: batch.sampleType === 'yardage' ? String(actualQuantity) : null, ...placement }, operationType: 'create' });
      }
      await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:dev:sample-return-results', operation: 'record_development_sample_return',
        targetType: 'SampleBatch', targetId: batchId,
        before: { returnedAt: null, updatedAt: batch.updatedAt.toString() },
        after: { returnedAt: occurredAt.toString(), returnedBy: actorId, requestKey, fingerprint: payloadFingerprint, results, placement }, ip: ip ?? null });
      return serializeBatch(updated);
    });
    return { ok: true, data: { batch: item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return fail(error.code, error.message, error.statusCode);
    return fail('RETURN_RESULTS_FAILED', '返样成果未能保存，请刷新批次后重试。', 500);
  }
}

export async function requestDevelopmentSampleQualityReview(params: {
  prisma: PrismaClient; caseId: string; batchId: string; sampleVersionId?: string | null; actorId: string; trustedActor?: TokenPayload; ip?: string | null; requestKey: string; routingTeamId?: string;
}): Promise<ServiceResult<{ item: any }>> {
  const { prisma, caseId, batchId, actorId, ip } = params;
  try {
    const requestKey = inputString(params.requestKey, '原请求编号', 128)!;
    const item = await (prisma as any).$transaction(async (tx: any) => {
      const batch = await lockBatch(tx, caseId, batchId, actorId, params.trustedActor);
      if (batch.returnedAt == null) throw new DevelopmentDomainError('RETURN_RESULTS_REQUIRED', '请先登记工厂返样成果，再发起 QC 评审');
      const existing = await tx.developmentSampleQualityReview.findUnique({ where: { requestKey } });
      if (existing) {
        const sameVersion = params.sampleVersionId == null
          ? existing.sampleVersionId == null || existing.sampleVersionId === batch.sampleVersionId
          : existing.sampleVersionId === params.sampleVersionId;
        if (existing.developmentCaseId === caseId && existing.sampleBatchId === batchId && sameVersion && existing.requestedBy === actorId && (params.routingTeamId == null || existing.routingTeamId === params.routingTeamId)) return serializeReview(existing);
        throw new DevelopmentDomainError('REQUEST_CONFLICT', '原请求编号已经用于其他版本或内容，请核对原请求后重试');
      }
      const versionContext = await resolveDevelopmentVersionForBatch(tx, { caseId, batch, sampleVersionId: params.sampleVersionId, lock: true });
      const latest = await latestDevelopmentVersionQualityReview(tx, caseId, versionContext.version.id);
      if (latest && ['queued', 'in_progress'].includes(latest.status)) throw new DevelopmentDomainError('QC_REVIEW_ALREADY_REQUESTED', '该准确版本已有未完成的 QC 任务，请先处理原任务');
      const reviewSequence = (latest?.reviewSequence ?? 0) + 1;
      const devCase = await tx.developmentCase.findFirst({ where: { id: caseId, deletedAt: null } });
      if (!devCase) throw new DevelopmentDomainError('NOT_FOUND', '开发案不存在或已归档');
      const physicalItems = await tx.sampleCardItem.findMany({ where: { batchId: batch.id, devCaseId: caseId, deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, code: true, cardType: true, receiptSnapshot: true } });
      if (!physicalItems.length) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '返样实物未同步到样品台账，暂不能发起 QC');
      const routing = await resolveDevelopmentQcRouting(tx, { caseId, type: devCase.type, requesterId: actorId, routingTeamId: params.routingTeamId });
      const sourceSnapshot = buildSourceSnapshot(batch, devCase, physicalItems, versionContext);
      const sourceFingerprint = digest(sourceSnapshot);
      const occurredAt = BigInt(businessNowMs()), now = timestamp();
      const created = await tx.developmentSampleQualityReview.create({ data: {
        id: `DSQR__${randomUUID()}`, sampleBatchId: batch.id, developmentCaseId: caseId, sampleVersionId: versionContext.version.id, reviewSequence,
        requestKey, sourceFingerprint, sourceSnapshot: sourceSnapshot as any, status: 'queued', ...routing,
        requestedBy: actorId, requestedAt: occurredAt, createdAt: now, updatedAt: now,
      } });
      await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:dev:sample-qc-request', operation: 'request_development_sample_qc',
        targetType: 'DevelopmentSampleQualityReview', targetId: created.id,
        after: { sampleBatchId: batch.id, caseId, sampleVersionId: versionContext.version.id, reviewSequence, round: batch.round,
          versionLabel: versionContext.version.versionLabel, sampleType: batch.sampleType, sourceFingerprint }, ip: ip ?? null });
      await tx.notification.create({ data: { id: `n_devqcr_${randomUUID()}`, userId: routing.responsibleHeadId, type: 'development_sample_qc_routed', title: '开发样品等待 QC 分配或认领', body: devCase.name || devCase.code || caseId, link: `/qc?developmentReviewId=${encodeURIComponent(created.id)}` } });
      return serializeReview(created);
    });
    return { ok: true, data: { item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return fail(error.code, error.message, error.statusCode);
    return fail('QC_REVIEW_REQUEST_FAILED', 'QC 评审任务未能创建，请刷新来源后重试。', 500);
  }
}

export async function acknowledgeDevelopmentSampleQualityReview(params: {
  prisma: PrismaClient; caseId: string; reviewId: string; actorId: string; trustedActor?: TokenPayload; ip?: string | null; requestKey: string;
}): Promise<ServiceResult<{ item: any }>> {
  const { prisma, caseId, reviewId, actorId, ip } = params;
  try {
    const requestKey = inputString(params.requestKey, '原请求编号', 128)!;
    const item = await (prisma as any).$transaction(async (tx: any) => {
      const initial = await tx.developmentSampleQualityReview.findFirst({ where: { id: reviewId, developmentCaseId: caseId } });
      if (!initial) throw new DevelopmentDomainError('NOT_FOUND', 'QC 评审记录不存在或不属于当前开发案');
      await lockBatch(tx, caseId, initial.sampleBatchId, actorId, params.trustedActor);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleQualityReview" WHERE "id" = ${reviewId} AND "developmentCaseId" = ${caseId} FOR UPDATE`);
      const review = await tx.developmentSampleQualityReview.findFirst({ where: { id: reviewId, developmentCaseId: caseId } });
      if (!review) throw new DevelopmentDomainError('NOT_FOUND', 'QC 评审记录不存在或不属于当前开发案');
      if (review.status === 'acknowledged') {
        if (review.acknowledgementRequestKey === requestKey && review.acknowledgedBy === actorId) return serializeReview(review);
        throw new DevelopmentDomainError('QC_REVIEW_ALREADY_ACKNOWLEDGED', '业务人员已阅该 QC 报告');
      }
      await assertReviewSourceCurrent(tx, review);
      if (review.status !== 'reviewed') throw new DevelopmentDomainError('QC_REVIEW_NOT_READY', 'QC 尚未完成评审，不能登记业务已阅');
      if (review.reviewedBy === actorId) throw new DevelopmentDomainError('QC_SELF_ACKNOWLEDGEMENT_BLOCKED', 'QC 评审人不能代业务员登记自己报告的业务已阅');
      const occurredAt = BigInt(businessNowMs()), now = timestamp();
      const updated = await tx.developmentSampleQualityReview.update({ where: { id: reviewId }, data: {
        status: 'acknowledged', acknowledgedBy: actorId, acknowledgedAt: occurredAt, acknowledgementRequestKey: requestKey, updatedAt: now,
      } });
      // The Development QC report is the authoritative QC fact. Do not project
      // acknowledgement into SampleBatch's unrelated legacy customer/warehouse gate.
      await writeRouteAuditLog({ prisma: tx, actorId, source: 'route:dev:sample-qc-acknowledge', operation: 'acknowledge_development_sample_qc',
        targetType: 'DevelopmentSampleQualityReview', targetId: reviewId,
        before: { status: review.status, result: review.result }, after: { status: updated.status, result: updated.result, acknowledgedAt: occurredAt.toString() }, ip: ip ?? null });
      return serializeReview(updated);
    });
    return { ok: true, data: { item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return fail(error.code, error.message, error.statusCode);
    return fail('QC_REVIEW_ACKNOWLEDGE_FAILED', '确认 QC 结论未能完成，请刷新后重试。', 500);
  }
}

export async function listDevelopmentSampleQualityReviews(params: {
  prisma: PrismaClient; trustedActor?: TokenPayload; actorId?: string; status?: string; limit?: number;
}): Promise<ServiceResult<{ items: any[] }>> {
  try {
    const allowed = ['queued', 'in_progress', 'reviewed', 'acknowledged'];
    const status = params.status;
    if (status && !allowed.includes(status)) throw new DevelopmentDomainError('INVALID_INPUT', '评审状态筛选不合法');
    await currentConversionActor(params.prisma, params.actorId ?? params.trustedActor?.userId, params.trustedActor, 'qc:read');
    const rows = await (params.prisma as any).developmentSampleQualityReview.findMany({
      where: status ? { status } : { status: { in: ['queued', 'in_progress', 'reviewed'] } },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }], take: Math.max(1, Math.min(200, Number(params.limit) || 100)),
    });
    const caseIds: string[] = [...new Set<string>(rows.map((row: any) => row.developmentCaseId).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))];
    const typeByCaseId = new Map<string, string>();
    for (const caseId of caseIds) {
      try {
        const { development } = await authorizeDevelopmentSource(params.prisma, params.actorId ?? params.trustedActor?.userId, params.trustedActor, caseId, { scope: 'qc:read', write: false });
        if (typeof development.type === 'string') typeByCaseId.set(caseId, development.type);
      } catch (error) {
        if (error instanceof DevelopmentDomainError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)) continue;
        throw error;
      }
    }
    const visible = [];
    const actorId = params.actorId ?? params.trustedActor?.userId;
    for (const row of rows) {
      const type = typeByCaseId.get(row.developmentCaseId);
      if (!type) continue;
      if (row.routingTeamId && ![row.requestedBy, row.startedBy, row.responsibleHeadId].includes(actorId)) {
        if (row.startedBy || !await developmentQcMember(params.prisma, { caseId: row.developmentCaseId, type, teamId: row.routingTeamId, userId: actorId || '', requesterId: row.requestedBy })) continue;
      }
      visible.push(serializeReview(row, type));
    }
    return { ok: true, data: { items: visible } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return fail(error.code, error.message, error.statusCode);
    return fail('QC_REVIEW_LIST_FAILED', '开发样品 QC 任务读取失败。', 500);
  }
}

export async function startDevelopmentSampleQualityReview(params: {
  prisma: PrismaClient; reviewId: string; actorId: string; trustedActor?: TokenPayload; ip?: string | null;
}): Promise<ServiceResult<{ item: any }>> {
  try {
    const item = await (params.prisma as any).$transaction(async (tx: any) => {
      const { review, development } = await lockDevelopmentQualityReview(tx, { ...params, historyReplay: true });
      await assertReviewSourceCurrent(tx, review);
      if (review.startedBy && review.startedBy !== params.actorId) throw new DevelopmentDomainError('FORBIDDEN', '任务已交给其他 QC，请由当前执行人处理。');
      if (review.status === 'in_progress') {
        if (review.startedBy !== params.actorId) throw new DevelopmentDomainError('FORBIDDEN', '请由当前实际执行 QC 处理；未明确执行人的历史任务须先正式认领');
        return serializeReview(review);
      }
      await assertDevelopmentOperationalWrite(tx, review.developmentCaseId, 'sample');
      if (review.status !== 'queued') throw new DevelopmentDomainError('INVALID_TRANSITION', '该 QC 任务已完成或已确认，不能再次开始');
      if (review.requestedBy === params.actorId) throw new DevelopmentDomainError('QC_SELF_REVIEW_BLOCKED', 'QC 任务发起人不能代 QC 接收评审，请由 QC 岗位处理');
      const occurredAt = BigInt(businessNowMs()), now = timestamp();
      const updated = await tx.developmentSampleQualityReview.update({ where: { id: review.id }, data: { status: 'in_progress', startedBy: params.actorId, startedAt: occurredAt, updatedAt: now } });
      await writeRouteAuditLog({ prisma: tx, actorId: params.actorId, source: 'route:qc:development-sample', operation: 'start_development_sample_qc',
        targetType: 'DevelopmentSampleQualityReview', targetId: review.id,
        before: { status: review.status, startedBy: review.startedBy ?? null },
        after: { status: updated.status, startedBy: params.actorId, startedAt: occurredAt.toString(), sampleVersionId: review.sampleVersionId ?? null, sourceFingerprint: review.sourceFingerprint }, ip: params.ip ?? null });
      return serializeReview(updated);
    });
    return { ok: true, data: { item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return fail(error.code, error.message, error.statusCode);
    return fail('QC_REVIEW_START_FAILED', 'QC 任务未能开始，请刷新后重试。', 500);
  }
}

export async function completeDevelopmentSampleQualityReview(params: {
  prisma: PrismaClient; reviewId: string; actorId: string; trustedActor?: TokenPayload; ip?: string | null; input: any; privateFilesDir?: string;
}): Promise<ServiceResult<{ item: any }>> {
  try {
    const requestKey = inputString(params.input?.requestKey, '原请求编号', 128)!;
    const result = String(params.input?.result ?? '').trim();
    if (!['pass', 'conditional_pass', 'needs_adjustment', 'reject'].includes(result)) throw new DevelopmentDomainError('INVALID_INPUT', '评审结论必须是 pass、conditional_pass、needs_adjustment 或 reject');
    const opinion = inputString(params.input?.opinion, result === 'conditional_pass' ? '有保留通过的问题说明' : 'QC 评审意见', 4000)!;
    const inspectionDate = inputString(params.input?.inspectionDate, '评审日期', 10, true);
    if (inspectionDate && !/^\d{4}-\d{2}-\d{2}$/.test(inspectionDate)) throw new DevelopmentDomainError('INVALID_INPUT', '评审日期格式应为 YYYY-MM-DD');
    const inspectorOrg = inputString(params.input?.inspectorOrg, '评审组织', 120, true);
    const criticalDefects = normalizeDefectCount(params.input?.criticalDefects, '致命疵点数');
    const majorDefects = normalizeDefectCount(params.input?.majorDefects, '主要疵点数');
    const minorDefects = normalizeDefectCount(params.input?.minorDefects, '次要疵点数');
    const evidence = params.input?.evidence == null ? [] : params.input.evidence;
    if (!Array.isArray(evidence) || evidence.length > 30) throw new DevelopmentDomainError('INVALID_INPUT', 'QC 证据需使用不超过 30 项的列表');
    const suppliedMeasurements = Object.prototype.hasOwnProperty.call(params.input ?? {}, 'measurements');
    let measurements: ReturnType<typeof normalizeDevelopmentQcMeasurements> = [];
    if (suppliedMeasurements) { try { measurements = normalizeDevelopmentQcMeasurements(params.input.measurements); } catch (error) { throw new DevelopmentDomainError('INVALID_INPUT', (error as Error).message); } }
    const suppliedFileIds = Object.prototype.hasOwnProperty.call(params.input ?? {}, 'evidenceFileIds');
    const evidenceFileIds = normalizeQcEvidenceIds(params.input?.evidenceFileIds);
    const decision = { result, opinion, inspectionDate, inspectorOrg, criticalDefects, majorDefects, minorDefects, evidence, ...(suppliedMeasurements ? { measurements } : {}) };
    // Preserve exact replay of old reports without reclassifying their links
    // as verified files. New file-backed commands fingerprint actual IDs.
    const completionFingerprint = digest(suppliedFileIds ? { ...decision, evidenceFileIds } : decision);
    const item = await (params.prisma as any).$transaction(async (tx: any) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`development-qc-completion:${requestKey}`}, 0))::text`);
      const { review, development } = await lockDevelopmentQualityReview(tx, { ...params, historyReplay: true });
      const priorCompletion = await tx.developmentSampleQualityReview.findUnique({ where: { completionRequestKey: requestKey } });
      if (priorCompletion && priorCompletion.id !== review.id) throw new DevelopmentDomainError('REQUEST_CONFLICT', '原评审提交编号已属于另一份报告，请核对原请求');
      if (review.status === 'reviewed' || review.status === 'acknowledged') {
        if (review.completionRequestKey === requestKey && review.completionFingerprint === completionFingerprint && review.reviewedBy === params.actorId) return serializeReview(review);
        throw new DevelopmentDomainError('QC_REVIEW_ALREADY_COMPLETED', '该次 QC 结论已提交，不能覆盖；可对同一准确版本另行发起复评，保留原报告');
      }
      if (review.status !== 'in_progress') throw new DevelopmentDomainError('INVALID_TRANSITION', '请先开始 QC 任务，再提交评审结论');
      await assertDevelopmentOperationalWrite(tx, review.developmentCaseId, 'sample');
      if (review.requestedBy === params.actorId) throw new DevelopmentDomainError('QC_SELF_REVIEW_BLOCKED', 'QC 任务发起人不能代 QC 完成评审，请由 QC 岗位提交结论');
      if (review.startedBy !== params.actorId) throw new DevelopmentDomainError('FORBIDDEN', '只有本任务当前实际执行 QC 可以提交正式报告，请先正式认领或转交');
      await assertReviewSourceCurrent(tx, review);
      if (evidence.length) throw new DevelopmentDomainError('INVALID_INPUT', '新报告附件须先在本次准确 QC 任务上传，再提交 evidenceFileIds；不能使用外链或自填文件证明');
      if (evidenceFileIds.length && !params.privateFilesDir) throw new DevelopmentDomainError('AUTHORIZATION_UNAVAILABLE', '本次报告附件存储未配置，暂不能核验原件');
      const verifiedEvidence = evidenceFileIds.length ? await readQcEvidenceInTx(tx, { root: params.privateFilesDir!, sourceKind: 'development_review',
        sourceId: review.id, sourceFingerprint: review.sourceFingerprint, ids: evidenceFileIds }) : [];
      await authorizeDevelopmentQualityExecution(tx, review.developmentCaseId, params.actorId, params.trustedActor);
      if (development.type === 'garment' && !measurements.length) throw new DevelopmentDomainError('INVALID_INPUT', '新成衣正式报告须至少一行逐件实测');
      const occurredAt = BigInt(businessNowMs()), now = timestamp();
      const updated = await tx.developmentSampleQualityReview.update({ where: { id: review.id }, data: {
        ...decision, measurements: measurements as any, evidence: verifiedEvidence as any, status: 'reviewed', reviewedBy: params.actorId, reviewedAt: occurredAt,
        completionRequestKey: requestKey, completionFingerprint, updatedAt: now,
      } });
      const auditId = await writeRouteAuditLog({ prisma: tx, actorId: params.actorId, source: 'route:qc:development-sample', operation: 'complete_development_sample_qc',
        targetType: 'DevelopmentSampleQualityReview', targetId: review.id,
        before: { status: review.status, startedBy: review.startedBy ?? null }, after: { ...decision, measurements, evidence: verifiedEvidence, status: updated.status, reportId: updated.id, reviewedBy: params.actorId, reviewedAt: occurredAt.toString(),
          sampleVersionId: review.sampleVersionId ?? null, reviewSequence: review.reviewSequence ?? null, sourceFingerprint: review.sourceFingerprint }, ip: params.ip ?? null });
      for (const userId of new Set<string>([development.ownerId, review.requestedBy].filter((value: unknown): value is string => typeof value === 'string' && !!value))) {
        await tx.notification.create({ data: { id: `n_devqc_${randomUUID()}`, userId, type: 'development_sample_qc_report',
          title: result === 'pass' ? '开发样品 QC 已通过，待业务明确继续' : result === 'conditional_pass' ? '开发样品 QC 有保留通过，请携带问题继续' : '开发样品 QC 有调整意见，待业务处理', body: opinion, level: result === 'pass' ? 'info' : 'warning',
          link: `/development?id=${encodeURIComponent(review.developmentCaseId)}&sampleVersionId=${encodeURIComponent(review.sampleVersionId)}&reviewId=${encodeURIComponent(review.id)}`,
          metadata: { caseId: review.developmentCaseId, sampleVersionId: review.sampleVersionId, sampleBatchId: review.sampleBatchId, reviewId: review.id,
            reviewSequence: review.reviewSequence ?? null, result, actualInspectorId: params.actorId, auditId, sourceFingerprint: review.sourceFingerprint } } });
      }
      return serializeReview(updated);
    });
    return { ok: true, data: { item } };
  } catch (error: any) {
    if (error instanceof DevelopmentDomainError) return fail(error.code, error.message, error.statusCode);
    if (error instanceof QcAssignmentError) return fail(error.code === 'VALIDATION_FAILED' ? 'INVALID_INPUT' : error.code, error.message, error.statusCode);
    return fail('QC_REVIEW_COMPLETE_FAILED', 'QC 评审结果未能保存，请刷新任务后重试。', 500);
  }
}

export async function listQualityReviewsByBatchIds(prisma: PrismaClient, batchIds: string[]) {
  if (!batchIds.length) return new Map<string, any>();
  const batches = await (prisma as any).sampleBatch.findMany({ where: { id: { in: batchIds }, deletedAt: null }, select: { id: true, sampleVersionId: true } });
  const versionByBatch = new Map<string, string | null>(batches.map((batch: any) => [batch.id, batch.sampleVersionId ?? null]));
  const rows = await (prisma as any).developmentSampleQualityReview.findMany({ where: { sampleBatchId: { in: batchIds } }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] });
  const result = new Map<string, any>();
  for (const row of rows) if (!result.has(row.sampleBatchId) && row.sampleVersionId === versionByBatch.get(row.sampleBatchId)) result.set(row.sampleBatchId, serializeReview(row));
  return result;
}
