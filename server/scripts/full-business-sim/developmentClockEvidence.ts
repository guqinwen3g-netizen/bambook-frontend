import { createHash } from 'node:crypto';
import type { AuditLog, PrismaClient } from '@prisma/client';
import { BUSINESS_CLOCK_DATABASE, BUSINESS_TIME_ZONE, FIXED_BUSINESS_TIME_ISO, getBusinessClock } from '../../src/shared/businessClock';
import { batchReceiptRecordedAt, readBatchReceiptSnapshot } from '../../src/samples/sampleBatchReceipt';
import { buildDevelopmentQualitySourceSnapshot } from '../../src/development/developmentVersionGate';

export type DevelopmentClockEventKind = 'returnedAt' | 'requestedAt' | 'startedAt' | 'reviewedAt' | 'acknowledgedAt';
export interface DevelopmentClockEvidenceInput {
  caseIds: readonly string[];
  expectedBusinessTimeIso: string;
  wallStartedAtMs: number;
  wallEndedAtMs: number;
}
export interface DevelopmentClockEvidence {
  businessTime: string;
  database: string;
  caseIds: string[];
  eventCounts: Record<DevelopmentClockEventKind, number>;
  events: Array<{ kind: DevelopmentClockEventKind; caseId: string; batchId: string; versionId: string; reviewId?: string; occurredAt: string; auditId: string; recordedAt: string }>;
  receiptProofs: Array<{ caseId: string; batchId: string; versionId: string; cardId: string; createAuditId: string;
    receivedAt: string; recordedAt: string; sourceFingerprint: string; receiptFingerprint: string; proofLayout: 'separate_clocks' }>;
  handoffs: Array<{ reviewId: string; auditId: string; operation: string; occurredAt: string; recordedAt: string; updatedAt: string }>;
  audits: Array<{ auditId: string; action: string; targetId: string; recordedAt: string }>;
  wallFacts: Array<{ entity: string; id: string; createdAt: string; updatedAt: string }>;
  /** Only newly created rehearsal cases are read. Old receipt compatibility is
   * covered separately; this helper never manufactures an old native proof. */
  legacyReceiptsObserved: 0;
}
const kinds: DevelopmentClockEventKind[] = ['returnedAt', 'requestedAt', 'startedAt', 'reviewedAt', 'acknowledgedAt'];
const actions = ['sample_card_create', 'record_development_sample_return', 'request_development_sample_qc',
  'start_development_sample_qc', 'development_qc_handoff', 'complete_development_sample_qc', 'acknowledge_development_sample_qc'];
function invalid(code: string, detail: string): never { throw Error(`DEVELOPMENT_CLOCK_EVIDENCE_${code}: ${detail}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('SOURCE', label);
  return value as Record<string, unknown>;
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixedClock(): void {
  const clock = getBusinessClock();
  if (clock.mode !== 'fixed' || clock.nowIso !== FIXED_BUSINESS_TIME_ISO || clock.database !== BUSINESS_CLOCK_DATABASE || clock.timeZone !== BUSINESS_TIME_ZONE)
    invalid('CLOCK', 'The actual guarded development business clock must remain fixed.');
}

/** Read-only postcondition for the dedicated private full rehearsal. The caller
 * must first pass assertScenarioRehearsalDatabase, including its manifest,
 * nonce and SQL cluster identity. This helper grants no writes or runner bypass.
 * Supply only the exact case IDs earned by this invocation's real producers. */
export async function readDevelopmentClockEvidence(prisma: PrismaClient, input: DevelopmentClockEvidenceInput): Promise<DevelopmentClockEvidence> {
  if (!Array.isArray(input.caseIds) || !input.caseIds.length || input.caseIds.length > 100
    || input.caseIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id))
    || new Set(input.caseIds).size !== input.caseIds.length || input.expectedBusinessTimeIso !== FIXED_BUSINESS_TIME_ISO
    || !Number.isSafeInteger(input.wallStartedAtMs) || input.wallStartedAtMs <= 0
    || !Number.isSafeInteger(input.wallEndedAtMs) || input.wallEndedAtMs < input.wallStartedAtMs) invalid('INPUT', 'Exact new case IDs and a valid actual process-time window are required.');
  fixedClock();
  const caseIds = [...input.caseIds].sort(), expected = Date.parse(FIXED_BUSINESS_TIME_ISO);
  const wallTime = (value: bigint | Date | string | number, label: string): string => {
    const ms = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isSafeInteger(ms) || ms < input.wallStartedAtMs || ms > input.wallEndedAtMs) invalid('WALL_TIME', label);
    return String(ms);
  };
  const eventTime = (value: bigint | string | number | null, label: string): string => {
    if (value == null || Number(value) !== expected) invalid('BUSINESS_EVENT_TIME', label);
    return String(expected);
  };
  const result = await prisma.$transaction(async tx => {
    const database = await tx.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (database.length !== 1 || database[0].database !== BUSINESS_CLOCK_DATABASE) invalid('DATABASE', 'Exact private panda_hub_dev SQL identity is required.');
    const [cases, batches, versions, reviews, cards] = await Promise.all([
      tx.developmentCase.findMany({ where: { id: { in: caseIds } }, orderBy: { id: 'asc' } }),
      tx.sampleBatch.findMany({ where: { developmentCaseId: { in: caseIds } }, orderBy: { id: 'asc' } }),
      tx.developmentSampleVersion.findMany({ where: { developmentCaseId: { in: caseIds } }, orderBy: { id: 'asc' } }),
      tx.developmentSampleQualityReview.findMany({ where: { developmentCaseId: { in: caseIds } }, orderBy: { id: 'asc' } }),
      tx.sampleCardItem.findMany({ where: { devCaseId: { in: caseIds } }, orderBy: { id: 'asc' } }),
    ]);
    if (!same(cases.map(row => row.id).sort(), caseIds)) invalid('SOURCE', 'One or more exact new development cases are unavailable.');
    const byCase = new Map(cases.map(row => [row.id, row])), byBatch = new Map(batches.map(row => [row.id, row])), byVersion = new Map(versions.map(row => [row.id, row]));
    const evidence: DevelopmentClockEvidence = { businessTime: FIXED_BUSINESS_TIME_ISO, database: database[0].database, caseIds,
      eventCounts: { returnedAt: 0, requestedAt: 0, startedAt: 0, reviewedAt: 0, acknowledgedAt: 0 }, events: [], receiptProofs: [], handoffs: [], audits: [], wallFacts: [], legacyReceiptsObserved: 0 };
    const addWallFact = (entity: string, row: { id: string; createdAt: bigint; updatedAt: bigint }) => {
      evidence.wallFacts.push({ entity, id: row.id, createdAt: wallTime(row.createdAt, `${entity}.${row.id}.createdAt`), updatedAt: wallTime(row.updatedAt, `${entity}.${row.id}.updatedAt`) });
    };
    for (const row of cases) {
      if (!['fabric', 'garment'].includes(row.type) || row.deletedAt != null) invalid('SOURCE', `DevelopmentCase.${row.id}`);
      addWallFact('DevelopmentCase', row);
    }
    for (const row of versions) {
      if (!byCase.has(row.developmentCaseId) || row.deletedAt != null) invalid('SOURCE', `DevelopmentSampleVersion.${row.id}`);
      addWallFact('DevelopmentSampleVersion', row);
    }
    for (const row of batches) {
      const version = row.sampleVersionId ? byVersion.get(row.sampleVersionId) : undefined, development = byCase.get(row.developmentCaseId);
      if (!development || !version || version.versionKind !== 'major' || version.developmentCaseId !== row.developmentCaseId || version.supplierRelationId !== row.supplierRelationId
        || row.deletedAt != null || (row.sampleType === 'garment-round') !== (development.type === 'garment')) invalid('SOURCE', `SampleBatch.${row.id}`);
      addWallFact('SampleBatch', row);
    }
    const audits = await tx.auditLog.findMany({ where: { action: { in: actions }, OR: [
      { targetType: 'SampleBatch', targetId: { in: batches.map(row => row.id) } },
      { targetType: 'DevelopmentSampleQualityReview', targetId: { in: reviews.map(row => row.id) } },
      { targetType: 'SampleCardItem', targetId: { in: cards.map(row => row.id) } },
    ] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    for (const audit of audits) evidence.audits.push({ auditId: audit.id, action: audit.action, targetId: audit.targetId ?? invalid('SOURCE', 'Audit target is absent.'), recordedAt: wallTime(audit.createdAt, `AuditLog.${audit.id}.createdAt`) });
    const auditFor = (action: string, targetId: string, actorId: string, source: string): AuditLog => {
      const matches = audits.filter(row => row.action === action && row.targetId === targetId);
      const audit = matches[0];
      if (matches.length !== 1 || audit.actorId !== actorId || object(audit.detail, 'Audit detail').source !== source) invalid('AUDIT', `${action}:${targetId}`);
      return audit;
    };
    const after = (audit: AuditLog) => object(object(audit.detail, 'Audit detail').after, `AuditLog.${audit.id}.after`);
    const addEvent = (kind: DevelopmentClockEventKind, value: bigint | null, batch: typeof batches[number], audit: AuditLog, reviewId?: string, versionId = batch.sampleVersionId!) => {
      evidence.events.push({ kind, caseId: batch.developmentCaseId, batchId: batch.id, versionId, ...(reviewId ? { reviewId } : {}),
        occurredAt: eventTime(value, `${reviewId ?? batch.id}.${kind}`), auditId: audit.id, recordedAt: wallTime(audit.createdAt, `AuditLog.${audit.id}.createdAt`) });
      evidence.eventCounts[kind]++;
    };
    for (const batch of batches) if (batch.returnedAt != null) {
      eventTime(batch.returnedAt, `${batch.id}.returnedAt`);
      if (!batch.returnedBy) invalid('SOURCE', `SampleBatch.${batch.id}.returnedBy`);
      const audit = auditFor('record_development_sample_return', batch.id, batch.returnedBy, 'route:dev:sample-return-results'), fact = after(audit);
      if (fact.returnedAt !== String(batch.returnedAt) || fact.returnedBy !== batch.returnedBy || fact.requestKey !== batch.returnRequestKey || fact.fingerprint !== batch.returnFingerprint) invalid('AUDIT', `SampleBatch.${batch.id}.returnedAt`);
      if (!cards.some(card => card.batchId === batch.id && card.devCaseId === batch.developmentCaseId)) invalid('RECEIPT', `Returned batch ${batch.id} has no original physical card.`);
      addEvent('returnedAt', batch.returnedAt, batch, audit);
    }
    for (const card of cards) {
      const batch = card.batchId ? byBatch.get(card.batchId) : undefined, receipt = readBatchReceiptSnapshot(card.receiptSnapshot);
      if (!batch || !receipt || batch.returnedAt == null || card.deletedAt != null || card.devCaseId !== batch.developmentCaseId
        || receipt.batchId !== batch.id || receipt.batchCode !== batch.batchCode || receipt.developmentCaseId !== batch.developmentCaseId || receipt.factoryId !== batch.supplierRelationId
        || receipt.sourceSnapshot.batch.sampleVersionId !== batch.sampleVersionId || receipt.sourceRound !== batch.round
        || receipt.receivedBy !== batch.returnedBy || receipt.cardType !== card.cardType || receipt.physicalUnit !== card.unit) invalid('RECEIPT', `SampleCardItem.${card.id}`);
      if (receipt.recordedAt === undefined) invalid('NEW_RECEIPT_RECORDED_AT', `New rehearsal card ${card.id} lacks a separate original recordedAt.`);
      eventTime(receipt.receivedAt, `SampleCardItem.${card.id}.receivedAt`);
      if (receipt.receivedAt !== String(batch.returnedAt) || batchReceiptRecordedAt(receipt) !== String(card.createdAt)) invalid('RECEIPT', `SampleCardItem.${card.id}.recordedAt`);
      const audit = auditFor('sample_card_create', card.id, receipt.receivedBy, 'development:sample-return'), fact = after(audit);
      if (audit.targetType !== 'SampleCardItem' || audit.operationType !== 'create' || fact.code !== card.code || typeof fact.name !== 'string'
        || fact.cardType !== receipt.cardType || fact.unit !== receipt.physicalUnit || fact.devCaseId !== receipt.developmentCaseId || fact.batchId !== receipt.batchId
        || fact.quantity !== receipt.initialPhysicalCardCount || fact.availableQty !== receipt.initialPhysicalCardCount || !same(fact.receiptSnapshot, card.receiptSnapshot)) invalid('RECEIPT', `Original create proof ${card.id}`);
      addWallFact('SampleCardItem', card);
      evidence.receiptProofs.push({ caseId: batch.developmentCaseId, batchId: batch.id, versionId: batch.sampleVersionId!, cardId: card.id, createAuditId: audit.id,
        receivedAt: receipt.receivedAt, recordedAt: wallTime(receipt.recordedAt, `Receipt.${card.id}.recordedAt`), sourceFingerprint: receipt.sourceFingerprint,
        receiptFingerprint: digest(canonical(card.receiptSnapshot)), proofLayout: 'separate_clocks' });
    }
    for (const review of reviews) {
      const batch = byBatch.get(review.sampleBatchId), version = review.sampleVersionId ? byVersion.get(review.sampleVersionId) : undefined;
      const physical = batch?.sampleVersionId ? byVersion.get(batch.sampleVersionId) : undefined;
      if (!batch || !version || !physical || review.developmentCaseId !== batch.developmentCaseId || version.developmentCaseId !== review.developmentCaseId
        || version.supplierRelationId !== batch.supplierRelationId || version.roundId !== physical.roundId
        || version.id !== physical.id && (version.versionKind !== 'minor' || version.parentVersionId !== physical.id)) invalid('SOURCE', `DevelopmentSampleQualityReview.${review.id}`);
      if (!['queued', 'in_progress', 'reviewed', 'acknowledged'].includes(review.status)
        || review.status !== 'queued' && (review.startedAt == null || !review.startedBy)
        || ['reviewed', 'acknowledged'].includes(review.status) && (review.reviewedAt == null || !review.reviewedBy || review.reviewedBy !== review.startedBy)
        || review.status === 'acknowledged' && (review.acknowledgedAt == null || !review.acknowledgedBy)) invalid('SOURCE', `QC lifecycle timestamps including acknowledgedAt are incomplete: ${review.id}`);
      const physicalItems = cards.filter(card => card.batchId === batch.id && card.devCaseId === batch.developmentCaseId).sort((a, b) => a.id.localeCompare(b.id));
      const source = buildDevelopmentQualitySourceSnapshot(batch, byCase.get(batch.developmentCaseId), physicalItems, { version, physicalVersion: physical });
      // PostgreSQL JSONB may reorder stored keys. Rebuild the producer's exact
      // serialization and also compare stored content, never hash JSONB order.
      if (digest(source) !== review.sourceFingerprint || !same(source, review.sourceSnapshot)) invalid('SOURCE', `Frozen QC source ${review.id}`);
      addWallFact('DevelopmentSampleQualityReview', review);
      const requested = auditFor('request_development_sample_qc', review.id, review.requestedBy, 'route:dev:sample-qc-request'), requestFact = after(requested);
      if (requestFact.caseId !== review.developmentCaseId || requestFact.sampleBatchId !== batch.id || requestFact.sampleVersionId !== version.id
        || requestFact.reviewSequence !== review.reviewSequence || requestFact.sourceFingerprint !== review.sourceFingerprint) invalid('AUDIT', `QC request ${review.id}`);
      addEvent('requestedAt', review.requestedAt, batch, requested, review.id, version.id);
      const handoffs = audits.filter(row => row.action === 'development_qc_handoff' && row.targetId === review.id);
      let latestHandoff: AuditLog | undefined, latestHandoffRevision = -1;
      for (const audit of handoffs) {
        const entry = after(audit), fact = object(entry.receipt, `Handoff ${audit.id}`), item = object(entry.item, `Handoff ${audit.id} original item`);
        if (object(audit.detail, 'Handoff detail').source !== 'api:development-qc-handoff' || fact.reviewId !== review.id || fact.developmentCaseId !== review.developmentCaseId
          || fact.sampleBatchId !== batch.id || fact.sampleVersionId !== version.id || fact.sourceFingerprint !== review.sourceFingerprint || fact.actorId !== audit.actorId
          || !['claim', 'transfer'].includes(String(fact.operation)) || item.id !== review.id || item.sampleVersionId !== version.id
          || item.startedBy !== fact.toUserId || Number(item.startedAt) !== expected) invalid('AUDIT', `QC handoff ${audit.id}`);
        const revision = wallTime(String(item.updatedAt), `Handoff.${audit.id}.updatedAt`);
        if (Number(revision) > latestHandoffRevision) { latestHandoff = audit; latestHandoffRevision = Number(revision); }
        evidence.handoffs.push({ reviewId: review.id, auditId: audit.id, operation: String(fact.operation), occurredAt: eventTime(String(fact.occurredAt), `Handoff.${audit.id}.occurredAt`),
          recordedAt: wallTime(audit.createdAt, `AuditLog.${audit.id}.createdAt`), updatedAt: revision });
      }
      if (review.startedAt != null) {
        eventTime(review.startedAt, `${review.id}.startedAt`);
        const started = latestHandoff ?? auditFor('start_development_sample_qc', review.id, review.startedBy ?? '', 'route:qc:development-sample');
        const fact = latestHandoff ? object(after(started).receipt, 'Latest handoff receipt') : after(started);
        if ((latestHandoff ? fact.toUserId : fact.startedBy) !== review.startedBy || (latestHandoff ? fact.occurredAt : fact.startedAt) !== String(review.startedAt)) invalid('AUDIT', `QC actual start ${review.id}`);
        addEvent('startedAt', review.startedAt, batch, started, review.id, version.id);
      }
      if (review.reviewedAt != null) {
        eventTime(review.reviewedAt, `${review.id}.reviewedAt`);
        const completed = auditFor('complete_development_sample_qc', review.id, review.reviewedBy ?? '', 'route:qc:development-sample'), fact = after(completed);
        if (fact.reportId !== review.id || fact.sampleVersionId !== version.id || fact.sourceFingerprint !== review.sourceFingerprint || fact.reviewedAt !== String(review.reviewedAt) || fact.result !== review.result) invalid('AUDIT', `QC completion ${review.id}`);
        addEvent('reviewedAt', review.reviewedAt, batch, completed, review.id, version.id);
      }
      if (review.acknowledgedAt != null) {
        eventTime(review.acknowledgedAt, `${review.id}.acknowledgedAt`);
        const acknowledged = auditFor('acknowledge_development_sample_qc', review.id, review.acknowledgedBy ?? '', 'route:dev:sample-qc-acknowledge'), fact = after(acknowledged);
        if (fact.acknowledgedAt !== String(review.acknowledgedAt) || fact.status !== 'acknowledged' || fact.result !== review.result) invalid('AUDIT', `QC business acknowledgment ${review.id}`);
        addEvent('acknowledgedAt', review.acknowledgedAt, batch, acknowledged, review.id, version.id);
      }
    }
    for (const kind of kinds) if (!evidence.eventCounts[kind]) invalid('COVERAGE', `No actual ${kind} event was observed in this supplied rehearsal.`);
    return evidence;
  }, { isolationLevel: 'RepeatableRead' });
  fixedClock();
  return result;
}
