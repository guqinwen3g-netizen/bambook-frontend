import { Prisma } from '@prisma/client';
import {
  assertDevelopmentQualityCompletionAudit,
  assertDevelopmentQualitySourceCurrent,
  latestDevelopmentVersionQualityReview,
  resolveDevelopmentVersionForBatch,
} from '../development/developmentVersionGate';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { PhysicalShipmentError } from './samplePhysicalShipment';

const jsonFact = (value: any): any => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item));
const recordedTime = (value: unknown) => value != null && /^\d+$/.test(String(value)) && BigInt(String(value)) > BigInt(0);
const canonicalFact = (value: any): any => Array.isArray(value) ? value.map(canonicalFact) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalFact(value[key])])) : value;
const sameFact = (left: any, right: any) => JSON.stringify(canonicalFact(jsonFact(left))) === JSON.stringify(canonicalFact(jsonFact(right)));

/** Authenticate the frozen successful command, never reconsider today's QC.
 * Case/source locks are already held by the caller. Old receipts that recorded
 * no quality proof on either side keep their original replay protocol. */
export async function assertGarmentShipmentQualityReplayIntegrity(tx: any, input: {
  caseId: string; batchId: string; actorId: string; requestKey: string; requestFingerprint: string; shipment: any;
}) {
  const where = {
    action: 'submit_garment_sample_to_customer', targetType: 'DevelopmentCase', targetId: input.caseId, actorId: input.actorId,
    detail: { path: ['source'], equals: 'route:samples:garment-gate' },
    AND: [{ detail: { path: ['after', 'roundId'], equals: input.batchId } },
      { detail: { path: ['after', 'requestKey'], equals: input.requestKey } },
      { detail: { path: ['after', 'requestFingerprint'], equals: input.requestFingerprint } }],
  };
  const hint = await tx.auditLog.findFirst({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const proof = input.shipment.qualityProof;
  if (proof == null && hint?.detail?.after?.qualityProof == null) return;
  const reject = (): never => { throw new PhysicalShipmentError('DEVELOPMENT_SOURCE_CHANGED', '原寄送回执的冻结质量事实与提交审计不一致，请核对原寄送记录。'); };
  if (!hint) reject();
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AuditLog" WHERE "id" = ${hint.id} FOR UPDATE`);
  const audit = await tx.auditLog.findFirst({ where: { ...where, id: hint.id } });
  const fact = audit?.detail?.after;
  if (!audit || audit.actorId !== input.actorId || input.shipment.shippedBy !== input.actorId
    || input.shipment.requestKey !== input.requestKey || input.shipment.requestFingerprint !== input.requestFingerprint
    || fact?.status !== 'submitted' || fact?.roundId !== input.batchId || fact?.requestKey !== input.requestKey || fact?.requestFingerprint !== input.requestFingerprint
    || proof?.schemaVersion !== 1 || fact?.qualityProof?.schemaVersion !== 1
    || proof.caseId !== input.caseId || proof.sampleBatchId !== input.batchId
    || !fact.shipmentEntry || !sameFact(proof, fact.qualityProof) || !sameFact(input.shipment, fact.shipmentEntry)) reject();
}

/** The caller holds the case and batch locks and has already returned any
 * successful shipment replay. Shipping needs QC alone; requester confirmation
 * remains a later, separate decision. Never select an older completed report. */
export async function assertGarmentCustomerShipmentQuality(tx: any, caseId: string, batch: any) {
  if (batch.returnedAt == null) {
    throw new PhysicalShipmentError('QC_GATE_NOT_PASSED', '该准确版本尚未登记工厂实际返样，不能完成正式 QC 或寄客户。');
  }
  const { version, physicalVersion } = await resolveDevelopmentVersionForBatch(tx, { caseId, batch, lock: true });
  const hint = await latestDevelopmentVersionQualityReview(tx, caseId, version.id);
  if (!hint) throw new PhysicalShipmentError('QC_GATE_NOT_PASSED', '该准确版本尚无正式 QC 报告，不能寄客户。');
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "DevelopmentSampleQualityReview" WHERE "id" = ${hint.id} AND "developmentCaseId" = ${caseId} AND "sampleBatchId" = ${batch.id} AND "sampleVersionId" = ${version.id} FOR UPDATE`);
  const review = await latestDevelopmentVersionQualityReview(tx, caseId, version.id);
  if (!review || review.id !== hint.id || review.developmentCaseId !== caseId || review.sampleBatchId !== batch.id || review.sampleVersionId !== version.id) {
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', '当前 QC 报告与本次准确版本或返样批次不一致，请核对原报告。');
  }
  if (!['reviewed', 'acknowledged'].includes(review.status) || !['pass', 'conditional_pass'].includes(review.result)
    || typeof review.reviewedBy !== 'string' || !review.reviewedBy.trim() || !recordedTime(review.reviewedAt)) {
    throw new PhysicalShipmentError('QC_GATE_NOT_PASSED', '该准确版本当前 QC 尚未完成通过或有保留通过，不能寄客户。');
  }
  if (review.result === 'conditional_pass' && (typeof review.opinion !== 'string' || !review.opinion.trim())) {
    throw new PhysicalShipmentError('QC_GATE_NOT_PASSED', '有保留通过须保留具体问题说明，再随样品寄客户。');
  }
  const audit = await assertDevelopmentQualityCompletionAudit(tx, review);
  const current = await assertDevelopmentQualitySourceCurrent(tx, review);
  if (current.batch.id !== batch.id || current.batch.sampleVersionId !== physicalVersion.id) {
    throw new DevelopmentDomainError('DEVELOPMENT_SOURCE_CHANGED', 'QC 返样来源与本次寄出的准确实物版本不一致。');
  }
  return jsonFact({
    schemaVersion: 1, caseId, sampleBatchId: batch.id,
    sampleVersionId: version.id, physicalSampleVersionId: physicalVersion.id,
    versionLabel: version.versionLabel, supplierRelationId: version.supplierRelationId,
    qualityReviewId: review.id, qualityReviewSequence: review.reviewSequence ?? null,
    qualityResult: review.result, qualityOpinion: review.opinion ?? null,
    qualityEvidence: review.evidence ?? [], qualityMeasurements: review.measurements ?? [],
    reviewedBy: review.reviewedBy, reviewedAt: String(review.reviewedAt),
    qualityCompletionAuditId: audit.id,
    sourceFingerprint: review.sourceFingerprint, sourceSnapshot: current.sourceSnapshot,
  });
}
