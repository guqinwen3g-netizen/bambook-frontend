import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assertFabricAssetEligible, lockConfirmedFabricSources } from '../fabricAssetEligibility';
import { buildDevelopmentQualitySourceSnapshot, developmentVersionSnapshot } from '../developmentVersionGate';

const clock = vi.hoisted(() => ({ nowMs: Date.parse('2026-10-08T00:18:00.000Z') }));
vi.mock('../../shared/businessClock', () => ({ businessNowMs: () => clock.nowMs }));

/** Storage seam only. Actual pass/confirmation production is covered by the
 * guarded HTTP/PG acceptance; this mock never connects to a database. */
function fixture(family: 'fabric' | 'garment' = 'fabric', minor = false) {
  const major = { id: 'major', developmentCaseId: 'case', roundId: 'round', supplierRelationId: 'factory', versionLabel: 'R1-A',
    versionKind: 'major', minorVersion: 0, deletedAt: null };
  const version = minor ? { ...major, id: 'minor', versionLabel: 'R1-A.1', versionKind: 'minor', parentVersionId: major.id, minorVersion: 1,
    minorChangeNote: '准确书面调整' } : major;
  const development = { id: 'case', code: 'DEV', name: 'Case', type: family, customerRelationId: 'customer', initiator: 'customer', deletedAt: null };
  const batch = { id: 'batch', developmentCaseId: 'case', sampleVersionId: major.id, supplierRelationId: 'factory', round: 1,
    sampleType: family === 'fabric' ? 'yardage' : 'garment-round', batchCode: 'BATCH', returnedAt: 10n, returnedBy: 'sales',
    status: 'in_progress', deletedAt: null, convertedProductAssetId: minor ? 'parent-asset' : 'asset' };
  const cards = [{ id: 'card', batchId: 'batch', devCaseId: 'case', code: 'CARD', cardType: family, deletedAt: null }];
  const sourceSnapshot = buildDevelopmentQualitySourceSnapshot(batch, development, cards, { version, physicalVersion: major });
  const review: any = { id: 'qc', developmentCaseId: 'case', sampleBatchId: 'batch', sampleVersionId: version.id,
    reviewSequence: 1, status: 'reviewed', result: 'pass', reviewedBy: 'professional', reviewedAt: 20n,
    sourceSnapshot, sourceFingerprint: createHash('sha256').update(JSON.stringify(sourceSnapshot)).digest('hex') };
  const confirmSource = { case: { id: development.id, customerRelationId: development.customerRelationId, initiator: development.initiator },
    version: developmentVersionSnapshot(version), physicalVersion: developmentVersionSnapshot(major),
    sampleBatches: [{ id: batch.id, sampleVersionId: batch.sampleVersionId, returnedAt: String(batch.returnedAt) }],
    physicalItems: cards.map(({ id, code, batchId, cardType }) => ({ id, code, batchId, cardType })) };
  const confirmation: any = { id: 'confirmation', developmentCaseId: 'case', sampleVersionId: version.id,
    confirmerType: 'customer', confirmerName: 'Actual customer', confirmerRelationId: 'customer', confirmerUserId: null,
    confirmerOrganization: 'Customer', confirmedAt: 30n, result: 'approved', basis: 'Written selection of this exact version', evidence: [],
    recordedBy: 'sales', recordedAt: 40n, sourceSnapshot: confirmSource,
    sourceFingerprint: createHash('sha256').update(JSON.stringify(confirmSource)).digest('hex') };
  const asset = { id: 'asset', sku: 'SKU', name: 'Archive', mainCategory: family === 'fabric' ? 'Fabric' : 'Garment', deletedAt: null,
    sourceDevelopmentCaseId: 'case', sourceSampleBatchId: 'batch', sourceSampleVersionId: version.id,
    sourceSpecSnapshot: { sampleVersionId: version.id, qualityReviewId: review.id, physicalCardIds: ['card'] } };
  const conversion = { id: 'conversion', action: `convert_${family}_to_asset`, targetType: 'ProductAsset', targetId: asset.id, actorId: 'sales',
    detail: { source: `route:dev:${family}-convert-asset`, after: { fromCase: 'case', sourceType: family === 'fabric' ? 'batch' : 'node',
      sourceId: family === 'fabric' ? 'batch' : 'confirmation', sourceRoundId: family === 'garment' ? 'batch' : undefined,
      sourceSampleVersionId: version.id, qualityReviewId: review.id, physicalCardIds: ['card'] } } };
  const completion = { id: 'completion', action: 'complete_development_sample_qc', targetType: 'DevelopmentSampleQualityReview', targetId: review.id,
    actorId: review.reviewedBy, detail: { source: 'route:qc:development-sample', after: { reportId: review.id, result: review.result,
      reviewedAt: String(review.reviewedAt), sampleVersionId: version.id, sourceFingerprint: review.sourceFingerprint } } };
  const confirmationAudit = { id: 'confirmation-audit', action: 'record_development_version_confirmation', targetType: 'DevelopmentSampleVersion',
    targetId: version.id, actorId: confirmation.recordedBy, detail: { source: 'route:dev:version-confirmation',
      after: JSON.parse(JSON.stringify(confirmation, (_key, value) => typeof value === 'bigint' ? String(value) : value)) } };
  const state = { version, major, development, batch, cards, asset, reviews: [review], confirmations: [confirmation], audits: [conversion, completion, confirmationAudit] };
  const matches = (row: any, where: any) => Object.entries(where).every(([key, value]: any) => key === 'AND' ? value.every((entry: any) => entry.detail?.path?.reduce((item: any, field: string) => item?.[field], row.detail) === entry.detail.equals) : key === 'deletedAt' ? row.deletedAt == null
    : key === 'detail' ? row.detail?.source === value.equals : value?.in ? value.in.includes(row[key]) : row[key] === value);
  const db: any = {
    productAsset: { findUnique: vi.fn(async () => state.asset) },
    developmentCase: { findFirst: vi.fn(async () => state.development), findMany: vi.fn(async () => [state.development]) },
    developmentSampleVersion: { findFirst: vi.fn(async ({ where }: any) => [state.version, state.major].find(row => matches(row, where)) ?? null) },
    sampleBatch: { findFirst: vi.fn(async ({ where }: any) => matches(state.batch, where) ? state.batch : null), findMany: vi.fn(async () => [state.batch]) },
    sampleCardItem: { findMany: vi.fn(async () => state.cards) },
    developmentSampleQualityReview: { findFirst: vi.fn(async ({ where }: any) => state.reviews.filter(row => matches(row, where))
      .sort((a, b) => b.reviewSequence - a.reviewSequence)[0] ?? null) },
    developmentVersionConfirmation: { findFirst: vi.fn(async ({ where }: any) => state.confirmations.filter(row => matches(row, where))
      .sort((a, b) => Number(b.recordedAt - a.recordedAt))[0] ?? null) },
    auditLog: { findMany: vi.fn(async ({ where }: any) => state.audits.filter(row => matches(row, where))),
      findFirst: vi.fn(async ({ where }: any) => state.audits.find(row => matches(row, where)) ?? null) },
    sealSample: { findMany: vi.fn(async () => []) }, sealSampleBatch: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
  };
  return { db, state };
}

describe('exact development archive consumption by order and production', () => {
  it.each(['fabric', 'garment'] as const)('%s consumes native exact QC and requester approval without manufacturing a legacy batch approval', async family => {
    const f = fixture(family, true);
    await expect(assertFabricAssetEligible(f.db, 'asset')).resolves.toMatchObject({ source: { caseId: 'case', id: 'batch' },
      exactDevelopmentVersionProof: { sampleVersionId: 'minor', qualityReviewId: 'qc', confirmationId: 'confirmation' } });
    expect(f.state.batch.status).toBe('in_progress');
    expect(f.state.batch.convertedProductAssetId).toBe('parent-asset');
  });
  const recordConfirmationTimes = (f: ReturnType<typeof fixture>, confirmedAt: unknown, recordedAt: unknown) => {
    const confirmation = f.state.confirmations[0];
    confirmation.confirmedAt = confirmedAt; confirmation.recordedAt = recordedAt;
    const audit = f.state.audits.find(row => row.id === 'confirmation-audit')!;
    audit.detail.after = JSON.parse(JSON.stringify(confirmation, (_key, value) => typeof value === 'bigint' ? String(value) : value));
    return confirmation;
  };
  it.each([
    { wallPosition: 'behind', recordedAt: BigInt(Date.parse('2026-10-07T08:03:30.905Z')) },
    { wallPosition: 'ahead', recordedAt: BigInt(Date.parse('2026-10-09T08:03:30.905Z')) },
  ])('compares the actual confirmation to the business clock while preserving a $wallPosition recording wall clock', async ({ recordedAt }) => {
    const f = fixture(), confirmedAt = BigInt(clock.nowMs);
    const confirmation = recordConfirmationTimes(f, confirmedAt, recordedAt);
    await expect(assertFabricAssetEligible(f.db, 'asset')).resolves.toMatchObject({ exactDevelopmentVersionProof: {
      confirmedAt: String(confirmedAt), recordedAt: String(recordedAt), confirmationId: confirmation.id,
    } });
    expect(confirmation.confirmedAt).toBe(confirmedAt); expect(confirmation.recordedAt).toBe(recordedAt);
  });
  it('rejects an actual confirmation in the business future even if the recording wall clock is later', async () => {
    const f = fixture(); recordConfirmationTimes(f, BigInt(clock.nowMs + 1), BigInt(clock.nowMs + 86_400_000));
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_NOT_READY' });
  });
  it.each([
    { confirmedAt: 0n, recordedAt: 40n }, { confirmedAt: -1n, recordedAt: 40n },
    { confirmedAt: null, recordedAt: 40n }, { confirmedAt: 'invalid', recordedAt: 40n },
    { confirmedAt: 30n, recordedAt: 0n }, { confirmedAt: 30n, recordedAt: -1n },
    { confirmedAt: 30n, recordedAt: null }, { confirmedAt: 30n, recordedAt: 'invalid' },
  ])('keeps unknown or invalid confirmation/recording times ineligible: $confirmedAt / $recordedAt', async ({ confirmedAt, recordedAt }) => {
    const f = fixture(); recordConfirmationTimes(f, confirmedAt, recordedAt);
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_NOT_READY' });
  });
  it('an archived QC-passed design without requester selection is retained but cannot be consumed for an order', async () => {
    const f = fixture(); f.state.confirmations = [];
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_NOT_READY' });
    expect(f.state.asset.id).toBe('asset');
  });
  it('a major confirmation cannot satisfy a minor version', async () => {
    const f = fixture('fabric', true); f.state.confirmations[0].sampleVersionId = 'major';
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_NOT_READY' });
  });
  it.each(['rejected', 'needs_adjustment'])('latest actual requester %s denies new consumption and preserves history', async result => {
    const f = fixture(); f.state.confirmations.push({ ...f.state.confirmations[0], id: 'new-choice', result, recordedAt: 50n });
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'DEVELOPMENT_NOT_READY' });
    expect(f.state.confirmations).toHaveLength(2);
  });
  it('a later completed NOK blocks reuse of an older archived pass', async () => {
    const f = fixture(); f.state.reviews.push({ ...f.state.reviews[0], id: 'nok', reviewSequence: 2, result: 'reject' });
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: 'QC_PASS_REQUIRED' });
  });
  it('uncompleted re-review leaves the latest effective formal pass usable', async () => {
    const f = fixture(); f.state.reviews.push({ ...f.state.reviews[0], id: 'queued', reviewSequence: 2, status: 'queued', result: null });
    await expect(assertFabricAssetEligible(f.db, 'asset')).resolves.toHaveProperty('exactDevelopmentVersionProof.qualityReviewId', 'qc');
  });
  it.each(['wrong-requester', 'missing-audit', 'changed-source'])('rejects invalid confirmation evidence: %s', async change => {
    const f = fixture();
    if (change === 'wrong-requester') f.state.confirmations[0].confirmerType = 'internal';
    if (change === 'missing-audit') f.state.audits = f.state.audits.filter(row => row.id !== 'confirmation-audit');
    if (change === 'changed-source') f.state.version.minorChangeNote = 'Changed after approval';
    await expect(assertFabricAssetEligible(f.db, 'asset')).rejects.toMatchObject({ code: change === 'wrong-requester' ? 'DEVELOPMENT_NOT_READY' : 'DEVELOPMENT_SOURCE_CHANGED' });
  });
  it('source lock discovery follows the exact minor physical parent even without the legacy convertedAsset pointer', async () => {
    const f = fixture('fabric', true); await lockConfirmedFabricSources(f.db, [{ type: 'Asset', id: 'asset' }]);
    expect(f.db.$queryRaw.mock.calls.map(([sql]: any) => sql.sql.match(/FROM "(\w+)"/)[1])).toEqual(['DevelopmentCase', 'SampleBatch', 'ProductAsset']);
  });
});
