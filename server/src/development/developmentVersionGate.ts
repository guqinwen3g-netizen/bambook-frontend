import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { DevelopmentDomainError } from './developmentOperationalGuard';
import { businessNowMs } from '../shared/businessClock';

/** Resolve an explicitly recorded version against its real physical batch.
 * A dotted version shares that batch; it never inherits the parent's decisions.
 * Legacy labels and round numbers cannot establish a missing version identity. */
export async function resolveDevelopmentVersionForBatch(tx: any, input: {
  caseId: string; batch: any; sampleVersionId?: string | null; lock?: boolean;
}) {
  const versionId = input.sampleVersionId ?? input.batch.sampleVersionId;
  if (!versionId || !input.batch.sampleVersionId) {
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '此历史样品缺少准确开发版本关联，不能按名称或轮次推算，请先核对来源');
  }
  if (input.lock) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleVersion" WHERE "id" = ${versionId} AND "developmentCaseId" = ${input.caseId} AND "deletedAt" IS NULL FOR UPDATE`);
  const version = await tx.developmentSampleVersion.findFirst({ where: { id: versionId, developmentCaseId: input.caseId, deletedAt: null } });
  if (!version || version.supplierRelationId !== input.batch.supplierRelationId
    || (version.id !== input.batch.sampleVersionId && (version.versionKind !== 'minor' || version.parentVersionId !== input.batch.sampleVersionId))) {
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '所选准确版本与返样的开发案、工厂或实物来源不一致');
  }
  const physicalVersion = version.id === input.batch.sampleVersionId ? version
    : await tx.developmentSampleVersion.findFirst({ where: { id: input.batch.sampleVersionId, developmentCaseId: input.caseId, versionKind: 'major', deletedAt: null } });
  if (!physicalVersion || physicalVersion.versionKind !== 'major' || physicalVersion.supplierRelationId !== version.supplierRelationId
    || physicalVersion.roundId !== version.roundId) {
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '原实物对应的大版本不存在或与所选版本不一致');
  }
  return { version, physicalVersion };
}

export function developmentVersionSnapshot(version: any) {
  return {
    id: version.id, developmentCaseId: version.developmentCaseId, roundId: version.roundId,
    supplierRelationId: version.supplierRelationId, supplierName: version.supplierName ?? null,
    versionLabel: version.versionLabel, versionKind: version.versionKind, parentVersionId: version.parentVersionId ?? null,
    minorVersion: version.minorVersion ?? 0, minorChangeNote: version.minorChangeNote ?? null,
    // Omit newly introduced identity fields on legacy rows so their frozen
    // source fingerprints remain compatible with their original reports.
    ...(version.factoryCode != null ? { factoryCode: version.factoryCode } : {}),
    ...(version.physicalSequence != null ? { physicalSequence: version.physicalSequence } : {}),
    ...(version.sourceVersionId != null ? { sourceVersionId: version.sourceVersionId } : {}),
    roundRequirementsSnapshot: version.roundRequirementsSnapshot ?? null, factoryRequirements: version.factoryRequirements ?? null,
    targetCompletionDate: version.targetCompletionDate ?? null, referenceAttachments: version.referenceAttachments ?? null,
  };
}

export async function latestDevelopmentVersionQualityReview(tx: any, caseId: string, sampleVersionId: string, completedOnly = false) {
  return tx.developmentSampleQualityReview.findFirst({
    where: { developmentCaseId: caseId, sampleVersionId,
      ...(completedOnly ? { status: { in: ['reviewed', 'acknowledged'] } } : {}) },
    orderBy: [{ reviewSequence: 'desc' }, { requestedAt: 'desc' }, { id: 'desc' }],
  });
}

export async function assertDevelopmentVersionQualityPass(tx: any, caseId: string, sampleVersionId: string) {
  const review = await latestDevelopmentVersionQualityReview(tx, caseId, sampleVersionId, true);
  if (!review || !['pass', 'conditional_pass'].includes(review.result) || !review.reviewedBy || review.reviewedAt == null) {
    throw new DevelopmentDomainError('QC_PASS_REQUIRED', '该准确版本尚无最新有效的正式 QC 通过或有保留通过报告，不能转产品档案');
  }
  if (review.result === 'conditional_pass' && !review.opinion?.trim()) {
    throw new DevelopmentDomainError('QC_PASS_REQUIRED', '有保留通过必须保留具体问题说明，不能转产品档案');
  }
  await assertDevelopmentQualityCompletionAudit(tx, review);
  return review;
}

/** A report has many request/start/read audits. Only its completion is QC evidence. */
export async function assertDevelopmentQualityCompletionAudit(tx: any, review: any) {
  const audit = await tx.auditLog.findFirst({
    where: {
      action: 'complete_development_sample_qc',
      targetType: 'DevelopmentSampleQualityReview',
      targetId: review.id,
      actorId: review.reviewedBy,
      detail: { path: ['source'], equals: 'route:qc:development-sample' },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const fact = audit?.detail?.after;
  if (!audit || audit.actorId !== review.reviewedBy || fact?.reportId !== review.id || fact?.result !== review.result
    || (review.result === 'conditional_pass' && fact?.opinion !== review.opinion)
    || String(fact?.reviewedAt) !== String(review.reviewedAt)
    || review.sampleVersionId && (fact?.sampleVersionId !== review.sampleVersionId || fact?.sourceFingerprint !== review.sourceFingerprint)) {
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '正式 QC 报告缺少一致的完成审计记录，请核对该准确版本的报告');
  }
  return audit;
}

export function developmentQualityReviewSummary(row: any) {
  return { ...row, id: row.id, reviewId: row.id, reportId: row.id,
    sampleVersionId: row.sampleVersionId ?? null, versionIdentityStatus: row.sampleVersionId ? 'recorded_exact' : 'unknown',
    versionLabel: row.sourceSnapshot?.versionLabel ?? null,
    requestedAt: Number(row.requestedAt), startedAt: row.startedAt == null ? null : Number(row.startedAt),
    reviewedAt: row.reviewedAt == null ? null : Number(row.reviewedAt), acknowledgedAt: row.acknowledgedAt == null ? null : Number(row.acknowledgedAt),
    createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt), physicalItems: row.sourceSnapshot?.physicalItems ?? [],
  };
}

/** Shared readback for the existing fabric/garment APIs. Every map key is the
 * recorded exact version, so a parent's decisions never populate a minor row. */
export async function readDevelopmentVersionDecisions(db: any, caseId: string, versionIds: string[]) {
  const result = new Map<string, any>();
  if (!versionIds.length) return result;
  const ids = [...new Set(versionIds)];
  const [reviews, confirmations] = await Promise.all([
    db.developmentSampleQualityReview.findMany({ where: { developmentCaseId: caseId, sampleVersionId: { in: ids } },
      orderBy: [{ reviewSequence: 'desc' }, { requestedAt: 'desc' }, { id: 'desc' }] }),
    db.developmentVersionConfirmation.findMany({ where: { developmentCaseId: caseId, sampleVersionId: { in: ids } },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }] }),
  ]);
  for (const versionId of ids) {
    const ownReviews = reviews.filter((row: any) => row.sampleVersionId === versionId).map(developmentQualityReviewSummary);
    const ownConfirmations = confirmations.filter((row: any) => row.sampleVersionId === versionId).map((row: any) => ({ ...row, confirmedAt: String(row.confirmedAt), recordedAt: String(row.recordedAt) }));
    result.set(versionId, {
      versionIdentityStatus: 'recorded_exact', developmentQcReview: ownReviews[0] ?? null,
      latestFormalQcReview: ownReviews.find((row: any) => ['reviewed', 'acknowledged'].includes(row.status)) ?? null,
      developmentQcHistory: ownReviews, versionConfirmation: ownConfirmations[0] ?? null, versionConfirmationHistory: ownConfirmations,
    });
  }
  return result;
}

export type DevelopmentArchiveCommand = {
  caseId: string; sampleVersionId: string; sampleBatchId: string; sourceType: string; sourceId: string; actorId: string; requestKey?: string | null;
};
function archiveRequestKey(command: DevelopmentArchiveCommand) {
  if (command.requestKey == null) return null;
  if (typeof command.requestKey !== 'string' || !command.requestKey.trim() || command.requestKey.length > 128)
    throw new DevelopmentDomainError('INVALID_INPUT', '转档须携带有效的原请求编号');
  return command.requestKey.trim();
}
function archiveFingerprint(command: DevelopmentArchiveCommand) {
  return createHash('sha256').update(JSON.stringify({ caseId: command.caseId, sampleVersionId: command.sampleVersionId,
    sampleBatchId: command.sampleBatchId, sourceType: command.sourceType, sourceId: command.sourceId, actorId: command.actorId })).digest('hex');
}
function archiveReceipt(command: DevelopmentArchiveCommand, productAssetId: string, auditId: string) {
  return { schemaVersion: 1, requestKey: archiveRequestKey(command), caseId: command.caseId, sampleVersionId: command.sampleVersionId,
    sourceSampleBatchId: command.sampleBatchId, sourceType: command.sourceType, sourceId: command.sourceId, productAssetId, auditId };
}

/** Called after current source authority and source locks, before applying a new
 * QC gate. A retry returns its original committed result even after later QC. */
export async function readDevelopmentArchiveReceipt(tx: any, command: DevelopmentArchiveCommand) {
  const requestKey = archiveRequestKey(command);
  if (!requestKey) return null;
  const row = await tx.auditLog.findFirst({ where: { action: 'acknowledge_development_archive_command', targetType: 'DevelopmentSampleVersion',
    AND: [{ detail: { path: ['after', 'caseId'], equals: command.caseId } }, { detail: { path: ['after', 'requestKey'], equals: requestKey } },
      { detail: { path: ['source'], equals: 'route:dev:archive-command' } }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!row) return null;
  const fact = row.detail?.after;
  if (row.actorId !== command.actorId || row.targetId !== command.sampleVersionId || fact?.requestFingerprint !== archiveFingerprint(command))
    throw new DevelopmentDomainError('REQUEST_CONFLICT', '原转档请求编号已对应其他准确版本或内容，请使用原请求核对回执');
  const asset = await tx.productAsset.findFirst({ where: { id: fact.productAssetId, sourceDevelopmentCaseId: command.caseId,
    sourceSampleVersionId: command.sampleVersionId, deletedAt: null } });
  if (!asset) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '原转档回执的准确产品档案已不可用，请核对历史记录');
  return { asset, conversionReceipt: archiveReceipt(command, asset.id, row.id) };
}

export async function recordDevelopmentArchiveReceipt(tx: any, command: DevelopmentArchiveCommand, productAssetId: string) {
  const requestKey = archiveRequestKey(command);
  if (!requestKey) return null;
  const auditId = await writeRouteAuditLog({ prisma: tx, actorId: command.actorId, source: 'route:dev:archive-command', operation: 'acknowledge_development_archive_command',
    targetType: 'DevelopmentSampleVersion', targetId: command.sampleVersionId, operationType: 'link',
    after: { ...archiveReceipt(command, productAssetId, ''), requestFingerprint: archiveFingerprint(command) } });
  return archiveReceipt(command, productAssetId, auditId);
}

export function buildDevelopmentQualitySourceSnapshot(batch: any, devCase: any, physicalItems: any[] = [], versionContext?: { version: any; physicalVersion: any }) {
  return {
    case: { id: devCase.id, code: devCase.code, name: devCase.name, customerRelationId: devCase.customerRelationId ?? null, customerName: devCase.customerName ?? null,
      requirements: { developmentDirection: devCase.developmentDirection ?? null, source: devCase.source ?? null, dyeMethod: devCase.dyeMethod ?? null,
        specComposition: devCase.specComposition ?? null, specWeight: devCase.specWeight ?? null, specWidth: devCase.specWidth ?? null,
        specWeave: devCase.specWeave ?? null, specFinish: devCase.specFinish ?? null, styleSpec: devCase.styleSpec ?? null,
        sizeSpec: devCase.sizeSpec ?? null, fabricSpec: devCase.fabricSpec ?? null, processSpec: devCase.processSpec ?? null } },
    round: batch.round, versionLabel: batch.versionLabel ?? null, sampleVersionId: batch.sampleVersionId ?? null,
    supplierRelationId: batch.supplierRelationId, supplierName: batch.supplierName ?? null,
    sampleType: batch.sampleType, batchId: batch.id, batchCode: batch.batchCode, specNote: batch.specNote ?? null,
    planQuantity: batch.planQuantity?.toString() ?? null, planUnit: batch.planUnit ?? null,
    returnedAt: batch.returnedAt == null ? null : String(batch.returnedAt), returnedBy: batch.returnedBy ?? null,
    results: {
      dyeLotNo: batch.dyeLotNo ?? null, colorRating: batch.colorRating ?? null, sideDiff: batch.sideDiff ?? null,
      endDiff: batch.endDiff ?? null, defectCauses: [...(batch.defectCauses ?? [])], photos: batch.photos ?? null,
      notes: batch.notes ?? null, actualQuantity: batch.actualQuantity?.toString() ?? null, actualUnit: batch.actualUnit ?? null,
    },
    // Bind the QC snapshot to the exact physical item(s) created from these return results.
    physicalItems: physicalItems.map(item => ({ id: item.id, code: item.code, cardType: item.cardType,
      physicalItemIndex: item.receiptSnapshot?.physicalItemIndex ?? null, physicalItemCount: item.receiptSnapshot?.physicalItemCount ?? null })),
    ...(versionContext ? { sampleVersionId: versionContext.version.id, versionLabel: versionContext.version.versionLabel,
      version: developmentVersionSnapshot(versionContext.version), physicalVersion: developmentVersionSnapshot(versionContext.physicalVersion) } : {}),
  };
}

export async function assertDevelopmentQualitySourceCurrent(tx: any, review: any) {
  const batch = await tx.sampleBatch.findFirst({ where: { id: review.sampleBatchId, developmentCaseId: review.developmentCaseId, deletedAt: null } });
  const devCase = await tx.developmentCase.findFirst({ where: { id: review.developmentCaseId, deletedAt: null } });
  if (!batch || !devCase || batch.returnedAt == null) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '返样来源已变化或已归档，请刷新 QC 任务');
  const physicalItems = await tx.sampleCardItem.findMany({ where: { batchId: batch.id, devCaseId: batch.developmentCaseId, deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, code: true, cardType: true, receiptSnapshot: true } });
  if (!physicalItems.length) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '开发实物样档案缺失，请先修复样品台账关联后再处理 QC');
  const versionContext = review.sampleVersionId
    ? await resolveDevelopmentVersionForBatch(tx, { caseId: review.developmentCaseId, batch, sampleVersionId: review.sampleVersionId }) : undefined;
  const current = buildDevelopmentQualitySourceSnapshot(batch, devCase, physicalItems, versionContext);
  if (createHash('sha256').update(JSON.stringify(current)).digest('hex') !== review.sourceFingerprint) throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '返样成果与 QC 收到的版本不一致，请核对原任务');
  return { batch, devCase, sourceSnapshot: current };
}

const jsonFact = (value: any): any => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
const canonicalFact = (value: any): any => Array.isArray(value) ? value.map(canonicalFact) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalFact(value[key])])) : value;
const sameFact = (left: any, right: any) => JSON.stringify(canonicalFact(jsonFact(left))) === JSON.stringify(canonicalFact(jsonFact(right)));

export type ExactDevelopmentVersionProof = {
  schemaVersion: 1; caseId: string; sampleVersionId: string; physicalSampleVersionId: string; physicalSampleBatchId: string;
  qualityResult?: string; qualityOpinion?: string | null; qualityEvidence?: unknown; qualityMeasurements?: unknown;
  qualityReviewId: string; qualityReviewSequence: number | null; qualityCompletionAuditId: string;
  confirmationId: string; confirmationAuditId: string; confirmerType: string; confirmerName: string;
  confirmerUserId: string | null; confirmerRelationId: string | null; confirmerOrganization: string | null;
  confirmedAt: string; basis: string; evidence: unknown; recordedBy: string; recordedAt: string;
  sourceSnapshot: Record<string, unknown>; sourceFingerprint: string;
};

/** New order/production consumption has two independent exact-version gates.
 * Archiving deliberately calls only the QC gate above. Old batch scalars and
 * historical approvals never supply a missing version confirmation. */
export async function assertDevelopmentVersionReadyForConsumption(tx: any, caseId: string, sampleVersionId: string) {
  const review = await assertDevelopmentVersionQualityPass(tx, caseId, sampleVersionId);
  const { batch, devCase, sourceSnapshot } = await assertDevelopmentQualitySourceCurrent(tx, review);
  if (devCase.stage === 'cancelled') throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '准确版本的原开发案已取消，不能继续消费原成果');
  const context = await resolveDevelopmentVersionForBatch(tx, { caseId, batch, sampleVersionId });
  const confirmation = await tx.developmentVersionConfirmation.findFirst({ where: { developmentCaseId: caseId, sampleVersionId },
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }] });
  const expectedType = devCase.initiator === 'internal' || !devCase.customerRelationId ? 'internal' : 'customer';
  const confirmedAt = Number(confirmation?.confirmedAt), recordedAt = Number(confirmation?.recordedAt);
  if (!confirmation || confirmation.result !== 'approved' || confirmation.confirmerType !== expectedType
    || !confirmation.confirmerName?.trim() || !confirmation.basis?.trim() || !confirmation.recordedBy
    || confirmation.confirmedAt == null || confirmation.recordedAt == null
    // Actual confirmation is a business event; recordedAt is an audit wall-clock
    // fact. A guarded fixed business clock may legitimately lead or lag it.
    || !Number.isSafeInteger(confirmedAt) || confirmedAt <= 0 || confirmedAt > businessNowMs()
    || !Number.isSafeInteger(recordedAt) || recordedAt <= 0) {
    throw new DevelopmentDomainError('DEVELOPMENT_NOT_READY', '该准确版本尚无有效实际需求方确认；正式 QC 通过可保留档案，但下单或生产须另有准确版本选用依据');
  }
  if (expectedType === 'customer' && confirmation.confirmerRelationId && confirmation.confirmerRelationId !== devCase.customerRelationId)
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '实际客户确认与准确版本的客户来源不一致');
  const frozenIds = confirmation.sourceSnapshot?.sampleBatches?.map((row: any) => row.id);
  if (!Array.isArray(frozenIds) || !frozenIds.length || new Set(frozenIds).size !== frozenIds.length)
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '需求方确认缺少准确返样来源，不能按同案或轮次推算');
  const batches = await tx.sampleBatch.findMany({ where: { id: { in: frozenIds }, developmentCaseId: caseId,
    sampleVersionId: context.physicalVersion.id, deletedAt: null }, orderBy: { id: 'asc' } });
  if (batches.length !== frozenIds.length || batches.some((row: any) => row.returnedAt == null || row.supplierRelationId !== context.version.supplierRelationId))
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '需求方确认所依据的准确返样来源已变化');
  const physicalItems = await tx.sampleCardItem.findMany({ where: { devCaseId: caseId, batchId: { in: frozenIds }, deletedAt: null },
    orderBy: { id: 'asc' }, select: { id: true, code: true, batchId: true, cardType: true } });
  const currentConfirmationSource = {
    case: { id: devCase.id, customerRelationId: devCase.customerRelationId ?? null, initiator: devCase.initiator ?? null },
    version: developmentVersionSnapshot(context.version), physicalVersion: developmentVersionSnapshot(context.physicalVersion),
    sampleBatches: batches.map((row: any) => ({ id: row.id, sampleVersionId: row.sampleVersionId, returnedAt: String(row.returnedAt) })),
    physicalItems: physicalItems.map((item: any) => ({ id: item.id, code: item.code, batchId: item.batchId, cardType: item.cardType })),
  };
  if (!physicalItems.length || !sameFact(currentConfirmationSource, confirmation.sourceSnapshot)
    || createHash('sha256').update(JSON.stringify(currentConfirmationSource)).digest('hex') !== confirmation.sourceFingerprint)
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '准确版本或实物已变化，原需求方确认不能自动延用');
  const confirmationAudit = await tx.auditLog.findFirst({ where: { action: 'record_development_version_confirmation', targetType: 'DevelopmentSampleVersion',
    targetId: sampleVersionId, actorId: confirmation.recordedBy, detail: { path: ['source'], equals: 'route:dev:version-confirmation' },
    AND: [{ detail: { path: ['after', 'id'], equals: confirmation.id } }] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!confirmationAudit || !sameFact(confirmationAudit.detail?.after, confirmation))
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '需求方实际确认缺少一致的原生录入审计，不能使用旧标量代替');
  const qcAudit = await assertDevelopmentQualityCompletionAudit(tx, review);
  const exactDevelopmentVersionProof: ExactDevelopmentVersionProof = jsonFact({ schemaVersion: 1, caseId, sampleVersionId,
    physicalSampleVersionId: context.physicalVersion.id, physicalSampleBatchId: batch.id,
    qualityReviewId: review.id, qualityReviewSequence: review.reviewSequence ?? null, qualityCompletionAuditId: qcAudit.id,
    qualityResult: review.result, qualityOpinion: review.opinion ?? null, qualityEvidence: review.evidence ?? null,
    qualityMeasurements: review.measurements ?? null,
    confirmationId: confirmation.id, confirmationAuditId: confirmationAudit.id, confirmerType: confirmation.confirmerType,
    confirmerName: confirmation.confirmerName, confirmerUserId: confirmation.confirmerUserId ?? null,
    confirmerRelationId: confirmation.confirmerRelationId ?? null, confirmerOrganization: confirmation.confirmerOrganization ?? null,
    confirmedAt: String(confirmation.confirmedAt), basis: confirmation.basis, evidence: confirmation.evidence ?? null,
    recordedBy: confirmation.recordedBy, recordedAt: String(confirmation.recordedAt), sourceSnapshot, sourceFingerprint: review.sourceFingerprint });
  return { review, confirmation, version: context.version, physicalVersion: context.physicalVersion, batch, development: devCase, exactDevelopmentVersionProof };
}
