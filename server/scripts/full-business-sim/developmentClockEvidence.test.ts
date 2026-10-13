import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { snapshotSampleOrigin } from '../../src/samples/sampleOriginService';
import { buildDevelopmentQualitySourceSnapshot } from '../../src/development/developmentVersionGate';
import { readDevelopmentClockEvidence } from './developmentClockEvidence';

const clock = vi.hoisted(() => ({ value: { mode: 'fixed', nowIso: '2026-10-08T00:18:00.000Z', timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' } }));
vi.mock('../../src/shared/businessClock', async () => ({ ...await vi.importActual('../../src/shared/businessClock'), getBusinessClock: () => clock.value }));
const fixed = Date.parse('2026-10-08T00:18:00.000Z');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(wallIso = '2026-10-07T08:00:00.000Z') {
  const wall = Date.parse(wallIso), wallStamp = BigInt(wall);
  const development = { id: 'new-case', code: 'DEV-NEW', name: '本轮准确新案', type: 'fabric', createdAt: wallStamp, updatedAt: wallStamp, deletedAt: null };
  const version = { id: 'version-major', developmentCaseId: development.id, supplierRelationId: 'factory', roundId: 'round', versionKind: 'major', parentVersionId: null as string | null, versionLabel: 'R1-A', createdAt: wallStamp, updatedAt: wallStamp, deletedAt: null };
  const batch = { id: 'batch', batchCode: 'SB-NEW', developmentCaseId: development.id, supplierRelationId: version.supplierRelationId, sampleVersionId: version.id,
    sampleType: 'yardage', round: 1, versionLabel: version.versionLabel, returnedAt: BigInt(fixed), returnedBy: 'business', returnRequestKey: 'return-key',
    returnFingerprint: 'return-fingerprint', createdAt: wallStamp, updatedAt: wallStamp, deletedAt: null };
  const sourceSnapshot = snapshotSampleOrigin(batch, development);
  // The real receipt parser verifies its own canonical content fingerprint.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  const receipt = { version: 2, nativeFamily: 'fabric-batch', batchId: batch.id, batchCode: batch.batchCode, developmentCaseId: development.id,
    factoryId: batch.supplierRelationId, sourceRound: batch.round, sampleType: batch.sampleType, sourceSnapshot,
    sourceFingerprint: hash(canonical({ schemaVersion: 1, batch: sourceSnapshot.batch, content: sourceSnapshot.content })), cardType: 'fabric',
    actualQuantity: '10.5', actualUnit: '米', colorRating: null, batchUpdatedAt: String(wall), initialPhysicalCardCount: 1, physicalUnit: '米',
    receivedAt: String(fixed), recordedAt: String(wall), receivedBy: 'business' };
  const card = { id: 'card', code: 'SC-NEW', name: '原实物', cardType: 'fabric', unit: '米', batchId: batch.id, devCaseId: development.id,
    receiptSnapshot: receipt, createdAt: wallStamp, updatedAt: wallStamp, deletedAt: null };
  const reviewSource = buildDevelopmentQualitySourceSnapshot(batch, development, [card], { version, physicalVersion: version });
  const review = { id: 'review', developmentCaseId: development.id, sampleBatchId: batch.id, sampleVersionId: version.id, reviewSequence: 1,
    sourceSnapshot: reviewSource, sourceFingerprint: hash(reviewSource), requestedBy: 'business', requestedAt: BigInt(fixed), startedBy: 'qc', startedAt: BigInt(fixed) as bigint | null,
    reviewedBy: 'qc', reviewedAt: BigInt(fixed) as bigint | null, acknowledgedBy: 'business', acknowledgedAt: BigInt(fixed) as bigint | null, status: 'acknowledged', result: 'pass',
    createdAt: wallStamp, updatedAt: wallStamp };
  const audit = (id: string, action: string, targetType: string, targetId: string, actorId: string, source: string, after: unknown, operationType: string | null = null) =>
    ({ id, action, targetType, targetId, actorId, operationType, detail: { source, after }, createdAt: new Date(wall) });
  const audits = [
    audit('card-audit', 'sample_card_create', 'SampleCardItem', card.id, 'business', 'development:sample-return', { code: card.code, name: card.name, cardType: card.cardType,
      unit: card.unit, devCaseId: development.id, batchId: batch.id, quantity: 1, availableQty: 1, receiptSnapshot: receipt }, 'create'),
    audit('return-audit', 'record_development_sample_return', 'SampleBatch', batch.id, 'business', 'route:dev:sample-return-results', {
      returnedAt: String(fixed), returnedBy: 'business', requestKey: batch.returnRequestKey, fingerprint: batch.returnFingerprint }),
    audit('request-audit', 'request_development_sample_qc', 'DevelopmentSampleQualityReview', review.id, 'business', 'route:dev:sample-qc-request', {
      caseId: development.id, sampleBatchId: batch.id, sampleVersionId: version.id, reviewSequence: 1, sourceFingerprint: review.sourceFingerprint }),
    audit('claim-audit', 'development_qc_handoff', 'DevelopmentSampleQualityReview', review.id, 'qc', 'api:development-qc-handoff', {
      item: { id: review.id, sampleVersionId: version.id, startedBy: 'qc', startedAt: fixed, updatedAt: wall },
      receipt: { operation: 'claim', actorId: 'qc', toUserId: 'qc', reviewId: review.id, developmentCaseId: development.id, sampleBatchId: batch.id,
        sampleVersionId: version.id, sourceFingerprint: review.sourceFingerprint, occurredAt: String(fixed) } }),
    audit('complete-audit', 'complete_development_sample_qc', 'DevelopmentSampleQualityReview', review.id, 'qc', 'route:qc:development-sample', {
      reportId: review.id, sampleVersionId: version.id, sourceFingerprint: review.sourceFingerprint, reviewedBy: 'qc', reviewedAt: String(fixed), result: 'pass' }),
    audit('ack-audit', 'acknowledge_development_sample_qc', 'DevelopmentSampleQualityReview', review.id, 'business', 'route:dev:sample-qc-acknowledge', {
      acknowledgedAt: String(fixed), status: 'acknowledged', result: 'pass' }),
  ];
  const rows = { cases: [development], versions: [version], batches: [batch], cards: [card], reviews: [review], audits };
  const tx = { $queryRaw: vi.fn(async () => [{ database: 'panda_hub_dev' }]),
    developmentCase: { findMany: vi.fn(async () => rows.cases) }, sampleBatch: { findMany: vi.fn(async () => rows.batches) },
    developmentSampleVersion: { findMany: vi.fn(async () => rows.versions) }, developmentSampleQualityReview: { findMany: vi.fn(async () => rows.reviews) },
    sampleCardItem: { findMany: vi.fn(async () => rows.cards) }, auditLog: { findMany: vi.fn(async () => rows.audits) } };
  const transaction = vi.fn(async (run: (value: Prisma.TransactionClient) => Promise<unknown>) => run(tx as unknown as Prisma.TransactionClient));
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  const input = { caseIds: [development.id], expectedBusinessTimeIso: clock.value.nowIso, wallStartedAtMs: wall - 1, wallEndedAtMs: wall + 1 };
  return { rows, tx, transaction, prisma, input, wall };
}

beforeEach(() => { clock.value = { mode: 'fixed', nowIso: '2026-10-08T00:18:00.000Z', timeZone: 'Asia/Shanghai', database: 'panda_hub_dev' }; });

describe('Private rehearsal development clock evidence, using exact new source IDs', () => {
  it.each(['2026-10-07T08:00:00.000Z', '2026-10-09T08:00:00.000Z'])('reads five actual fixed events and independent wall proofs with process time %s', async wallIso => {
    const f = fixture(wallIso), before = structuredClone(f.rows);
    const result = await readDevelopmentClockEvidence(f.prisma, f.input);
    expect(result).toMatchObject({ businessTime: clock.value.nowIso, database: 'panda_hub_dev', caseIds: ['new-case'],
      eventCounts: { returnedAt: 1, requestedAt: 1, startedAt: 1, reviewedAt: 1, acknowledgedAt: 1 }, legacyReceiptsObserved: 0 });
    expect(result.receiptProofs).toEqual([expect.objectContaining({ cardId: 'card', createAuditId: 'card-audit', receivedAt: String(fixed), recordedAt: String(f.wall), proofLayout: 'separate_clocks' })]);
    expect(result.events.every(row => row.occurredAt === String(fixed))).toBe(true);
    expect(result.audits.every(row => row.recordedAt === String(f.wall))).toBe(true);
    expect(f.rows).toEqual(before);
    expect(f.tx.developmentCase.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['new-case'] } } }));
    expect(f.tx.sampleCardItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { devCaseId: { in: ['new-case'] } } }));
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  });

  it('preserves progressive stops while requiring the five event kinds across the whole supplied rehearsal', async () => {
    const f = fixture();
    f.rows.cases.push({ ...f.rows.cases[0], id: 'draft-only', code: 'DEV-DRAFT' }); f.input.caseIds.push('draft-only');
    expect((await readDevelopmentClockEvidence(f.prisma, f.input)).caseIds).toEqual(['draft-only', 'new-case']);
    f.rows.reviews[0].acknowledgedAt = null;
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/acknowledgedAt/);
  });

  it('accepts stored JSONB key reordering while checking the producer fingerprint and exact content', async () => {
    const f = fixture();
    f.rows.reviews[0].sourceSnapshot = Object.fromEntries(Object.entries(f.rows.reviews[0].sourceSnapshot).reverse()) as typeof f.rows.reviews[0]['sourceSnapshot'];
    expect((await readDevelopmentClockEvidence(f.prisma, f.input)).eventCounts.reviewedAt).toBe(1);
  });

  it('checks a minor review against its own version and the unchanged original major physical receipt', async () => {
    const f = fixture(), minor = { ...f.rows.versions[0], id: 'version-minor', versionKind: 'minor', parentVersionId: 'version-major', versionLabel: 'R1-A.1' };
    f.rows.versions.push(minor); const review = f.rows.reviews[0]; review.sampleVersionId = minor.id;
    const source = buildDevelopmentQualitySourceSnapshot(f.rows.batches[0], f.rows.cases[0], f.rows.cards, { version: minor, physicalVersion: f.rows.versions[0] });
    review.sourceSnapshot = source; review.sourceFingerprint = hash(source);
    for (const audit of [f.rows.audits[2], f.rows.audits[4]]) audit.detail.after = { ...audit.detail.after as Record<string, unknown>, sampleVersionId: minor.id, sourceFingerprint: review.sourceFingerprint };
    f.rows.audits[3].detail.after = { item: { id: review.id, sampleVersionId: minor.id, startedBy: 'qc', startedAt: fixed, updatedAt: f.wall },
      receipt: { operation: 'claim', actorId: 'qc', toUserId: 'qc', reviewId: review.id, developmentCaseId: review.developmentCaseId, sampleBatchId: review.sampleBatchId,
        sampleVersionId: minor.id, sourceFingerprint: review.sourceFingerprint, occurredAt: String(fixed) } };
    const evidence = await readDevelopmentClockEvidence(f.prisma, f.input);
    expect(evidence.events.find(row => row.kind === 'reviewedAt')?.versionId).toBe(minor.id);
    expect(evidence.receiptProofs[0].versionId).toBe('version-major');
    minor.parentVersionId = 'foreign-major';
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/SOURCE/);
  });

  it('selects the actual last handoff by monotonic wall revision even when audit ordering ties', async () => {
    const f = fixture(); f.input.wallEndedAtMs += 10;
    const review = f.rows.reviews[0]; review.startedBy = 'second-qc'; review.reviewedBy = 'second-qc';
    f.rows.audits[4].actorId = 'second-qc';
    f.rows.audits[4].detail.after = { ...f.rows.audits[4].detail.after as Record<string, unknown>, reviewedBy: 'second-qc' };
    const transfer = { ...f.rows.audits[3], id: 'transfer-audit', actorId: 'qc', detail: { source: 'api:development-qc-handoff', after: {
      item: { id: review.id, sampleVersionId: review.sampleVersionId, startedBy: 'second-qc', startedAt: fixed, updatedAt: f.wall + 1 },
      receipt: { operation: 'transfer', actorId: 'qc', toUserId: 'second-qc', reviewId: review.id, developmentCaseId: review.developmentCaseId, sampleBatchId: review.sampleBatchId,
        sampleVersionId: review.sampleVersionId, sourceFingerprint: review.sourceFingerprint, occurredAt: String(fixed) } } } };
    f.rows.audits.unshift(transfer);
    expect((await readDevelopmentClockEvidence(f.prisma, f.input)).events.find(row => row.kind === 'startedAt')?.auditId).toBe(transfer.id);
  });

  it.each(['returnedAt', 'requestedAt', 'startedAt', 'reviewedAt', 'acknowledgedAt'] as const)('rejects real %s drifting with the process clock', async field => {
    const f = fixture();
    if (field === 'returnedAt') f.rows.batches[0].returnedAt = BigInt(f.wall);
    else f.rows.reviews[0][field] = BigInt(f.wall);
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/BUSINESS_EVENT_TIME/);
  });

  it.each(['foreign_case', 'missing_card_audit', 'duplicate_card_audit', 'changed_receipt', 'wrong_recordedAt', 'wrong_version', 'changed_qc_hash', 'changed_completion_audit'] as const)('fails closed for %s', async problem => {
    const f = fixture();
    if (problem === 'foreign_case') f.rows.cards[0].devCaseId = 'foreign-case';
    if (problem === 'missing_card_audit') f.rows.audits.splice(0, 1);
    if (problem === 'duplicate_card_audit') f.rows.audits.push({ ...f.rows.audits[0], id: 'second-create' });
    if (problem === 'changed_receipt') f.rows.cards[0].receiptSnapshot = { ...f.rows.cards[0].receiptSnapshot, actualQuantity: '11' };
    if (problem === 'wrong_recordedAt') f.rows.cards[0].receiptSnapshot = { ...f.rows.cards[0].receiptSnapshot, recordedAt: String(f.wall + 1) };
    if (problem === 'wrong_version') f.rows.reviews[0].sampleVersionId = 'absent-version';
    if (problem === 'changed_qc_hash') f.rows.reviews[0].sourceFingerprint = '0'.repeat(64);
    if (problem === 'changed_completion_audit') f.rows.audits[4].detail.after = { ...f.rows.audits[4].detail.after as Record<string, unknown>, reviewedAt: String(f.wall) };
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/DEVELOPMENT_CLOCK_EVIDENCE/);
  });

  it('does not turn an absent original recordedAt into a new rehearsal proof', async () => {
    const f = fixture();
    const { recordedAt: _recordedAt, ...oldReceipt } = f.rows.cards[0].receiptSnapshot;
    f.rows.cards[0].receiptSnapshot = oldReceipt as typeof f.rows.cards[0]['receiptSnapshot'];
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/NEW_RECEIPT_RECORDED_AT/);
  });

  it('rejects an existing historical case or a wall-clock audit outside the supplied run', async () => {
    const f = fixture(); f.rows.cases[0].createdAt = BigInt(f.wall - 60_000);
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/WALL_TIME/);
    f.rows.cases[0].createdAt = BigInt(f.wall); f.rows.audits[4].createdAt = new Date(f.wall - 60_000);
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/WALL_TIME/);
  });

  it.each([{ caseIds: [] }, { caseIds: ['new-case', 'new-case'] }, { caseIds: [' '] }])('rejects unbounded or ambiguous scope $caseIds before reads', async ({ caseIds }) => {
    const f = fixture();
    await expect(readDevelopmentClockEvidence(f.prisma, { ...f.input, caseIds })).rejects.toThrow(/INPUT/);
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('requires the actual guarded fixed clock and exact SQL database without broadening runner guards', async () => {
    const f = fixture(); clock.value.mode = 'wall';
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/CLOCK/);
    expect(f.transaction).not.toHaveBeenCalled();
    clock.value.mode = 'fixed'; f.tx.$queryRaw.mockResolvedValue([{ database: 'panda_hub_local' }]);
    await expect(readDevelopmentClockEvidence(f.prisma, f.input)).rejects.toThrow(/DATABASE/);
    expect(f.tx.developmentCase.findMany).not.toHaveBeenCalled();
  });
});
